#!/usr/bin/env python3
"""GPU voxel renderer -- agent-POV, isometric cube, or both.

Renders the agent-centred voxel grid on the GPU (pytorch3d) one of three ways,
selected with ``--mode``:

  pov : a perspective camera placed *inside* the world at the recorded
      position, orientation and field of view -- what that camera would see.
      Side-by-side with the real camera video it is an alignment check: if the
      rendered voxels track the footage as the agent turns and walks, the voxel,
      camera-state and video streams are mutually aligned.
  cube : an orthographic camera at a fixed isometric angle -- a third-person
      "god-view" of the cube, with the recorded camera's viewpoint drawn as a
      frustum so it is clear where the agent is looking.
  both : both of the above, written as two separate side-by-side files
      (``--out`` is suffixed ``_pov`` / ``_cube``).

Both renderers share the same coloured-cube mesh, rasteriser, flat shader and
edge outlining; only the camera (and a couple of per-mode extras) differ.  The
colour, geometry and video-IO helpers live here too; pytorch3d/torch are
imported lazily (only the renderers need them), so this module imports and runs
on machines without them.

    python render_voxels.py --mode pov --npz EP_voxels.npz \
        --video EP_camera.mp4 --camera-state EP_camera_state.json --out EP_fp.mp4
    python render_voxels.py --mode both --npz EP_voxels.npz \
        --video EP_camera.mp4 --camera-state EP_camera_state.json --out EP_both.mp4
"""
import argparse
import json
import subprocess
import types
import zlib
from pathlib import Path

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# Colour table
# ---------------------------------------------------------------------------
# A few recognizable blocks get fixed BGR colors; air-likes are skipped.  Any
# other block is colored deterministically from its name/state id so distinct
# block types stay visually distinct even without a name table.
_KNOWN_BGR = {
    "air": None,
    "cave_air": None,
    "void_air": None,
    "diamond_block": (242, 230, 102),
    "grass_block": (69, 158, 87),
    "dirt": (56, 89, 125),
    "stone": (128, 128, 128),
    "water": (217, 110, 51),
    "sand": (140, 204, 217),
    "oak_log": (46, 84, 115),
    "oak_leaves": (46, 115, 51),
    "bedrock": (45, 45, 45),
}

# ---------------------------------------------------------------------------
# Camera-frustum overlay (cube mode)
# ---------------------------------------------------------------------------
_FRUSTUM_BGR = (40, 40, 240)     # BGR red
_FRUSTUM_FAR = 6.0               # frustum depth in blocks (modest; the cube is 48)

# ---------------------------------------------------------------------------
# First-person eye height (Minecraft offsets above the recorded feet)
# ---------------------------------------------------------------------------
# Standing is the default; sneak/swim are applied per-frame in the annotate
# pipeline via eye_height_for_action().
DEFAULT_EYE_HEIGHT = 1.62
SNEAK_EYE_HEIGHT = 1.27
SWIM_EYE_HEIGHT = 0.4  # swimming / crawling / gliding pose

# ---------------------------------------------------------------------------
# First-person field of view
# ---------------------------------------------------------------------------
# pytorch3d FoVPerspectiveCameras `fov` (degrees). The recording camera flies
# and only mirrors the controller's pose: its FoV is the constant flying value
# and never picks up the player's sprint widening. Overridable with --fov.
DEFAULT_FOV = 77.0  # 70 (MC base FoV) x 1.1 (flying-camera multiplier)

# First-person background for "no voxel here" pixels (RGB, [0,1]): sky blue so
# empty regions read as sky and the panel resembles the camera view.
_SKY_RGB = (0.53, 0.81, 0.92)

# ---------------------------------------------------------------------------
# Isometric viewpoint and framing (cube mode)
# ---------------------------------------------------------------------------
_ISO_ELEV = 35.0    # camera elevation, degrees (~true isometric)
_ISO_AZIM = 45.0    # camera azimuth around the cube, degrees
_FIT = 0.85         # ortho half-height as a fraction of the grid edge (larger = zoomed out)
_BG_RGB = (0.094, 0.094, 0.094)  # dark grey background

