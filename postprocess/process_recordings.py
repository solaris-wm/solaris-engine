#!/usr/bin/env python3
"""Run camera alignment."""
from __future__ import annotations

import argparse
import functools
import json
import os
import shutil
import subprocess
import tempfile
import sys
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import cv2


# Unconsumed frames within this many seconds of the recording start/end are
# considered normal (the camera typically starts before and ends after the
# episode actions).
_BOUNDARY_GRACE_SEC = 10.0


@dataclass
class AlignmentInput:
    actions_path: Path
    camera_meta_path: Path
    output_video_path: Path
    output_metadata_path: Path
    # "auto" = reuse the encoder the camera recorded with (from its metadata)
    encoder: str = "auto"


def _load_actions(path: Path) -> List[Dict[str, Any]]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list) or not data:
        raise ValueError(f"Action file {path} is empty or invalid")
    return data


def _ensure_camera_meta(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        meta = json.load(fh)
    for key in ("start_epoch_seconds", "fps", "recording_path"):
        if key not in meta:
            raise ValueError(f"Camera metadata {path} missing '{key}'")
    return meta


# ---------------------------------------------------------------------------
# Per-frame timestamp extraction (wallclock mode)
# ---------------------------------------------------------------------------

def _extract_frame_timestamps(recording_path: Path) -> Optional[List[float]]:
    """Extract per-frame PTS (in seconds) from an MKV using ffprobe.

    Returns a **sorted** list of floats (one per video frame) or *None* if
    extraction fails.  When the MKV was recorded with
    ``-use_wallclock_as_timestamps 1 -copyts``, these values will be absolute
    Unix-epoch seconds (e.g. 1738540000.123).

    Sorting is necessary because ``ffprobe -show_entries packet=pts_time``
    returns timestamps in *decode* order, which differs from presentation
    order when B-frames are used.  Sorting restores presentation order so
    that index *i* in the returned list corresponds to frame *i* as decoded
    by ``cv2.VideoCapture``.
    """
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-select_streams", "v:0",
        "-show_entries", "packet=pts_time",
        "-of", "csv=p=0",
        str(recording_path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        print("[align] ffprobe not found; falling back to legacy alignment", file=sys.stderr)
        return None
    except subprocess.TimeoutExpired:
        print("[align] ffprobe timed out; falling back to legacy alignment", file=sys.stderr)
        return None

    if result.returncode != 0:
        print(f"[align] ffprobe failed (rc={result.returncode}); falling back to legacy alignment",
              file=sys.stderr)
        return None

    timestamps: List[float] = []
    for line in result.stdout.strip().splitlines():
        line = line.strip()
        if not line or line.lower() == "n/a":
            continue
        try:
            timestamps.append(float(line))
        except ValueError:
            continue

    if not timestamps:
        return None

    # Sort to convert from decode order to presentation order (handles
    # B-frame reordering).  New recordings use -bf 0 which makes this a
    # no-op, but older recordings may still have B-frames.
    timestamps.sort()

    return timestamps


def _has_wallclock_timestamps(
    frame_timestamps: List[float],
    camera_meta: Dict[str, Any],
) -> bool:
    """Heuristic: wallclock PTS values are large Unix-epoch numbers (> 1e9).

    Legacy recordings have PTS starting near zero.  We also cross-check against
    the ``wallclock_timestamps`` flag in the metadata if available.
    """
    if camera_meta.get("wallclock_timestamps"):
        return True
    # Heuristic: first PTS > 1 billion ≈ 2001-09-09 → definitely epoch time
    if frame_timestamps and frame_timestamps[0] > 1e9:
        return True
    return False


# ---------------------------------------------------------------------------
# Two-pointer action ↔ frame matching (wallclock mode)
# ---------------------------------------------------------------------------

def _match_actions_to_frames(
    actions: List[Dict[str, Any]],
    frame_timestamps: List[float],
    fps: float,
) -> Tuple[List[int], Dict[str, Any]]:
    """Match each action to the first video frame at or after the action time.

    Both ``action_times`` (from ``epochTime``) and ``frame_timestamps`` are
    non-decreasing sequences.  For each action we find the first frame whose
    timestamp is >= the action's effective time.

    Frames are **not** consumed: if a frame was dropped and two consecutive
    actions both land on the same frame, that frame is reused (duplicate).
    This avoids additive drift -- after the duplicate the sequences resync
    immediately.

    Returns ``(frame_indices, diagnostics)`` where *frame_indices* has one
    entry per matched action (the index into the recording to extract) and
    *diagnostics* is a dict with alignment quality stats.
    """
    n_actions = len(actions)
    n_frames = len(frame_timestamps)
    action_times = [float(a["epochTime"]) for a in actions]

    frame_indices: List[int] = []
    frame_ptr = 0

    # Track diagnostics
    time_deltas: List[float] = []      # frame_time - effective_action_time
    unmatched_actions_end = 0          # actions after last available frame

    for action_idx, action_time in enumerate(action_times):
        # Advance frame_ptr to the first frame at or after action_time.
        # frame_ptr never goes backwards, so this is O(n+m) overall.
        while frame_ptr < n_frames and frame_timestamps[frame_ptr] < action_time:
            frame_ptr += 1

        if frame_ptr >= n_frames:
            # No more frames -- remaining actions are unmatched at the end
            unmatched_actions_end = n_actions - action_idx
            break

        # Record the match.  Do NOT advance frame_ptr: the same frame may
        # be the correct match for the next action too (dropped-frame case).
        matched_frame = frame_ptr
        delta = frame_timestamps[matched_frame] - action_time
        time_deltas.append(delta)
        frame_indices.append(matched_frame)

    # --- Compute boundary statistics ---
    skipped_frames_start = 0
    skipped_frames_end = 0
    if frame_indices:
        skipped_frames_start = frame_indices[0]
        skipped_frames_end = max(0, n_frames - 1 - frame_indices[-1])

    # Count actions whose time falls before the first frame
    unmatched_actions_start = 0
    if frame_timestamps and action_times:
        for t in action_times:
            if t < frame_timestamps[0]:
                unmatched_actions_start += 1
            else:
                break

    # --- Check for duplicate frame usage (indicates dropped frames) ---
    frame_usage = Counter(frame_indices)
    duplicate_frames = {idx: cnt for idx, cnt in frame_usage.items() if cnt > 1}

    # --- Check for interior unconsumed frames ---
    # Frames within _BOUNDARY_GRACE_SEC of recording start/end are OK.
    # Any other unconsumed frame is flagged.
    consumed_set = set(frame_indices)
    rec_start = frame_timestamps[0] if frame_timestamps else 0.0
    rec_end = frame_timestamps[-1] if frame_timestamps else 0.0
    interior_unconsumed: List[int] = []
    for i in range(n_frames):
        if i in consumed_set:
            continue
        t = frame_timestamps[i]
        if (t - rec_start) <= _BOUNDARY_GRACE_SEC:
            continue  # within start grace period
        if (rec_end - t) <= _BOUNDARY_GRACE_SEC:
            continue  # within end grace period
        interior_unconsumed.append(i)

    # --- Check for dropped frames (large inter-frame gaps) ---
    # A gap significantly larger than 1/fps suggests x11grab missed a frame.
    expected_interval = 1.0 / fps
    gap_threshold = expected_interval * 1.8  # e.g. 90ms for 20fps (50ms expected)
    dropped_frame_gaps: List[Dict[str, Any]] = []
    for i in range(1, n_frames):
        gap = frame_timestamps[i] - frame_timestamps[i - 1]
        if gap > gap_threshold and (frame_timestamps[i - 1] - rec_start) > _BOUNDARY_GRACE_SEC:
            dropped_frame_gaps.append({
                "between_frames": [i - 1, i],
                "gap_sec": round(gap, 4),
                "expected_frames_missed": round(gap / expected_interval) - 1,
            })

    diagnostics = {
        "n_actions": n_actions,
        "n_frames": n_frames,
        "n_matched": len(frame_indices),
        "skipped_frames_start": skipped_frames_start,
        "skipped_frames_end": skipped_frames_end,
        "unmatched_actions_start": unmatched_actions_start,
        "unmatched_actions_end": unmatched_actions_end,
        "mean_delta_sec": (sum(time_deltas) / len(time_deltas)) if time_deltas else 0.0,
        "max_abs_delta_sec": max(abs(d) for d in time_deltas) if time_deltas else 0.0,
        "min_delta_sec": min(time_deltas) if time_deltas else 0.0,
        "max_delta_sec": max(time_deltas) if time_deltas else 0.0,
        "duplicate_frame_count": len(duplicate_frames),
        "interior_unconsumed_count": len(interior_unconsumed),
        "dropped_frame_gaps": len(dropped_frame_gaps),
    }

    return frame_indices, diagnostics




# ---------------------------------------------------------------------------
# Frame extraction (shared by both modes)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# ffmpeg resolution
# ---------------------------------------------------------------------------
#
# The host may have several ffmpeg builds (conda env, /usr/bin, ...) that
# differ in version and in which encoders they ship -- e.g. conda-forge's
# "lgpl" ffmpeg builds have no libx264. Resolve one binary deterministically,
# in this order, and verify the requested encoder actually works with it:
#   1. $SOLARIS_FFMPEG (explicit override)
#   2. ffmpeg next to the running Python interpreter (the pinned conda env)
#   3. ffmpeg on PATH

@functools.lru_cache(maxsize=None)
def resolve_ffmpeg() -> str:
    override = os.environ.get("SOLARIS_FFMPEG")
    if override:
        if not (os.path.isfile(override) and os.access(override, os.X_OK)):
            raise RuntimeError(f"SOLARIS_FFMPEG={override!r} is not an executable file")
        return override
    env_ffmpeg = Path(sys.executable).parent / "ffmpeg"
    if env_ffmpeg.is_file() and os.access(env_ffmpeg, os.X_OK):
        return str(env_ffmpeg)
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path
    raise RuntimeError(
        "ffmpeg not found: install it into the Python environment "
        "(conda env create -f env.yaml) or set SOLARIS_FFMPEG"
    )


@functools.lru_cache(maxsize=None)
def ffmpeg_version(ffmpeg: str) -> str:
    out = subprocess.run(
        [ffmpeg, "-hide_banner", "-version"], capture_output=True, text=True, check=False
    ).stdout
    first = out.splitlines()[0] if out else ""
    # "ffmpeg version 8.0.1 Copyright ..." -> "8.0.1"
    parts = first.split()
    return parts[2] if len(parts) > 2 and parts[1] == "version" else first or "unknown"


@functools.lru_cache(maxsize=None)
def check_encoder(ffmpeg: str, encoder: str) -> None:
    """Fail fast with a clear message if ``encoder`` can't encode with ``ffmpeg``.

    Being listed by ``ffmpeg -encoders`` isn't enough: h264_nvenc is listed on
    builds with NVENC support even when the GPU has no NVENC hardware (A100,
    H100), so do a tiny real test encode.
    """
    listed = subprocess.run(
        [ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True, check=False
    ).stdout
    if not any(line.split()[1:2] == [encoder] for line in listed.splitlines()):
        hint = ""
        if encoder == "libx264":
            hint = (" (conda-forge 'lgpl' ffmpeg builds omit libx264; "
                    "env.yaml pins a 'gpl' build)")
        raise RuntimeError(
            f"{ffmpeg} (ffmpeg {ffmpeg_version(ffmpeg)}) has no {encoder} encoder{hint}"
        )
    probe = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostats", "-loglevel", "error",
         "-f", "lavfi", "-i", "color=black:s=256x256:r=20",
         "-frames:v", "2", "-c:v", encoder, "-pix_fmt", "yuv420p", "-f", "null", "-"],
        capture_output=True, text=True, check=False,
    )
    if probe.returncode != 0:
        hint = (" (GPUs without NVENC hardware, e.g. A100/H100, can't use h264_nvenc; "
                "use --encoder libx264)") if encoder == "h264_nvenc" else ""
        raise RuntimeError(
            f"test encode with {encoder} failed using {ffmpeg} "
            f"(ffmpeg {ffmpeg_version(ffmpeg)}){hint}:\n{probe.stderr.strip()[-1000:]}"
        )


# Video quality is one knob, set at recording time (generate_compose.py
# --video_quality -> camera/entrypoint.sh) and stored in the camera metadata as
# "video_quality": libx264's CRF or h264_nvenc's CQ. This step re-encodes with
# the same encoder and quality, so dataset videos never claim more quality than
# the recording they were cut from. The same number gives matching quality on
# both encoders: calibrated against a lossless 720p capture, record+re-encode
# at libx264 CRF 18 and at NVENC CQ 18 both end at ~42.4 dB PSNR.
DEFAULT_QUALITY = 18  # recordings made before the knob existed
ENCODERS = ("libx264", "h264_nvenc")


def resolve_encoding(requested: str, camera_meta: Dict[str, Any]) -> Tuple[str, int]:
    """Pick (encoder, quality) for an episode.

    ``requested`` is "auto" (reuse the recording's encoder) or an explicit
    encoder. Quality always follows the recording. Recordings without the
    metadata (older runs) fall back to libx264 at DEFAULT_QUALITY, which
    works on any machine.
    """
    if requested == "auto":
        encoder = camera_meta.get("video_encoder") or "libx264"
        if encoder not in ENCODERS:
            raise RuntimeError(f"camera metadata has unknown video_encoder {encoder!r}")
    else:
        encoder = requested
    quality = int(camera_meta.get("video_quality", DEFAULT_QUALITY))
    return encoder, quality


def _quality_args(encoder: str, quality: int) -> List[str]:
    return ["-cq" if encoder == "h264_nvenc" else "-crf", str(quality)]


def _build_ffmpeg_cmd(
    width: int,
    height: int,
    fps: float,
    output_path: Path,
    encoder: str,
    quality: int,
) -> List[str]:
    """Build the ffmpeg command for the chosen encoder."""
    cmd = [
        resolve_ffmpeg(), "-y", "-nostats", "-loglevel", "error",
        "-f", "rawvideo",
        "-pix_fmt", "bgr24",
        "-s", f"{width}x{height}",
        "-r", str(fps),
        "-i", "pipe:0",
    ]

    if encoder == "h264_nvenc":
        cmd += [
            "-c:v", "h264_nvenc",
            "-preset", "p5",
            # Explicit constant-quality rate control: NVENC's defaults differ
            # across ffmpeg versions (some fall back to a ~2 Mbps target).
            "-rc", "vbr", "-b:v", "0", *_quality_args(encoder, quality),
        ]
    else:
        cmd += [
            "-c:v", "libx264",
            "-profile:v", "high",
            *_quality_args(encoder, quality),
            # "medium", not the camera's real-time "veryfast": this is a second
            # generation encode, and veryfast's coarser decisions compound the
            # recording's artifacts. On 720p Minecraft footage medium recovered
            # ~1.2 dB PSNR at the same size, at ~20x realtime per worker.
            "-preset", "medium",
        ]

    cmd += [
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(output_path),
    ]
    return cmd


def _write_frames_by_index(
    recording_path: Path,
    frame_indices: List[int],
    fps: float,
    output_path: Path,
    encoder: str,
    quality: int,
) -> None:
    """Extract selected frames and encode to H.264 via piped FFmpeg.

    Frames are decoded with OpenCV (which handles seeking / duplicate-index
    caching) and piped as raw BGR24 to an ``ffmpeg`` subprocess that encodes
    with libx264 or h264_nvenc.
    """
    start_time = time.time()

    if not frame_indices:
        raise ValueError("No frames requested for alignment")

    cap = cv2.VideoCapture(str(recording_path))
    if not cap.isOpened():
        raise RuntimeError(f"Failed to open camera recording {recording_path}")

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    output_path.parent.mkdir(parents=True, exist_ok=True)

    ffmpeg_cmd = _build_ffmpeg_cmd(width, height, fps, output_path, encoder, quality)
    # stderr goes to a temp file, not a pipe: a pipe is only drained after the
    # last frame, and a chatty ffmpeg could fill it and deadlock the encode.
    stderr_file = tempfile.TemporaryFile()
    ffmpeg_proc = subprocess.Popen(
        ffmpeg_cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=stderr_file,
    )
    assert ffmpeg_proc.stdin is not None

    last_frame_idx = -1
    last_frame = None
    seeks_count = 0
    reads_count = 0
    cache_hits = 0

    try:
        for i, frame_idx in enumerate(frame_indices):
            if frame_idx < 0 or frame_idx >= total_frames:
                raise RuntimeError(
                    f"Action {i} maps to frame {frame_idx}, but camera only has {total_frames} frames"
                )

            if frame_idx == last_frame_idx and last_frame is not None:
                ffmpeg_proc.stdin.write(last_frame.tobytes())
                cache_hits += 1
            else:
                if frame_idx != last_frame_idx + 1:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
                    seeks_count += 1

                ret, frame = cap.read()
                reads_count += 1

                if not ret:
                    raise RuntimeError(
                        f"Failed to read frame {frame_idx} from camera recording"
                    )

                ffmpeg_proc.stdin.write(frame.tobytes())
                last_frame_idx = frame_idx
                last_frame = frame.copy()
    finally:
        cap.release()
        try:
            ffmpeg_proc.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            pass
        ffmpeg_proc.stdin = None
        try:
            ffmpeg_proc.wait(timeout=120)
        except subprocess.TimeoutExpired:
            ffmpeg_proc.kill()
            ffmpeg_proc.wait()
        stderr_file.seek(0)
        stderr_bytes = stderr_file.read()
        stderr_file.close()

    if ffmpeg_proc.returncode != 0:
        stderr_text = stderr_bytes.decode("utf-8", errors="replace")[-2000:]
        raise RuntimeError(
            f"FFmpeg encoding failed (rc={ffmpeg_proc.returncode}):\n{stderr_text}"
        )

    total_time = time.time() - start_time
    video_duration = len(frame_indices) / fps
    print(f"[align] Extracted {len(frame_indices)} frames in {total_time:.1f}s "
          f"(seeks={seeks_count}, cache_hits={cache_hits})")
    print(f"[align:video_duration_sec] {video_duration:.2f}")


# ---------------------------------------------------------------------------
# Metadata / mapping builders
# ---------------------------------------------------------------------------

def _build_action_mapping_wallclock(
    actions: List[Dict[str, Any]],
    frame_indices: List[int],
    frame_timestamps: List[float],
) -> List[Dict[str, Any]]:
    """Build frame-to-action mapping for wallclock-timestamp alignment."""
    mapping: List[Dict[str, Any]] = []
    for action_idx, (entry, frame_idx) in enumerate(zip(actions, frame_indices)):
        action_time_sec = float(entry.get("epochTime", 0.0))
        frame_time_sec = frame_timestamps[frame_idx] if frame_idx < len(frame_timestamps) else 0.0
        mapping.append(
            {
                "action_index": action_idx,
                "renderTime_ms": float(entry.get("renderTime", 0.0)),
                "action_time_sec": action_time_sec,
                "relative_time_ms": float(entry.get("relativeTimeMs", 0.0)),
                "frame_index": frame_idx,
                "frame_time_sec": frame_time_sec,
                "delta_sec": frame_time_sec - action_time_sec,
            }
        )
    return mapping




# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def _print_wallclock_warnings(diagnostics: Dict[str, Any]) -> None:
    """Print compact warnings for alignment quality issues."""
    parts: List[str] = []
    gaps = diagnostics.get("dropped_frame_gaps", 0)
    if gaps:
        parts.append(f"{gaps} dropped-frame gap(s)")
    dup = diagnostics.get("duplicate_frame_count", 0)
    if dup:
        parts.append(f"{dup} duplicate frame(s)")
    interior = diagnostics.get("interior_unconsumed_count", 0)
    if interior:
        parts.append(f"{interior} interior unconsumed frame(s)")
    if parts:
        print(f"[align] WARNING: {'; '.join(parts)}", file=sys.stderr)


def align_recording(config: AlignmentInput) -> Dict[str, Any]:
    """Align camera recording to action trace.

    Uses per-frame wallclock timestamps extracted from the MKV via ffprobe.
    Falls back to legacy computed-index mode **only** if
    ``ALLOW_LEGACY_ALIGNMENT`` is ``True``.
    """
    actions = _load_actions(config.actions_path)
    camera_meta = _ensure_camera_meta(config.camera_meta_path)
    encoder, quality = resolve_encoding(config.encoder, camera_meta)
    try:
        check_encoder(resolve_ffmpeg(), encoder)
    except RuntimeError as exc:
        if not (config.encoder == "auto" and encoder == "h264_nvenc"):
            raise
        # auto: recorded with NVENC but it is unavailable here; the quality
        # setting gives matching quality on libx264.
        print(f"[align] WARNING: {exc}\n[align] falling back to libx264 at the same quality",
              file=sys.stderr)
        encoder = "libx264"
        check_encoder(resolve_ffmpeg(), encoder)

    fps = float(camera_meta["fps"])
    camera_start_time_sec = float(camera_meta["start_epoch_seconds"])

    recording_path = Path(camera_meta["recording_path"])
    if not recording_path.is_absolute():
        recording_path = config.camera_meta_path.parent / recording_path
    if not recording_path.exists():
        alt = config.camera_meta_path.parent / recording_path.name
        if alt.exists():
            recording_path = alt
        else:
            raise FileNotFoundError(
                f"Camera recording not found at {recording_path} or {alt}"
            )

    # ------------------------------------------------------------------
    # Extract per-frame timestamps and decide alignment mode
    # ------------------------------------------------------------------
    frame_timestamps = _extract_frame_timestamps(recording_path)
    use_wallclock = (
        frame_timestamps is not None
        and _has_wallclock_timestamps(frame_timestamps, camera_meta)
    )

    if not use_wallclock:
        reason = (
            "Frame timestamps not found or not wallclock"
            if frame_timestamps is None
            else "Frame timestamps present but not wallclock (PTS too small)"
        )
        raise RuntimeError(
            f"[align] {reason}. "
            f"Wallclock-timestamp alignment is required. "
        )


    # ------------------------------------------------------------------
    # Wallclock-timestamp alignment (primary path)
    # ------------------------------------------------------------------
    assert frame_timestamps is not None  # for type checker
    print(f"[align] Using wallclock timestamps ({len(frame_timestamps)} frames extracted)")

    frame_indices, diagnostics = _match_actions_to_frames(
        actions, frame_timestamps, fps,
    )

    if not frame_indices:
        raise RuntimeError("No actions could be matched to video frames")

    # Trim actions to only those that were matched
    matched_actions = actions[: len(frame_indices)]

    _write_frames_by_index(recording_path, frame_indices, fps, config.output_video_path,
                           encoder, quality)

    action_times_sec = [float(a["epochTime"]) for a in matched_actions]
    mapping = _build_action_mapping_wallclock(
        matched_actions, frame_indices, frame_timestamps,
    )

    output_metadata = {
        "actions_path": str(config.actions_path),
        "camera_meta_path": str(config.camera_meta_path),
        "recording_path": str(recording_path),
        "aligned_video_path": str(config.output_video_path),
        "alignment_mode": "wallclock",
        "encoder": encoder,
        "quality": quality,
        "encoder_args": _quality_args(encoder, quality),
        "camera_encoder": camera_meta.get("video_encoder"),
        "ffmpeg_path": resolve_ffmpeg(),
        "ffmpeg_version": ffmpeg_version(resolve_ffmpeg()),
        "opencv_version": cv2.__version__,
        "fps": fps,
        "camera_start_time_sec": camera_start_time_sec,
        "first_frame_time_sec": frame_timestamps[0] if frame_timestamps else None,
        "last_frame_time_sec": frame_timestamps[-1] if frame_timestamps else None,
        "total_video_frames": len(frame_timestamps),
        "first_action_time_sec": min(action_times_sec) if action_times_sec else None,
        "last_action_time_sec": max(action_times_sec) if action_times_sec else None,
        "diagnostics": diagnostics,
        "frame_mapping": mapping,
    }

    config.output_metadata_path.parent.mkdir(parents=True, exist_ok=True)
    with config.output_metadata_path.open("w", encoding="utf-8") as fh:
        json.dump(output_metadata, fh)

    # Print diagnostics summary
    d = diagnostics
    print(f"[align] Matched {d['n_matched']}/{d['n_actions']} actions to "
          f"{d['n_frames']} video frames")
    print(f"[align] Mean delta: {d['mean_delta_sec']*1000:.1f}ms, "
          f"max |delta|: {d['max_abs_delta_sec']*1000:.1f}ms")
    if d['skipped_frames_start'] > 0 or d['skipped_frames_end'] > 0:
        print(f"[align] Skipped frames: {d['skipped_frames_start']} at start, "
              f"{d['skipped_frames_end']} at end")
    if d['unmatched_actions_start'] > 0 or d['unmatched_actions_end'] > 0:
        print(f"[align] Unmatched actions: {d['unmatched_actions_start']} at start, "
              f"{d['unmatched_actions_end']} at end")

    # Warnings for data-quality issues
    _print_wallclock_warnings(diagnostics)

    return output_metadata

@dataclass
class BotConfig:
    name: str
    actions_suffix: str
    camera_meta: Path
    output_dir: Path


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    argv = list(argv)
    # --check-encoder is a standalone mode that needs none of the episode inputs.
    need_inputs = "--check-encoder" not in argv
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--actions-dir",
        type=Path,
        required=need_inputs,
        help="Directory containing Mineflayer action traces (*.json)",
    )
    parser.add_argument(
        "--camera-prefix",
        type=Path,
        required=need_inputs,
        help="Directory containing camera outputs (expects output_alpha/ and output_bravo/)",
    )
    parser.add_argument(
        "--bot",
        type=str,
        choices=["Alpha", "Bravo"],
        required=need_inputs,
        help="Which bot to process",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Optional base directory for outputs (default: ./aligned/<bot>)",
    )
    parser.add_argument(
        "--episode-file",
        type=Path,
        default=None,
        help="Process single episode file (overrides directory processing)",
    )
    parser.add_argument(
        "--encoder",
        type=str,
        default="auto",
        choices=["auto", *ENCODERS],
        help="Video encoder: auto reuses the encoder the camera recorded with "
        "(from its metadata; libx264 for older recordings), or force libx264 (CPU) "
        "/ h264_nvenc (NVIDIA GPU). Quality always follows the recording. (default: auto)",
    )
    parser.add_argument(
        "--check-encoder",
        action="store_true",
        help="Only verify that ffmpeg can encode with --encoder (not auto), print the ffmpeg in use, and exit",
    )
    return parser.parse_args(argv)


