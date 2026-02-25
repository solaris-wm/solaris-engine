#!/usr/bin/env python3
import argparse
import json
import re
import shutil
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Set

import cv2

EPISODE_RE = re.compile(r"\d{8}_\d{6}_(?P<episode>\d{6})(?:_|\.|$)")
TIMESTAMP_PREFIX_RE = re.compile(r"^\d{8}_\d{6}_")
INSTANCE_RE = re.compile(r"instance_(?P<instance>\d{3})(?:_|\.|$)")


@dataclass(frozen=True)
class EpisodeKey:
    episode_id: str  # zero-padded 6-digit
    instance_id: str  # zero-padded 3-digit


def parse_episode_and_instance(filename: str) -> Optional[EpisodeKey]:
    ep_match = EPISODE_RE.search(filename)
    inst_match = INSTANCE_RE.search(filename)
    if not ep_match or not inst_match:
        return None
    return EpisodeKey(
        episode_id=ep_match.group("episode"), instance_id=inst_match.group("instance")
    )


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def parse_instance_ids_arg(values: List[str]) -> Set[str]:
    result: Set[str] = set()
    for v in values:
        for part in v.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                num = int(part)
                result.add(f"{num:03d}")
            except ValueError:
                if re.fullmatch(r"\d{3}", part):
                    result.add(part)
                else:
                    raise ValueError(
                        f"Invalid instance id '{part}'. Use 3-digit like 007 or integer like 7."
                    )
    return result


def strip_timestamp_prefix(name: str) -> str:
    """Remove leading YYYYMMDD_HHMMSS_ from a filename if present."""
    return TIMESTAMP_PREFIX_RE.sub("", name, count=1)


def verify_video_paths(paths: List[Path], bot1_name: str, bot2_name: str) -> bool:
    """Return True if the two video paths correspond to different bots.

    The rule is: if one path contains bot1_name, the other must contain bot2_name,
    and vice versa. Assumes exactly two paths are provided.
    """
    if len(paths) != 2:
        print(f"Video paths not equal to 2: {paths}", file=sys.stderr)
        return False
    a = str(paths[0])
    b = str(paths[1])
    result = (bot1_name in a and bot2_name in b) or (bot2_name in a and bot1_name in b)
    if not result:
        print(
            f"Video paths not corresponding to different bots: {a} and {b}: {paths}",
            file=sys.stderr,
        )
    return result


def verify_json_paths(paths: List[Path], bot1_name: str, bot2_name: str) -> bool:
    """Return True if JSON paths contain two files per bot with correct suffix pairing.

    For each of bot1_name and bot2_name, there must be exactly two JSON files:
    - one ending with "_episode_info.json"
    - one not ending with "_episode_info.json"
    """
    if len(paths) != 4:
        print(f"JSON paths not equal to 4: {paths}", file=sys.stderr)
        return False
    episode_info_suffix = "_episode_info.json"

    def check_for_bot(bot_name: str) -> bool:
        bot_files = [p for p in paths if bot_name in str(p)]
        if len(bot_files) != 2:
            print(f"Bot {bot_name} files not equal to 2: {bot_files}", file=sys.stderr)
            return False
        endswith_info = sum(str(p).endswith(episode_info_suffix) for p in bot_files)
        return endswith_info == 1

    return check_for_bot(bot1_name) and check_for_bot(bot2_name)


def get_video_frame_count(video_path: Path) -> Optional[int]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise ValueError(f"Failed to open video {video_path}")
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    return frame_count


def get_json_top_level_count(json_path: Path) -> Optional[int]:
    with open(json_path, "r") as f:
        data = json.load(f)
    if isinstance(data, list):
        return len(data)
    raise ValueError(f"JSON {json_path} is not a list")


def verify_contents_per_bot(
    video_paths: List[Path],
    json_paths_no_info: List[Path],
    bot1_name: str,
    bot2_name: str,
) -> bool:
    bots = [bot1_name, bot2_name]
    for bot in bots:
        video_path = next((p for p in video_paths if bot in str(p)), None)
        json_path = next((p for p in json_paths_no_info if bot in str(p)), None)
        if video_path is None or json_path is None:
            return False
        try:
            frame_count = get_video_frame_count(video_path)
            item_count = get_json_top_level_count(json_path)
            if frame_count is None or item_count is None:
                return False
            if frame_count != item_count:
                print(
                    f"Video frame count {frame_count} does not match JSON item count {item_count} for bot {bot}: {video_path} and {json_path}",
                    file=sys.stderr,
                )
                return False
        except Exception as e:
            print(
                f"Error verifying contents for bot {bot}: {video_path} and {json_path}: {e}",
                file=sys.stderr,
            )
            return False
    return True