# Unit-cube corners and a triangulation (2 triangles per face). Faces are listed
# in quad pairs, so ``triangle_index // 2`` recovers the quad face -- used to draw
# block edges from the rasterizer's pix_to_face buffer.
_CUBE_CORNERS = np.array(
    [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
     [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    dtype=np.float32,
)
_CUBE_FACES = np.array(
    [[0, 2, 1], [0, 3, 2],   # -z
     [4, 5, 6], [4, 6, 7],   # +z
     [0, 1, 5], [0, 5, 4],   # -y
     [3, 7, 6], [3, 6, 2],   # +y
     [0, 4, 7], [0, 7, 3],   # -x
     [1, 2, 6], [1, 6, 5]],  # +x
    dtype=np.int64,
)

# Dark line drawn at visible block-face boundaries (BGR).
_EDGE_BGR = (28, 28, 28)


# ---------------------------------------------------------------------------
# State-name table + colour
# ---------------------------------------------------------------------------
def _load_names(path):
    if not path:
        return {}
    with open(path, "r", encoding="utf-8") as fh:
        return {int(k): v for k, v in json.load(fh).items()}


def _find_state_names(start):
    """Look for ``state_names.json`` beside ``start`` (a file or dir) or above it.

    Searches the starting directory and a few parent levels so a dataset-root
    table is found from a nested episode path.  Returns None if not found.
    """
    base = start if start.is_dir() else start.parent
    for d in [base, *base.parents][:7]:
        cand = d / "state_names.json"
        if cand.exists():
            return cand
    return None


def _base_color(state_id, names):
    name = names.get(state_id)
    if name in _KNOWN_BGR:
        return _KNOWN_BGR[name]  # None for air-likes -> caller skips
    # Hash on the block *name* (when a name table is given) so every state of a
    # type shares one colour; hashing state ids would colour each orientation
    # variant of a block differently.  Fall back to the id with no name table.
    h = zlib.crc32(name.encode("utf-8")) & 0xFFFFFF if name else (int(state_id) * 2654435761) & 0xFFFFFF
    # Bias away from very dark so blocks stay visible.
    return (80 + (h & 127), 80 + ((h >> 8) & 127), 80 + ((h >> 16) & 127))


# ---------------------------------------------------------------------------
# Geometry: surface culling, rot6d basis, frustum
# ---------------------------------------------------------------------------
def _surface_indices(grid):
    """Indices of solid cells exposed to air (cuts clutter and draw cost)."""
    g = grid.shape[0]
    solid = grid != 0
    air = np.ones((g + 2, g + 2, g + 2), dtype=bool)
    air[1:-1, 1:-1, 1:-1] = grid == 0
    exposed = solid & (
        air[0:-2, 1:-1, 1:-1]
        | air[2:, 1:-1, 1:-1]
        | air[1:-1, 0:-2, 1:-1]
        | air[1:-1, 2:, 1:-1]
        | air[1:-1, 1:-1, 0:-2]
        | air[1:-1, 1:-1, 2:]
    )
    return np.argwhere(exposed)  # rows of (i, j, k); j is world-Y (height)


def _basis_from_rot6d(rot6d):
    """Recover the camera basis (right, up, forward) from a stored 6D rotation.

    ``rotation_6d`` is ``[right(3), up(3)]`` of an orthonormal basis (see
    ``process_recordings.yaw_pitch_to_rot6d``).  The rotation matrix's third
    column is ``right x up`` = the camera's *backward* axis, so the view
    direction is ``forward = up x right``.  Axes are MC world (+X east, +Y up,
    +Z south), which map 1:1 to the grid index axes (i, j, k).
    """
    r = np.asarray(rot6d, dtype=np.float32)
    right, up = r[0:3], r[3:6]
    forward = np.cross(up, right)
    return right, up, forward


def _frustum_corners(state, origin, eye_height, far):
    """Camera apex and four far-plane corners in grid-index coords (i, j, k).

    ``position`` is feet; the eye sits ``eye_height`` above it.  Grid coords are
    world minus the cube ``origin`` (world axes map 1:1 to grid indices).  The
    far corners open by the field of view -- half-angle ``fov/2`` applied equally
    to the right and up axes (aspect 1) -- at distance ``far`` along the view.
    """
    pos = np.asarray(state["position"], dtype=np.float64)
    right, up, forward = _basis_from_rot6d(state["rotation_6d"])
    eye = pos + np.array([0.0, eye_height, 0.0]) - np.asarray(origin, dtype=np.float64)
    tan_h = np.tan(np.radians(float(state["fov"]) / 2.0))
    corners = [
        eye + far * (forward + sx * tan_h * right + sy * tan_h * up)
        for sx in (-1.0, 1.0)
        for sy in (-1.0, 1.0)
    ]
    return eye, corners


# ---------------------------------------------------------------------------
# Video IO
# ---------------------------------------------------------------------------
def _start_ffmpeg(out_path, width, height, fps):
    """Pipe raw BGR frames to ffmpeg, encoding H.264/yuv420p (broadly playable)."""
    cmd = [
        "ffmpeg", "-y", "-nostats", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-s", f"{width}x{height}", "-r", str(fps),
        "-i", "pipe:0",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-crf", "20", "-preset", "veryfast", "-movflags", "+faststart",
        str(out_path),
    ]
    return subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
    )


def _read_video(path):
    cap = cv2.VideoCapture(str(path))
    frames = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(frame)
    cap.release()
    return frames


# ---------------------------------------------------------------------------
# Camera placement (agent POV) + per-frame stance/FoV
# ---------------------------------------------------------------------------
def _eye_at_up(state, origin, eye_height):
    """Camera ``(eye, at, up)`` in the cube's local frame (world - origin).

    Working in local coords keeps the magnitudes small (the agent sits near the
    cube centre) and is identical to world coords up to a shared translation of
    both the mesh and the camera.
    """
    pos = np.asarray(state["position"], dtype=np.float32)
    right, up, forward = _basis_from_rot6d(state["rotation_6d"])
    eye = pos + np.array([0.0, eye_height, 0.0], dtype=np.float32) - np.asarray(origin, dtype=np.float32)
    at = eye + forward
    return eye, at, up


def eye_height_for_action(action):
    """Camera eye-height above the recorded feet, by Minecraft stance:
    standing 1.62, sneaking 1.27, swimming/crawling/gliding 0.4.

    Sneak comes from the nested action keymap (``action['action']['sneak']``);
    the swim/crawl pose is proxied by the top-level ``isInWater`` flag (imperfect
    -- it also fires when merely standing in shallow water, but these bots almost
    never swim).
    """
    if action.get("isInWater"):
        return SWIM_EYE_HEIGHT
    if (action.get("action") or {}).get("sneak"):
        return SNEAK_EYE_HEIGHT
    return DEFAULT_EYE_HEIGHT


# ---------------------------------------------------------------------------
# Voxels -> colored cube mesh
# ---------------------------------------------------------------------------
def _cube_mesh_arrays(grid, names):
    """Build a colored cube mesh (numpy) for the surface voxels of one grid.

    Returns ``(verts, faces, colors)`` with verts in the cube's local frame
    ``(i, j, k)``; colors are RGB in ``[0, 1]``.  Interior voxels and air-like
    blocks (``_base_color`` returns ``None``) are dropped.  Pure numpy so it is
    testable without pytorch3d.
    """
    empty = (np.zeros((0, 3), np.float32), np.zeros((0, 3), np.int64), np.zeros((0, 3), np.float32))
    cells = _surface_indices(grid)
    if len(cells) == 0:
        return empty

    ids = grid[cells[:, 0], cells[:, 1], cells[:, 2]]
    color_by_id = {}
    for sid in np.unique(ids):
        bgr = _base_color(int(sid), names)
        color_by_id[int(sid)] = None if bgr is None else np.asarray(bgr[::-1], np.float32) / 255.0
    keep = np.array([color_by_id[int(s)] is not None for s in ids], dtype=bool)
    cells, ids = cells[keep], ids[keep]
    if len(cells) == 0:
        return empty

    rgb = np.stack([color_by_id[int(s)] for s in ids])  # (V, 3)
    n = len(cells)
    verts = (cells[:, None, :].astype(np.float32) + _CUBE_CORNERS[None, :, :]).reshape(n * 8, 3)
    faces = (_CUBE_FACES[None, :, :] + (np.arange(n) * 8)[:, None, None]).reshape(n * 12, 3)
    colors = np.repeat(rgb, 8, axis=0)  # (V*8, 3)
    return verts, faces, colors


def _torch3d():
    """Lazy import of torch + pytorch3d bundled into a namespace."""
    import torch
    from pytorch3d.renderer import (
        BlendParams,
        FoVOrthographicCameras,
        FoVPerspectiveCameras,
        HardFlatShader,
        MeshRasterizer,
        PointLights,
        RasterizationSettings,
        TexturesVertex,
        look_at_view_transform,
    )
    from pytorch3d.structures import Meshes

    return types.SimpleNamespace(
        torch=torch,
        Meshes=Meshes,
        BlendParams=BlendParams,
        FoVOrthographicCameras=FoVOrthographicCameras,
        FoVPerspectiveCameras=FoVPerspectiveCameras,
        RasterizationSettings=RasterizationSettings,
        MeshRasterizer=MeshRasterizer,
        HardFlatShader=HardFlatShader,
        PointLights=PointLights,
        TexturesVertex=TexturesVertex,
        look_at_view_transform=look_at_view_transform,
    )


class _GpuVoxelRenderer:
    """Shared GPU machinery for the voxel renderers.

    Holds the rasteriser, an overhead light and a flat shader, and provides the
    common ``mesh -> rasterise -> shade -> edge-outline`` core.  Subclasses build
    the camera (perspective POV vs orthographic isometric) and call
    ``_render_mesh``.
    """

    def __init__(self, image_size, names, background_rgb):
        self.t = _torch3d()
        self.device = "cuda" if self.t.torch.cuda.is_available() else "cpu"
        self.height, self.width = int(image_size[0]), int(image_size[1])
        self.names = names

        # Rasterizer and shader kept separate so _render_mesh can read the
        # rasterizer's pix_to_face buffer to outline block faces.
        self.rasterizer = self.t.MeshRasterizer(
            raster_settings=self.t.RasterizationSettings(
                image_size=(self.height, self.width),
                blur_radius=0.0,
                faces_per_pixel=1,
                cull_backfaces=False,
            )
        )
        # Light from straight above: top faces bright, sides/bottom ambient-only.
        self.lights = self.t.PointLights(
            device=self.device,
            location=[[0.0, 1000.0, 0.0]],
            ambient_color=((0.75, 0.75, 0.75),),
            diffuse_color=((0.45, 0.45, 0.45),),
            specular_color=((0.0, 0.0, 0.0),),
        )
        self.shader = self.t.HardFlatShader(
            device=self.device,
            lights=self.lights,
            blend_params=self.t.BlendParams(background_color=background_rgb),
        )

    def _meshes(self, verts, faces, colors):
        torch = self.t.torch
        return self.t.Meshes(
            verts=[torch.tensor(verts, dtype=torch.float32, device=self.device)],
            faces=[torch.tensor(faces, dtype=torch.int64, device=self.device)],
            textures=self.t.TexturesVertex(
                verts_features=[torch.tensor(colors, dtype=torch.float32, device=self.device)]
            ),
        )

    def _render_mesh(self, meshes, cameras):
        """Rasterise + shade the mesh through ``cameras`` to a BGR image, with
        visible block faces outlined."""
        fragments = self.rasterizer(meshes, cameras=cameras)
        images = self.shader(fragments, meshes, cameras=cameras, lights=self.lights)
        rgb = images[0, ..., :3].clamp(0.0, 1.0).detach().cpu().numpy()
        bgr = np.ascontiguousarray(rgb[:, :, ::-1] * 255.0).astype(np.uint8)

        # Outline visible block faces: a dark line where the front quad face
        # (triangle // 2) changes between neighbouring pixels -- including the
        # silhouette, where a face (>= 0) meets the background (pix_to_face -1).
        quad = fragments.pix_to_face[0, :, :, 0].cpu().numpy() // 2
        edge = np.zeros(quad.shape, dtype=bool)
        edge[:, :-1] |= quad[:, :-1] != quad[:, 1:]
        edge[:-1, :] |= quad[:-1, :] != quad[1:, :]
        bgr[edge] = _EDGE_BGR

        return bgr


class PovRenderer(_GpuVoxelRenderer):
    """Perspective camera placed inside the world at the recorded camera pose."""

    def __init__(self, image_size, names, eye_height=DEFAULT_EYE_HEIGHT, fov=None):
        super().__init__(image_size, names, background_rgb=_SKY_RGB)
        self.eye_height = eye_height
        self.fov_override = fov  # None -> per-frame value (DEFAULT_FOV / passed fov)

    def render(self, grid, origin, state, eye_height=None, fov=None):
        verts, faces, colors = _cube_mesh_arrays(grid, self.names)
        if len(verts) == 0:
            return np.zeros((self.height, self.width, 3), np.uint8)

        torch = self.t.torch
        meshes = self._meshes(verts, faces, colors)

        eye, at, up = _eye_at_up(state, origin, self.eye_height if eye_height is None else eye_height)
        R, T = self.t.look_at_view_transform(
            eye=torch.as_tensor(eye, dtype=torch.float32)[None],
            at=torch.as_tensor(at, dtype=torch.float32)[None],
            up=torch.as_tensor(up, dtype=torch.float32)[None],
            device=self.device,
        )
        # aspect_ratio stays 1.0 so the non-square image carries the aspect and
        # blocks render square.
        if fov is None:
            fov = self.fov_override if self.fov_override is not None else DEFAULT_FOV
        cameras = self.t.FoVPerspectiveCameras(
            R=R,
            T=T,
            fov=fov,
            aspect_ratio=1.0,
            znear=0.05,
            zfar=float(2 * grid.shape[0]),
            degrees=True,
            device=self.device,
        )
        return self._render_mesh(meshes, cameras)


class IsometricRenderer(_GpuVoxelRenderer):
    """Orthographic camera at a fixed isometric angle (third-person god-view)."""

    def __init__(self, image_size, names):
        super().__init__(image_size, names, background_rgb=_BG_RGB)
        self._cam_cache = {}

    def _camera(self, g):
        """Orthographic iso camera fitted to a ``g``-edge cube (cached per size)."""
        if g in self._cam_cache:
            return self._cam_cache[g]
        R, T = self.t.look_at_view_transform(
            dist=4.0 * g, elev=_ISO_ELEV, azim=_ISO_AZIM,
            at=[[g / 2.0, g / 2.0, g / 2.0]], device=self.device,
        )
        s = _FIT * g
        ax = s * (self.width / self.height)  # widen x for the non-square image so blocks stay square
        cam = self.t.FoVOrthographicCameras(
            R=R, T=T, znear=0.1, zfar=8.0 * g,
            min_x=-ax, max_x=ax, min_y=-s, max_y=s, device=self.device,
        )
        self._cam_cache[g] = cam
        return cam

    def render(self, grid, origin=None, state=None):
        g = grid.shape[0]
        verts, faces, colors = _cube_mesh_arrays(grid, self.names)
        if len(verts) == 0:
            img = np.full((self.height, self.width, 3), int(_BG_RGB[0] * 255), np.uint8)
        else:
            img = self._render_mesh(self._meshes(verts, faces, colors), self._camera(g))

        if state is not None and origin is not None:
            self._draw_frustum(img, state, origin, g)
        return img

    def _draw_frustum(self, img, state, origin, g):
        """Project the camera frustum through the iso camera and draw it (cv2)."""
        eye, corners = _frustum_corners(state, origin, DEFAULT_EYE_HEIGHT, _FRUSTUM_FAR)
        pts = np.array([eye, *corners], dtype=np.float32)  # (5, 3) grid coords
        torch = self.t.torch
        scr = self._camera(g).transform_points_screen(
            torch.as_tensor(pts, dtype=torch.float32, device=self.device)[None],
            image_size=((self.height, self.width),),
        )[0, :, :2].detach().cpu().numpy()
        p = scr.astype(np.int32)
        apex, far = tuple(p[0]), p[1:]
        for c in far:
            cv2.line(img, apex, tuple(c), _FRUSTUM_BGR, 2, cv2.LINE_AA)
        cv2.polylines(img, [np.array([far[0], far[1], far[3], far[2]], np.int32)],
                      True, _FRUSTUM_BGR, 2, cv2.LINE_AA)
        cv2.circle(img, apex, 4, _FRUSTUM_BGR, -1, cv2.LINE_AA)


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--mode", choices=["pov", "cube", "both"], default="pov",
                        help="agent-POV perspective, isometric cube god-view, or both panels")
    parser.add_argument("--npz", required=True, type=Path, help="Aligned *_voxels.npz")
    parser.add_argument("--video", required=True, type=Path, help="Aligned camera .mp4")
    parser.add_argument("--out", required=True, type=Path, help="Output side-by-side .mp4")
    parser.add_argument("--camera-state", type=Path, default=None,
                        help="Aligned *_camera_state.json (required for pov/both; "
                             "draws the frustum in cube mode)")
    parser.add_argument("--state-names", type=Path, default=None, help="JSON {stateId: name}")
    parser.add_argument("--max-frames", type=int, default=100000)
    parser.add_argument("--fps", type=float, default=20.0)
    parser.add_argument("--eye-height", type=float, default=DEFAULT_EYE_HEIGHT,
                        help="(pov) camera height above the recorded feet, in blocks.")
    parser.add_argument("--fov", type=float, default=None,
                        help="(pov) override FoV in degrees; default per DEFAULT_FOV.")
    args = parser.parse_args()

    wants_pov = args.mode in ("pov", "both")
    wants_cube = args.mode in ("cube", "both")

    data = np.load(args.npz)
    grids, origins = data["grids"], data["origins"]
    state_names_path = args.state_names or _find_state_names(args.npz)
    if state_names_path and not args.state_names:
        print(f"[render-voxels] auto-discovered state names: {state_names_path}")
    names = _load_names(state_names_path)

    if wants_pov and not args.camera_state:
        raise SystemExit(f"--camera-state is required for --mode {args.mode}")
    camera_states = None
    if args.camera_state:
        with open(args.camera_state, "r", encoding="utf-8") as fh:
            camera_states = json.load(fh)

    frames = _read_video(args.video)
    count = min(grids.shape[0], origins.shape[0], len(frames))
    if camera_states is not None:
        count = min(count, len(camera_states))
    if count == 0:
        raise SystemExit(f"No frames to render (grids={grids.shape[0]}, video={len(frames)})")
    indices = np.unique(np.linspace(0, count - 1, min(args.max_frames, count)).astype(int))

    height, width = frames[0].shape[0], frames[0].shape[1]
    # One side-by-side video per requested view (camera | view). --mode both
    # writes both as separate files, suffixing --out (not a merged panel).
    split = args.mode == "both"

    def out_for(suffix):
        return args.out.with_name(f"{args.out.stem}_{suffix}{args.out.suffix}") if split else args.out

    jobs = []  # (renderer, out_path)
    if wants_pov:
        jobs.append((PovRenderer((height, width), names, eye_height=args.eye_height, fov=args.fov),
                     out_for("pov")))
    if wants_cube:
        jobs.append((IsometricRenderer((height, height), names),  # square god-view panel
                     out_for("cube")))

    procs = [None] * len(jobs)
    for t in indices:
        state = camera_states[t] if camera_states is not None else None
        for i, (renderer, out_path) in enumerate(jobs):
            combo = cv2.hconcat([frames[t], renderer.render(grids[t], origins[t], state)])
            # H.264/yuv420p needs even dimensions.
            combo = combo[: combo.shape[0] // 2 * 2, : combo.shape[1] // 2 * 2]
            cv2.putText(
                combo, f"t={t}", (8, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                (255, 255, 255), 2, cv2.LINE_AA,
            )
            if procs[i] is None:
                procs[i] = _start_ffmpeg(out_path, combo.shape[1], combo.shape[0], args.fps)
            procs[i].stdin.write(combo.tobytes())

    for (_, out_path), proc in zip(jobs, procs):
        if proc is None:
            continue
        proc.stdin.close()
        err = proc.stderr.read()  # py3.10: communicate() after stdin.close() flushes a closed file
        proc.wait()
        if proc.returncode != 0:
            raise SystemExit("ffmpeg failed:\n" + err.decode("utf-8", "replace")[-1500:])
        print(f"[render-voxels] wrote {out_path} ({len(indices)} frames sampled from {count})")


if __name__ == "__main__":
    main()