def build_bot_config(
    actions_dir: Path, camera_prefix: Path, bot: str, output_base: Optional[Path]
) -> Dict[str, BotConfig]:
    """Return BotConfig mapping for the selected bot.

    - Output directory defaults to ./aligned/<bot> unless overridden by --output-dir.
    - camera_prefix may already be an output_{alpha|bravo}/<instance> directory
      (as in orchestration); handle both prefixed and non-prefixed forms.
    """
    output_dir = (output_base or Path.cwd() / "aligned")
    if bot == "Alpha":
        # If camera_prefix already points into output_alpha, use it directly
        if "output_alpha" in str(camera_prefix):
            camera_meta = camera_prefix / "camera_alpha_meta.json"
        else:
            camera_meta = camera_prefix / "output_alpha" / "camera_alpha_meta.json"
        return {
            "Alpha": BotConfig(
                name="Alpha",
                actions_suffix="_Alpha_",
                camera_meta=camera_meta,
                output_dir=output_dir,
            )
        }
    else:
        # If camera_prefix already points into output_bravo, use it directly
        if "output_bravo" in str(camera_prefix):
            camera_meta = camera_prefix / "camera_bravo_meta.json"
        else:
            camera_meta = camera_prefix / "output_bravo" / "camera_bravo_meta.json"
        return {
            "Bravo": BotConfig(
                name="Bravo",
                actions_suffix="_Bravo_",
                camera_meta=camera_meta,
                output_dir=output_dir,
            )
        }


