#!/usr/bin/env python3
"""Read and write the voxel capture stream.

The controller bot records, once per capture, an agent-centered cube of block
state ids around itself.  Each capture is one fixed-size record:

    epoch_ms  : int64        capture wall-clock time (ms since the Unix epoch)
    origin    : int32[3]     world (x, y, z) of cube cell (0, 0, 0)
    cells     : uint16[g**3] block state id per cell, x outermost / z innermost

Records are concatenated and gzip-compressed on disk; a JSON sidecar carries the
grid size and Minecraft version.  All integers are little-endian, matching both
Node ``Buffer`` ``*LE`` writes and numpy ``<`` dtypes, so the JavaScript writer
and this reader share one byte layout.  Cells are Minecraft block-state ids as
decoded by PrismarineJS (mineflayer's ``prismarine-chunk``); downstream consumers
-- the postprocess renderers and the model's voxel-vocabulary mapping -- resolve
them to block names via ``minecraft-data`` (also a PrismarineJS project), keyed
by ``mc_version``.
"""
from __future__ import annotations

import gzip
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence, Tuple

import numpy as np


@dataclass
class VoxelRecord:
    """One capture: the epoch, the cube's world origin, and the cube itself."""

    epoch_ms: int
    origin: Tuple[int, int, int]
    grid: np.ndarray  # (g, g, g) uint16, indexed [x, y, z]


@dataclass
class VoxelStream:
    """A decoded stream: per-capture arrays plus the sidecar metadata."""

    epochs: np.ndarray   # (N,) int64
    origins: np.ndarray  # (N, 3) int32
    grids: np.ndarray    # (N, g, g, g) uint16
    grid_size: int
    mc_version: Optional[str] = None


def _record_dtype(grid_size: int) -> np.dtype:
    """numpy layout of one capture: epoch, cube origin, and the cube — all little-endian."""
    return np.dtype(
        [
            ("epoch_ms", "<i8"),
            ("origin", "<i4", (3,)),
            ("cells", "<u2", (grid_size, grid_size, grid_size)),
        ]
    )


def meta_path_for(stream_path: Path) -> Path:
    """Map a stream path to its sidecar, e.g. ``X_voxels.bin.gz`` -> ``X_voxels_meta.json``."""
    name = stream_path.name
    for suffix in (".bin.gz", ".gz", ".bin"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break
    return stream_path.with_name(f"{name}_meta.json")


def encode_records(records: Sequence[VoxelRecord], grid_size: int) -> bytes:
    """Serialize records into the uncompressed on-the-wire byte layout."""
    expected = (grid_size, grid_size, grid_size)
    arr = np.empty(len(records), dtype=_record_dtype(grid_size))
    for i, rec in enumerate(records):
        grid = np.asarray(rec.grid, dtype=np.uint16)
        if grid.shape != expected:
            raise ValueError(f"grid shape {grid.shape} != {expected}")
        arr[i] = (int(rec.epoch_ms), rec.origin, grid)
    return arr.tobytes()


def decode_records(
    raw: bytes, grid_size: int
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Parse uncompressed bytes into ``(epochs, origins, grids)`` arrays."""
    dt = _record_dtype(grid_size)
    if len(raw) % dt.itemsize != 0:
        raise ValueError(
            f"stream length {len(raw)} is not a multiple of record size {dt.itemsize}"
        )
    records = np.frombuffer(raw, dtype=dt)
    epochs = records["epoch_ms"].astype(np.int64)
    origins = records["origin"].astype(np.int32)
    grids = records["cells"].astype(np.uint16)
    return epochs, origins, grids


def write_stream(
    stream_path: Path,
    records: Sequence[VoxelRecord],
    grid_size: int,
    mc_version: str,
) -> None:
    """Gzip the encoded records to ``stream_path`` and write the JSON sidecar."""
    raw = encode_records(records, grid_size)
    with gzip.open(stream_path, "wb") as fh:
        fh.write(raw)
    meta = {"grid_size": grid_size, "mc_version": mc_version}
    with meta_path_for(stream_path).open("w", encoding="utf-8") as fh:
        json.dump(meta, fh)


def read_stream(stream_path: Path) -> VoxelStream:
    """Read the gzip stream and its sidecar into a :class:`VoxelStream`."""
    with meta_path_for(stream_path).open("r", encoding="utf-8") as fh:
        meta = json.load(fh)
    grid_size = int(meta["grid_size"])
    with gzip.open(stream_path, "rb") as fh:
        raw = fh.read()
    epochs, origins, grids = decode_records(raw, grid_size)
    return VoxelStream(epochs, origins, grids, grid_size, meta.get("mc_version"))