def process_source_dir(
    source_dir: Path,
    args: argparse.Namespace,
    instance_ids: Optional[Set[str]],
    destination_root: Path,
    subdir_prefix: Optional[str],
    strict_missing: bool,
) -> None:
    """Process a single source directory that should contain 'aligned' and 'output'."""
    aligned_dir = source_dir / "aligned"
    source_output_dir = source_dir / "output"

    if not aligned_dir.is_dir() or not source_output_dir.is_dir():
        msg = f"aligned and/or output directory not found under {source_dir}"
        if strict_missing:
            print(msg, file=sys.stderr)
            sys.exit(1)
        else:
            print(
                f"Skipping directory without aligned/output: {source_dir}",
                file=sys.stderr,
            )
            return

    # Determine combined prefix: CLI prefix + subdirectory name (if any)
    combined_prefix_parts = []
    if args.file_prefix:
        combined_prefix_parts.append(args.file_prefix)
    if subdir_prefix:
        combined_prefix_parts.append(subdir_prefix)
    combined_prefix = "_".join(combined_prefix_parts) if combined_prefix_parts else ""

    # Collect aligned videos ending with _camera.mp4, keyed by (episode, instance)
    videos_by_key: Dict[EpisodeKey, List[Path]] = defaultdict(list)
    for entry in aligned_dir.iterdir():
        if not entry.is_file():
            continue
        name = entry.name
        if not name.endswith("_camera.mp4"):
            continue
        key = parse_episode_and_instance(name)
        if key is None:
            continue
        if instance_ids is not None and key.instance_id not in instance_ids:
            continue
        videos_by_key[key].append(entry)

    if not videos_by_key:
        print(
            f"No matching videos found in {aligned_dir} for the specified instance ids.",
            file=sys.stderr,
        )
        if strict_missing:
            sys.exit(1)
        return

    # Collect output JSONs (all *.json), keyed by (episode, instance)
    jsons_by_key: Dict[EpisodeKey, List[Path]] = defaultdict(list)
    for entry in source_output_dir.iterdir():
        if not entry.is_file():
            continue
        if not entry.name.endswith(".json"):
            continue
        if entry.name.endswith("_meta.json"):
            continue
        key = parse_episode_and_instance(entry.name)
        if key is None:
            continue
        if instance_ids is None or key.instance_id in instance_ids:
            jsons_by_key[key].append(entry)

    # Build a list of valid keys that have exactly 2 videos, 4 JSONs,
    # and the two videos belong to different bots based on provided names.
    # Additionally, verify contents: per-bot video frame count must equal
    # the number of top-level items in the corresponding JSON.
    valid_keys: List[EpisodeKey] = []
    invalid_keys_because_paths = []
    invalid_keys_because_contents = []
    for key in sorted(
        videos_by_key.keys(), key=lambda k: (k.instance_id, k.episode_id)
    ):
        video_paths = videos_by_key.get(key, [])
        json_paths = jsons_by_key.get(key, [])
        if not verify_video_paths(
            video_paths, args.bot1_name, args.bot2_name
        ) or not verify_json_paths(json_paths, args.bot1_name, args.bot2_name):
            invalid_keys_because_paths.append(key)
            continue
        json_paths_no_info = [
            p for p in json_paths if not p.name.endswith("_episode_info.json")
        ]
        if not verify_contents_per_bot(
            video_paths,
            json_paths_no_info,
            args.bot1_name,
            args.bot2_name,
        ):
            invalid_keys_because_contents.append(key)
            continue
        valid_keys.append(key)

    print(
        f"[{source_dir}] valid episodes: {len(valid_keys)} out of {len(videos_by_key)}"
    )

    # Print number of valid keys per instance
    valid_per_instance: Dict[str, int] = defaultdict(int)
    for key in valid_keys:
        valid_per_instance[key.instance_id] += 1
    for inst in sorted(valid_per_instance.keys()):
        print(f"[{source_dir}] Instance {inst}: valid keys={valid_per_instance[inst]}")

    # Determine episodes per instance among valid keys only
    episodes_per_instance: Dict[str, List[str]] = defaultdict(list)
    for key in valid_keys:
        episodes_per_instance[key.instance_id].append(key.episode_id)

    # Deduplicate and sort
    for inst, eps in episodes_per_instance.items():
        episodes_per_instance[inst] = sorted(set(eps))

    # Prepare destination directory for the final dataset (shared for videos and JSONs)
    ensure_dir(destination_root)

    # Copy videos
    copied_videos = 0
    for key in sorted(valid_keys, key=lambda k: (k.instance_id, k.episode_id)):
        paths = videos_by_key[key]
        for src in paths:
            # Drop the trailing "_camera" before the .mp4 extension in the destination filename
            base_name = strip_timestamp_prefix(src.name)
            if base_name.endswith("_camera.mp4"):
                dst_name = base_name[: -len("_camera.mp4")] + ".mp4"
            else:
                dst_name = base_name
            if combined_prefix:
                dst_name = combined_prefix + "_" + dst_name
            dst = destination_root / dst_name
            if dst.exists():
                continue
            shutil.copy2(src, dst)
            copied_videos += 1

    # Copy JSONs
    copied_jsons = 0
    missing_json_keys = []
    for key in sorted(valid_keys, key=lambda k: (k.instance_id, k.episode_id)):
        json_list = jsons_by_key[key]
        if not json_list:
            missing_json_keys.append(key)
            continue
        for src in json_list:
            dst_name = strip_timestamp_prefix(src.name)
            if combined_prefix:
                dst_name = combined_prefix + "_" + dst_name
            dst = destination_root / dst_name
            if dst.exists():
                continue
            shutil.copy2(str(src), str(dst))
            copied_jsons += 1

    # Report
    print(f"[{source_dir}] Completed writing to {destination_root}.")
    for inst in sorted(episodes_per_instance.keys()):
        total = len(episodes_per_instance[inst])
        print(f"[{source_dir}] Instance {inst}: total episodes={total}")
    print(f"[{source_dir}] Videos copied -> total: {copied_videos}")
    print(f"[{source_dir}] JSONs copied   -> total: {copied_jsons}")

    if missing_json_keys:
        print(
            f"\n[{source_dir}] Warning: Missing JSON files for the following (episode_id, instance_id) keys:",
            file=sys.stderr,
        )
        for key in missing_json_keys[:50]:
            print(
                f"  episode={key.episode_id} instance={key.instance_id}",
                file=sys.stderr,
            )
        if len(missing_json_keys) > 50:
            print(f"  ... and {len(missing_json_keys) - 50} more", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Prepare a single directory with all valid episodes."
    )
    parser.add_argument(
        "--source-dir",
        required=True,
        type=str,
        help=(
            "Source directory. Script looks for 'aligned' and 'output' either directly "
            "under it or one level deeper in its subdirectories."
        ),
    )
    parser.add_argument(
        "--instance-ids",
        "-i",
        nargs="+",
        help="Instance ids to include (space or comma separated). Accepts '7 8' or '007,008'. If omitted, all instances found are used.",
    )
    parser.add_argument(
        "--file-prefix",
        type=str,
        default="",
        help="Optional prefix to prepend to destination filenames.",
    )
    parser.add_argument(
        "--destination-dir",
        required=True,
        type=str,
        default=None,
        help="Optional directory in which to create the final dataset.",
    )
    parser.add_argument(
        "--bot1-name",
        type=str,
        default="Alpha",
        help="First bot name to validate in video paths (default: Alpha).",
    )
    parser.add_argument(
        "--bot2-name",
        type=str,
        default="Bravo",
        help="Second bot name to validate in video paths (default: Bravo).",
    )
    args = parser.parse_args()

    source_dir = Path(args.source_dir).resolve()

    instance_ids: Optional[Set[str]] = None
    if args.instance_ids:
        instance_ids = parse_instance_ids_arg(args.instance_ids)
        if not instance_ids:
            print("No valid instance ids provided after parsing.", file=sys.stderr)
            sys.exit(1)

    # Destination root is shared for all processed subdirectories
    destination_root = Path(args.destination_dir).resolve()

    started_at = datetime.now(timezone.utc).isoformat()
    processed_subdirs: List[str] = []

    # First, try to process one level deeper: each immediate subdirectory of source_dir.
    for child in sorted(source_dir.iterdir()):
        if not child.is_dir():
            continue

        # If the output directory is a subdirectory of source_dir, avoid
        # iterating over it (or any of its ancestor directory that we might
        # otherwise traverse here). This prevents re-processing freshly
        # written train/test outputs when destination_dir is inside source_dir.
        try:
            # destination_root.relative_to(child) succeeds iff destination_root
            # is equal to or nested under `child`.
            destination_root.relative_to(child)
            print(f"Skipping output (or parent) directory: {child}")
            continue
        except ValueError:
            # `child` is not an ancestor of destination_root → safe to process.
            pass

        print(f"Processing subdirectory: {child}")
        processed_subdirs.append(str(child))
        process_source_dir(
            child,
            args=args,
            instance_ids=instance_ids,
            destination_root=destination_root,
            subdir_prefix=child.name,
            strict_missing=True,
        )

    # Write meta file indicating completion.
    ensure_dir(destination_root)


if __name__ == "__main__":
    main()