def bot_for_actions(path: Path, configs: Dict[str, BotConfig]) -> Optional[BotConfig]:
    for config in configs.values():
        if config.actions_suffix in path.name:
            return config
    return None


def resolve_actions_dir(explicit: Path) -> Path:
    actions_dir = explicit
    if not actions_dir.exists():
        raise FileNotFoundError(f"Actions directory not found: {actions_dir}")
    return actions_dir


def ensure_metadata(meta_path: Path) -> None:
    if not meta_path.exists():
        raise FileNotFoundError(f"Camera metadata missing: {meta_path}")



def process_actions(
    actions_dir: Path,
    configs: Dict[str, BotConfig],
    encoder: str = "auto",
) -> int:
    actions_processed = 0
    for actions_path in sorted(actions_dir.glob("*.json")):
        if actions_path.name.endswith("_meta.json"):
            continue
        config = bot_for_actions(actions_path, configs)
        if config is None:
            continue

        ensure_metadata(config.camera_meta)
        config.output_dir.mkdir(parents=True, exist_ok=True)

        output_video = config.output_dir / f"{actions_path.stem}_camera.mp4"
        output_meta = config.output_dir / f"{actions_path.stem}_camera_meta.json"

        alignment_input = AlignmentInput(
            actions_path=actions_path,
            camera_meta_path=config.camera_meta,
            output_video_path=output_video,
            output_metadata_path=output_meta,
            encoder=encoder,
        )

        align_start = time.time()
        try:
            metadata = align_recording(alignment_input)
        except Exception as exc:  # noqa: BLE001 - surface alignment failure to caller
            print(f"[align] failed for {actions_path}: {exc}", file=sys.stderr)
            continue
        align_time = time.time() - align_start


        with output_meta.open("w", encoding="utf-8") as fh:
            json.dump(metadata, fh)

        print(
            f"[align] wrote {metadata['aligned_video_path']} (total: {align_time:.1f}s)"
        )
        actions_processed += 1

    return actions_processed


