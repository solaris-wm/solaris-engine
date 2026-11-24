"""Shared H.264 video encoding: one ffmpeg, one quality knob, one writer.

Used by every place SolarisEngine writes video from Python frames:
postprocess/process_recordings.py (dataset videos), postprocess/
annotate_video_batch.py (annotated previews) and controller/act_recorder/
act_recorder.py (controller debug video). The camera records with ffmpeg
directly (camera/entrypoint.sh) using the same quality knob.

Video quality is one number, set at recording time (generate_compose.py
--video_quality -> camera/entrypoint.sh) and stored in the camera metadata as
"video_quality": libx264's CRF or h264_nvenc's CQ. The same number gives
matching quality on both encoders: calibrated against a lossless 720p capture,
record + re-encode at quality 18-21 ends within 0.3 dB PSNR on both (at the
default 20: libx264 40.9 dB, NVENC 41.1 dB); NVENC needs ~15% more bits for it.

The default, 20, sits between x264's "visually lossless" CRF 18 and its default
CRF 23. Against the old pipeline (NVENC at ffmpeg's ~2 Mbps default, or x264
CRF 23, then OpenCV mp4v), it raises dataset-video PSNR by 3.3-5.3 dB while
lowering total storage (raw + dataset) on both NVENC and CPU machines.
"""
from __future__ import annotations

import functools
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import List, Optional

import numpy as np

DEFAULT_QUALITY = 20
ENCODERS = ("libx264", "h264_nvenc")


# ---------------------------------------------------------------------------
# ffmpeg resolution
# ---------------------------------------------------------------------------
#
# A machine may have several ffmpeg builds (conda env, /usr/bin, ...) that
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


# ---------------------------------------------------------------------------
# Encoder settings
# ---------------------------------------------------------------------------

def quality_args(encoder: str, quality: int) -> List[str]:
    return ["-cq" if encoder == "h264_nvenc" else "-crf", str(quality)]


def encoder_args(encoder: str, quality: int) -> List[str]:
    """ffmpeg output args for an offline (non-real-time) H.264 encode."""
    if encoder == "h264_nvenc":
        # Explicit constant-quality rate control: NVENC's defaults differ
        # across ffmpeg versions (some fall back to a ~2 Mbps target).
        return ["-c:v", "h264_nvenc", "-preset", "p5",
                "-rc", "vbr", "-b:v", "0", *quality_args(encoder, quality)]
    if encoder == "libx264":
        # "medium", not the camera's real-time "veryfast": these encodes are
        # usually a second generation, and veryfast's coarser decisions
        # compound the recording's artifacts. On 720p Minecraft footage medium
        # recovered ~1.2 dB PSNR at the same size, at ~20x realtime per worker.
        return ["-c:v", "libx264", "-profile:v", "high", "-preset", "medium",
                *quality_args(encoder, quality)]
    raise ValueError(f"unknown encoder {encoder!r}; expected one of {ENCODERS}")


# ---------------------------------------------------------------------------
# Writer
# ---------------------------------------------------------------------------

class H264Writer:
    """Encode BGR frames (as from OpenCV) to an H.264 MP4 through ffmpeg.

    Drop-in replacement for cv2.VideoWriter. Frame size is fixed by the first
    frame unless given; later frames of another size are resized. Odd
    dimensions are padded to even, which yuv420p requires.

        with H264Writer(path, fps=20) as w:
            for frame in frames:
                w.write(frame)
    """

    def __init__(
        self,
        output_path,
        fps: float,
        encoder: str = "libx264",
        quality: int = DEFAULT_QUALITY,
        size: Optional[tuple] = None,  # (width, height)
        ffmpeg: Optional[str] = None,
    ):
        self.output_path = Path(output_path)
        self.fps = fps
        self.encoder = encoder
        self.quality = quality
        self.size = size
        self.ffmpeg = ffmpeg or resolve_ffmpeg()
        self.frames_written = 0
        self._proc: Optional[subprocess.Popen] = None
        self._stderr = None
        encoder_args(encoder, quality)  # validate early

    def _start(self, width: int, height: int) -> None:
        self.size = (width, height)
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            self.ffmpeg, "-y", "-nostats", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-s", f"{width}x{height}", "-r", str(self.fps), "-i", "pipe:0",
            *encoder_args(self.encoder, self.quality),
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(self.output_path),
        ]
        # stderr goes to a temp file, not a pipe: a pipe is only drained at
        # the end, and a chatty ffmpeg could fill it and deadlock the encode.
        self._stderr = tempfile.TemporaryFile()
        self._proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=self._stderr
        )

    def write(self, frame: np.ndarray) -> None:
        if frame.ndim == 2 or (frame.ndim == 3 and frame.shape[2] in (1, 4)):
            import cv2  # grayscale / BGRA (e.g. decoded PNG) -> BGR
            code = cv2.COLOR_BGRA2BGR if frame.ndim == 3 and frame.shape[2] == 4 else cv2.COLOR_GRAY2BGR
            frame = cv2.cvtColor(frame, code)
        if frame.ndim != 3 or frame.shape[2] != 3:
            raise ValueError(f"expected an HxWx3 BGR frame, got shape {frame.shape}")
        h, w = frame.shape[:2]
        if self._proc is None:
            self._start(*(self.size or (w, h)))
        if (w, h) != self.size:
            import cv2  # only needed for mismatched frames
            frame = cv2.resize(frame, self.size)
        try:
            self._proc.stdin.write(np.ascontiguousarray(frame, dtype=np.uint8).tobytes())
        except (BrokenPipeError, OSError):
            self.close()  # raises with ffmpeg's own error message
            raise
        self.frames_written += 1

    def close(self, timeout: float = 120) -> None:
        """Finish the file. Raises RuntimeError with ffmpeg's stderr on failure."""
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            proc.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            pass
        proc.stdin = None
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        self._stderr.seek(0)
        err = self._stderr.read().decode("utf-8", errors="replace")[-2000:]
        self._stderr.close()
        if proc.returncode != 0:
            raise RuntimeError(
                f"ffmpeg {self.encoder} encode of {self.output_path} failed "
                f"(rc={proc.returncode}):\n{err}"
            )

    def __enter__(self) -> "H264Writer":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc_type is None:
            self.close()
        else:
            try:
                self.close()
            except RuntimeError:
                pass  # keep the original exception