def process_single_episode(
    episode_path: Path,
    configs: Dict[str, BotConfig],
    encoder: str = "auto",
) -> bool:
    """Process a single episode file. Returns True if successful."""
    if episode_path.name.endswith("_meta.json"):
        return False

    config = bot_for_actions(episode_path, configs)
    if config is None:
        return False

    try:
        ensure_metadata(config.camera_meta)
        config.output_dir.mkdir(parents=True, exist_ok=True)

        output_video = config.output_dir / f"{episode_path.stem}_camera.mp4"
        output_meta = config.output_dir / f"{episode_path.stem}_camera_meta.json"

        alignment_input = AlignmentInput(
            actions_path=episode_path,
            camera_meta_path=config.camera_meta,
            output_video_path=output_video,
            output_metadata_path=output_meta,
            encoder=encoder,
        )

        align_start = time.time()
        metadata = align_recording(alignment_input)
        align_time = time.time() - align_start

        

        with output_meta.open("w", encoding="utf-8") as fh:
            json.dump(metadata, fh)

        print(f"[align] wrote {metadata['aligned_video_path']} (total: {align_time:.1f}s)")
        return True
        
    except Exception as exc:
        print(f"[align] failed for {episode_path}: {exc}", file=sys.stderr)
        return False


def main(argv: Iterable[str]) -> int:
    args = parse_args(argv)
    if args.check_encoder:
        try:
            ffmpeg = resolve_ffmpeg()
            check_encoder(ffmpeg, args.encoder)
        except RuntimeError as exc:
            print(f"[align] {exc}", file=sys.stderr)
            return 1
        print(f"[align] encoder {args.encoder} OK with {ffmpeg} "
              f"(ffmpeg {ffmpeg_version(ffmpeg)}, opencv {cv2.__version__})")
        return 0
    actions_dir = resolve_actions_dir(args.actions_dir.resolve())
    configs = build_bot_config(
        actions_dir=actions_dir,
        camera_prefix=args.camera_prefix.resolve(),
        bot=args.bot,
        output_base=args.output_dir.resolve() if args.output_dir else None,
    )

    encoder = args.encoder
    if encoder != "auto":  # with auto, each episode checks what its recording needs
        try:
            check_encoder(resolve_ffmpeg(), encoder)
        except RuntimeError as exc:
            print(f"[align] {exc}", file=sys.stderr)
            return 1

    # Single-episode fast path if provided by orchestrator
    if args.episode_file:
        episode_path = args.episode_file.resolve()
        if not episode_path.exists():
            print(f"[align] episode file not found: {episode_path}", file=sys.stderr)
            return 1
        processed = process_single_episode(
            episode_path, configs, encoder=encoder
        )
        return 0 if processed else 1

    # Otherwise process all episodes under --actions-dir
    processed = process_actions(
        actions_dir, configs, encoder=encoder
    )
    if processed == 0:
        print("[align] no action traces found; nothing to do")
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    raise SystemExit(main(sys.argv[1:]))
