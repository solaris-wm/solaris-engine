#!/usr/bin/env python3
"""
Batch video annotation script that processes multiple Minecraft videos in parallel.

Takes either:
1. A single directory containing:
   - aligned/ or test/: Directory with aligned video files
   - output/ or test/: Directory with action JSON files

2. A parent directory containing multiple subdirectories, each with the above structure.
   The script will automatically detect and process all subdirectories.

For each video pair (Alpha and Bravo perspectives), this script:
1. Annotates each video with action overlays
2. Vertically concatenates the two perspectives into a single video

Usage:
    python annotate_video_batch.py /path/to/videos_dir [--workers N] [--output-dir DIR]
    python annotate_video_batch.py /path/to/parent_dir  # Auto-detects subdirectories
"""

import argparse
import json
import random
import re
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
from tqdm import tqdm


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Batch annotate and concatenate Minecraft video pairs"
    )
    parser.add_argument(
        "videos_dir",
        type=str,
        help="Path to parent directory containing 'aligned' and 'output' subdirectories",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=8,
        help="Number of parallel workers (default: 8)",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=None,
        help="Output directory for annotated videos (default: <videos_dir>/annotated)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="Limit the number of video pairs to process (default: no limit)",
    )

    return parser.parse_args()


def load_action_data(json_file: Path) -> Optional[List[dict]]:
    """Load action data from JSON file."""
    try:
        with open(json_file, "r") as f:
            data = json.load(f)
        return data
    except FileNotFoundError:
        print(f"Warning: JSON file '{json_file}' not found")
        return None
    except json.JSONDecodeError as e:
        print(f"Warning: Invalid JSON format in '{json_file}': {e}")
        return None


def radians_per_tick_to_degrees_per_second(value):
    """Convert from radians per 0.05s to degrees per second."""
    return np.degrees(value) * 20  # 20 ticks per second


def create_action_overlay(
    frame, action, frame_idx, total_frames, player_label: str = ""
):
    """
    Create an overlay on the frame showing the current actions.
    """
    height, width = frame.shape[:2]

    # Create a semi-transparent overlay area
    overlay = frame.copy()

    # Define overlay region (top-left corner)
    overlay_x = 10
    overlay_y = 10
    overlay_width = 350
    overlay_height = 270 if player_label else 250

    # Draw semi-transparent background
    cv2.rectangle(
        overlay,
        (overlay_x, overlay_y),
        (overlay_x + overlay_width, overlay_y + overlay_height),
        (0, 0, 0),
        -1,
    )
    frame = cv2.addWeighted(overlay, 0.6, frame, 0.4, 0)

    # Font settings
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = 0.6
    thickness = 2
    line_height = 25

    # Starting position for text
    text_x = overlay_x + 10
    text_y = overlay_y + 25

    # Player label (if provided)
    if player_label:
        color = (0, 200, 255) if player_label == "Alpha" else (255, 100, 100)
        cv2.putText(
            frame,
            f"Player: {player_label}",
            (text_x, text_y),
            font,
            font_scale,
            color,
            thickness,
        )
        text_y += line_height

    # Frame counter
    cv2.putText(
        frame,
        f"Frame: {frame_idx}/{total_frames}",
        (text_x, text_y),
        font,
        font_scale,
        (255, 255, 255),
        thickness,
    )
    text_y += line_height

    if action is None:
        cv2.putText(
            frame,
            "No action data",
            (text_x, text_y),
            font,
            font_scale,
            (128, 128, 128),
            thickness,
        )
        return frame

    act = action.get("action", {})

    # Keyboard actions - WASD
    wasd_text = ""
    if act.get("forward", False):
        wasd_text += "W "
    if act.get("left", False):
        wasd_text += "A "
    if act.get("back", False):
        wasd_text += "S "
    if act.get("right", False):
        wasd_text += "D "

    if not wasd_text:
        wasd_text = "---"

    cv2.putText(
        frame,
        f"Movement: {wasd_text.strip()}",
        (text_x, text_y),
        font,
        font_scale,
        (0, 255, 0),
        thickness,
    )
    text_y += line_height

    # Jump and Sneak
    jump_sneak = []
    if act.get("jump", False):
        jump_sneak.append("JUMP")
    if act.get("sneak", False):
        jump_sneak.append("SNEAK")
    if act.get("sprint", False):
        jump_sneak.append("SPRINT")

    js_text = " ".join(jump_sneak) if jump_sneak else "---"
    cv2.putText(
        frame,
        f"Actions: {js_text}",
        (text_x, text_y),
        font,
        font_scale,
        (0, 255, 255),
        thickness,
    )
    text_y += line_height

    # Attack/Use
    attack_use = []
    if act.get("attack", False):
        attack_use.append("ATTACK")
    if act.get("use", False):
        attack_use.append("USE")

    au_text = " ".join(attack_use) if attack_use else "---"
    cv2.putText(
        frame,
        f"Attack/Use: {au_text}",
        (text_x, text_y),
        font,
        font_scale,
        (255, 100, 100),
        thickness,
    )
    text_y += line_height

    # Other actions (mine, place_block, place_entity, mount, dismount)
    other_actions = []
    if act.get("mine", False):
        other_actions.append("MINE")
    if act.get("place_block", False):
        other_actions.append("PLACE_BLOCK")
    if act.get("place_entity", False):
        other_actions.append("PLACE_ENTITY")
    if act.get("mount", False):
        other_actions.append("MOUNT")
    if act.get("dismount", False):
        other_actions.append("DISMOUNT")

    other_text = " ".join(other_actions) if other_actions else "---"
    cv2.putText(
        frame,
        f"Other: {other_text}",
        (text_x, text_y),
        font,
        font_scale,
        (200, 150, 255),
        thickness,
    )
    text_y += line_height

    # Hotbar selection
    hotbar_keys = []
    for i in range(1, 10):
        if act.get(f"hotbar.{i}", False):
            hotbar_keys.append(str(i))

    hotbar_text = " ".join(hotbar_keys) if hotbar_keys else "---"
    cv2.putText(
        frame,
        f"Hotbar: {hotbar_text}",
        (text_x, text_y),
        font,
        font_scale,
        (150, 255, 150),
        thickness,
    )
    text_y += line_height

    # Camera actions (mouse)
    camera = act.get("camera", [0, 0])
    yaw_raw = camera[0] if len(camera) > 0 else 0
    pitch_raw = camera[1] if len(camera) > 1 else 0

    # Convert to degrees per second
    yaw_dps = radians_per_tick_to_degrees_per_second(yaw_raw)
    pitch_dps = radians_per_tick_to_degrees_per_second(pitch_raw)

    cv2.putText(
        frame,
        f"Yaw:   {yaw_dps:+7.1f} deg/s",
        (text_x, text_y),
        font,
        font_scale,
        (255, 200, 0),
        thickness,
    )
    text_y += line_height

    cv2.putText(
        frame,
        f"Pitch: {pitch_dps:+7.1f} deg/s",
        (text_x, text_y),
        font,
        font_scale,
        (255, 200, 0),
        thickness,
    )
    text_y += line_height

    # Visual indicator for camera movement (arrow)
    arrow_center_x = overlay_x + overlay_width - 60
    arrow_center_y = overlay_y + overlay_height - 50
    arrow_scale = 0.5

    # Clamp the arrow length
    max_arrow_len = 40
    arrow_dx = int(-np.clip(yaw_dps * arrow_scale, -max_arrow_len, max_arrow_len))
    arrow_dy = int(-np.clip(pitch_dps * arrow_scale, -max_arrow_len, max_arrow_len))

    # Draw crosshair
    cv2.line(
        frame,
        (arrow_center_x - 20, arrow_center_y),
        (arrow_center_x + 20, arrow_center_y),
        (100, 100, 100),
        1,
    )
    cv2.line(
        frame,
        (arrow_center_x, arrow_center_y - 20),
        (arrow_center_x, arrow_center_y + 20),
        (100, 100, 100),
        1,
    )

    # Draw arrow if there's movement
    if abs(arrow_dx) > 1 or abs(arrow_dy) > 1:
        cv2.arrowedLine(
            frame,
            (arrow_center_x, arrow_center_y),
            (arrow_center_x + arrow_dx, arrow_center_y + arrow_dy),
            (0, 255, 255),
            2,
            tipLength=0.3,
        )
    else:
        cv2.circle(frame, (arrow_center_x, arrow_center_y), 3, (0, 255, 255), -1)

    return frame


def annotate_video_to_frames(
    video_path: Path, action_data: List[dict], player_label: str
) -> Tuple[List[np.ndarray], float, int, int]:
    """
    Annotate video frames with action overlays.
    Returns list of annotated frames and video properties (fps, width, height).
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video file '{video_path}'")

    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    frames = []
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        action = action_data[frame_idx] if frame_idx < len(action_data) else None
        processed_frame = create_action_overlay(
            frame, action, frame_idx, total_frames, player_label
        )
        frames.append(processed_frame)
        frame_idx += 1

    cap.release()
    return frames, fps, width, height


def concatenate_videos_vertically(
    alpha_frames: List[np.ndarray],
    bravo_frames: List[np.ndarray],
    fps: float,
    output_path: Path,
):
    """
    Vertically concatenate two sets of video frames (Alpha on top, Bravo on bottom).
    Handles videos of different lengths by padding the shorter one with the last frame.
    """
    if not alpha_frames and not bravo_frames:
        raise RuntimeError("Both frame lists are empty")

    # Handle case where one video might be longer than the other
    max_frames = max(len(alpha_frames), len(bravo_frames))

    # Pad shorter video with last frame
    if len(alpha_frames) < max_frames:
        alpha_frames.extend([alpha_frames[-1]] * (max_frames - len(alpha_frames)))
    if len(bravo_frames) < max_frames:
        bravo_frames.extend([bravo_frames[-1]] * (max_frames - len(bravo_frames)))

    # Get dimensions
    alpha_h, alpha_w = alpha_frames[0].shape[:2]
    bravo_h, bravo_w = bravo_frames[0].shape[:2]

    # Resize if widths don't match
    target_width = max(alpha_w, bravo_w)
    if alpha_w != target_width:
        alpha_frames = [cv2.resize(f, (target_width, alpha_h)) for f in alpha_frames]
    if bravo_w != target_width:
        bravo_frames = [cv2.resize(f, (target_width, bravo_h)) for f in bravo_frames]

    # Output dimensions
    out_height = alpha_h + bravo_h
    out_width = target_width

    # Create video writer
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(str(output_path), fourcc, fps, (out_width, out_height))

    if not out.isOpened():
        raise RuntimeError(f"Cannot create output video file '{output_path}'")

    # Write concatenated frames
    for alpha_frame, bravo_frame in zip(alpha_frames, bravo_frames):
        combined = np.vstack([alpha_frame, bravo_frame])
        out.write(combined)

    out.release()


def extract_video_key(video_name: str) -> Optional[str]:
    """
    Extract the key that identifies a video pair.
    Video name format: TIMESTAMP_EPISODE_<Alpha|Bravo>_instance_XXX_camera.mp4
    Returns: TIMESTAMP_EPISODE_instance_XXX (without Alpha/Bravo)
    """
    # Remove _camera.mp4 suffix
    base_name = video_name.replace("_camera.mp4", "")

    # Replace Alpha or Bravo with placeholder to get pair key
    match = re.match(r"(.+)_(Alpha|Bravo)_(.+)", base_name)
    if match:
        return f"{match.group(1)}_{match.group(3)}"
    return None


def extract_player_type(video_name: str) -> Optional[str]:
    """Extract player type (Alpha or Bravo) from video name."""
    if "_Alpha_" in video_name:
        return "Alpha"
    elif "_Bravo_" in video_name:
        return "Bravo"
    return None


def extract_instance_id(pair_key: str) -> Optional[str]:
    """
    Extract instance ID from a pair key.
    Pair key format: TIMESTAMP_EPISODE_instance_XXX
    Returns: instance_XXX or None if not found
    """
    match = re.search(r"(instance_\d+)", pair_key)
    if match:
        return match.group(1)
    return None


def select_limited_pairs_stratified(
    complete_pairs: Dict[str, Dict[str, Path]], limit: int
) -> Dict[str, Dict[str, Path]]:
    """
    Randomly select a limited number of pairs, distributed evenly across instance IDs.

    Args:
        complete_pairs: Dictionary of pair_key -> {"Alpha": path, "Bravo": path}
        limit: Maximum number of pairs to select

    Returns:
        Dictionary with selected pairs, evenly distributed across instances
    """
    # Group pairs by instance ID
    instance_groups: Dict[str, List[str]] = defaultdict(list)
    for pair_key in complete_pairs.keys():
        instance_id = extract_instance_id(pair_key)
        if instance_id:
            instance_groups[instance_id].append(pair_key)
        else:
            # If no instance ID found, put in "unknown" group
            instance_groups["unknown"].append(pair_key)

    num_instances = len(instance_groups)
    if num_instances == 0:
        return {}

    # Calculate base allocation per instance and remainder
    base_per_instance = limit // num_instances
    remainder = limit % num_instances

    selected_keys: List[str] = []

    # Sort instance IDs for consistent ordering when distributing remainder
    sorted_instances = sorted(instance_groups.keys())

    for i, instance_id in enumerate(sorted_instances):
        pairs_for_instance = instance_groups[instance_id]

        # Calculate how many to select from this instance
        # Distribute remainder to first 'remainder' instances
        num_to_select = base_per_instance + (1 if i < remainder else 0)

        # Don't select more than available
        num_to_select = min(num_to_select, len(pairs_for_instance))

        # Randomly select from this instance
        if num_to_select > 0:
            selected = random.sample(pairs_for_instance, num_to_select)
            selected_keys.extend(selected)

    return {k: complete_pairs[k] for k in selected_keys}


def get_json_path_for_video(video_path: Path, output_dir: Path) -> Path:
    """
    Get the corresponding JSON path for a video.
    Video: aligned/TIMESTAMP_EPISODE_Alpha_instance_XXX_camera.mp4
    JSON: output/TIMESTAMP_EPISODE_Alpha_instance_XXX.json
    """
    # Remove _camera.mp4 and add .json
    json_name = video_path.stem.replace("_camera", "") + ".json"
    return output_dir / json_name


def is_valid_videos_dir(directory: Path) -> bool:
    """
    Check if a directory is a valid videos directory (has aligned/ or test/ subdirectory).
    """
    return (directory / "test").exists() or (directory / "aligned").exists()


def discover_subdirectories(parent_dir: Path) -> List[Path]:
    """
    Discover all subdirectories that contain valid video structures.
    Returns list of paths to valid video directories.
    """
    valid_dirs = []
    for subdir in sorted(parent_dir.iterdir()):
        if subdir.is_dir() and is_valid_videos_dir(subdir):
            valid_dirs.append(subdir)
    return valid_dirs


def discover_video_pairs(videos_dir: Path) -> Dict[str, Dict[str, Path]]:
    """
    Discover all video pairs in the aligned directory.
    Returns a dict mapping pair_key -> {"Alpha": path, "Bravo": path}

    If videos_dir/test exists, uses that directory for videos.
    Otherwise, falls back to videos_dir/aligned.
    """
    # Check if test directory exists, otherwise use aligned
    test_dir = videos_dir / "test"
    if test_dir.exists():
        aligned_dir = test_dir
    else:
        aligned_dir = videos_dir / "aligned"

    if not aligned_dir.exists():
        raise RuntimeError(f"Video directory not found: {aligned_dir}")

    pairs: Dict[str, Dict[str, Path]] = {}

    for video_path in sorted(aligned_dir.glob("*.mp4")):
        pair_key = extract_video_key(video_path.name)
        player_type = extract_player_type(video_path.name)

        if not pair_key or not player_type:
            continue

        if pair_key not in pairs:
            pairs[pair_key] = {}
        pairs[pair_key][player_type] = video_path

    return pairs


def process_video_pair(
    pair_key: str,
    pair_videos: Dict[str, Path],
    output_dir: Path,
    json_dir: Path,
) -> Tuple[bool, str]:
    """
    Process a single video pair: annotate both videos and concatenate vertically.
    Returns (success, message).
    """
    try:
        alpha_path = pair_videos.get("Alpha")
        bravo_path = pair_videos.get("Bravo")

        if not alpha_path or not bravo_path:
            missing = "Alpha" if not alpha_path else "Bravo"
            return False, f"Missing {missing} video for pair {pair_key}"

        # Get JSON paths
        alpha_json = get_json_path_for_video(alpha_path, json_dir)
        bravo_json = get_json_path_for_video(bravo_path, json_dir)

        # Load action data
        alpha_actions = load_action_data(alpha_json)
        bravo_actions = load_action_data(bravo_json)

        if alpha_actions is None:
            return False, f"Missing action data: {alpha_json.name}"
        if bravo_actions is None:
            return False, f"Missing action data: {bravo_json.name}"

        # Annotate videos
        alpha_frames, fps, _, _ = annotate_video_to_frames(
            alpha_path, alpha_actions, "Alpha"
        )
        bravo_frames, _, _, _ = annotate_video_to_frames(
            bravo_path, bravo_actions, "Bravo"
        )

        # Create output path
        output_filename = f"{pair_key}_combined.mp4"
        output_path = output_dir / output_filename

        # Concatenate and save
        concatenate_videos_vertically(alpha_frames, bravo_frames, fps, output_path)

        return True, f"Created {output_filename}"

    except Exception as e:
        return False, f"Error processing {pair_key}: {str(e)}"


def process_single_videos_dir(
    videos_dir: Path,
    output_dir: Path,
    workers: int,
    limit: Optional[int] = None,
    dir_label: str = "",
) -> Tuple[int, int, List[str]]:
    """
    Process a single videos directory containing aligned/ or test/ and output/.

    Args:
        videos_dir: Path to directory with video files
        output_dir: Path to output directory for annotated videos
        workers: Number of parallel workers
        limit: Optional limit on number of pairs to process
        dir_label: Optional label for progress bar (e.g., subdirectory name)

    Returns:
        Tuple of (successful_count, failed_count, list_of_failure_messages)
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # Check if test directory exists, otherwise use output for JSONs
    test_dir = videos_dir / "test"
    if test_dir.exists():
        json_dir = test_dir
        video_source_dir = test_dir
    else:
        json_dir = videos_dir / "output"
        video_source_dir = videos_dir / "aligned"

    if not json_dir.exists():
        return 0, 0, [f"JSON directory not found: {json_dir}"]

    # Discover video pairs
    try:
        pairs = discover_video_pairs(videos_dir)
    except RuntimeError as e:
        return 0, 0, [str(e)]

    # Filter to complete pairs only
    complete_pairs = {k: v for k, v in pairs.items() if "Alpha" in v and "Bravo" in v}

    if not complete_pairs:
        return 0, 0, []

    # Apply limit if specified - stratified random selection across instances
    if limit and limit < len(complete_pairs):
        complete_pairs = select_limited_pairs_stratified(complete_pairs, limit)

    # Process pairs in parallel with progress bar
    successful = 0
    failed = 0
    failures = []

    desc = f"Annotating {dir_label}" if dir_label else "Annotating videos"

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(
                process_video_pair, pair_key, pair_videos, output_dir, json_dir
            ): pair_key
            for pair_key, pair_videos in complete_pairs.items()
        }

        with tqdm(total=len(complete_pairs), desc=desc, unit="pair") as pbar:
            for future in as_completed(futures):
                pair_key = futures[future]
                try:
                    success, message = future.result()
                    if success:
                        successful += 1
                    else:
                        failed += 1
                        failures.append(message)
                except Exception as e:
                    failed += 1
                    failures.append(f"Exception processing {pair_key}: {str(e)}")
                pbar.update(1)

    return successful, failed, failures


def main():
    args = parse_arguments()

    videos_dir = Path(args.videos_dir)
    if not videos_dir.exists():
        print(f"Error: Videos directory not found: {videos_dir}")
        sys.exit(1)

    # Check if this is a parent directory containing multiple video directories
    subdirectories = discover_subdirectories(videos_dir)
    is_parent_dir = len(subdirectories) > 0 and not is_valid_videos_dir(videos_dir)

    if is_parent_dir:
        # Parent directory mode: process each subdirectory
        print(f"{'='*60}")
        print(f"Parent Directory Mode")
        print(f"{'='*60}")
        print(f"Found {len(subdirectories)} video directories to process:")
        for subdir in subdirectories:
            print(f"  - {subdir.name}")
        print(f"{'='*60}\n")

        total_successful = 0
        total_failed = 0
        all_failures = []

        for subdir in subdirectories:
            # Set up output directory for this subdirectory
            if args.output_dir:
                # If custom output dir specified, create subdirectory within it
                output_dir = Path(args.output_dir) / subdir.name
            else:
                output_dir = subdir / "annotated"

            print(f"\n--- Processing {subdir.name} ---")
            successful, failed, failures = process_single_videos_dir(
                videos_dir=subdir,
                output_dir=output_dir,
                workers=args.workers,
                limit=args.limit,
                dir_label=subdir.name,
            )
            total_successful += successful
            total_failed += failed
            all_failures.extend([f"[{subdir.name}] {f}" for f in failures])

            if successful + failed > 0:
                print(f"  {subdir.name}: {successful} successful, {failed} failed")

        # Print final summary
        print(f"\n{'='*60}")
        print(f"Overall Processing Complete")
        print(f"{'='*60}")
        print(f"Directories processed: {len(subdirectories)}")
        print(f"Total successful: {total_successful}")
        print(f"Total failed: {total_failed}")
        if all_failures:
            print(f"\nFailures:")
            for msg in all_failures[:10]:
                print(f"  - {msg}")
            if len(all_failures) > 10:
                print(f"  ... and {len(all_failures) - 10} more failures")
        print(f"{'='*60}")

    else:
        # Single directory mode (original behavior)
        output_dir = (
            Path(args.output_dir) if args.output_dir else videos_dir / "annotated"
        )

        # Check if test directory exists, otherwise use output for JSONs
        test_dir = videos_dir / "test"
        if test_dir.exists():
            video_source_dir = test_dir
        else:
            video_source_dir = videos_dir / "aligned"

        # Discover video pairs for summary
        print(f"Discovering video pairs in {video_source_dir}...")
        try:
            pairs = discover_video_pairs(videos_dir)
        except RuntimeError as e:
            print(f"Error: {e}")
            sys.exit(1)

        # Filter to complete pairs only
        complete_pairs = {
            k: v for k, v in pairs.items() if "Alpha" in v and "Bravo" in v
        }
        incomplete_pairs = {k: v for k, v in pairs.items() if k not in complete_pairs}

        # Print summary
        print(f"\n{'='*60}")
        print(f"Video Pairs Summary")
        print(f"{'='*60}")
        print(f"Total video pairs found: {len(pairs)}")
        print(f"Complete pairs (Alpha + Bravo): {len(complete_pairs)}")
        print(f"Incomplete pairs: {len(incomplete_pairs)}")
        if incomplete_pairs:
            print(f"\nIncomplete pairs (skipping):")
            for key, videos in list(incomplete_pairs.items())[:5]:
                players = list(videos.keys())
                print(f"  - {key}: has {', '.join(players)} only")
            if len(incomplete_pairs) > 5:
                print(f"  ... and {len(incomplete_pairs) - 5} more")
        print(f"\nOutput directory: {output_dir}")
        print(f"{'='*60}\n")

        if not complete_pairs:
            print("No complete video pairs found to process.")
            sys.exit(0)

        # Apply limit if specified - stratified random selection across instances
        limit_to_apply = args.limit
        if limit_to_apply and limit_to_apply < len(complete_pairs):
            original_count = len(complete_pairs)

            # Count how many from each instance for reporting
            instance_counts: Dict[str, int] = defaultdict(int)
            limited_pairs = select_limited_pairs_stratified(
                complete_pairs, limit_to_apply
            )
            for pair_key in limited_pairs.keys():
                instance_id = extract_instance_id(pair_key) or "unknown"
                instance_counts[instance_id] += 1

            print(
                f"Limiting to {len(limited_pairs)} video pairs (out of {original_count} total)"
            )
            print(f"Stratified selection across {len(instance_counts)} instances:")
            for instance_id in sorted(instance_counts.keys()):
                print(f"  - {instance_id}: {instance_counts[instance_id]} pairs")

        print(
            f"Processing {len(complete_pairs) if not limit_to_apply else min(limit_to_apply, len(complete_pairs))} video pairs with {args.workers} workers...\n"
        )

        successful, failed, failures = process_single_videos_dir(
            videos_dir=videos_dir,
            output_dir=output_dir,
            workers=args.workers,
            limit=args.limit,
        )

        # Print final summary
        total = successful + failed
        print(f"\n{'='*60}")
        print(f"Processing Complete")
        print(f"{'='*60}")
        print(f"Successful: {successful}/{total}")
        print(f"Failed: {failed}/{total}")
        if failures:
            print(f"\nFailures:")
            for msg in failures[:10]:
                print(f"  - {msg}")
            if len(failures) > 10:
                print(f"  ... and {len(failures) - 10} more failures")
        print(f"\nOutput saved to: {output_dir}")
        print(f"{'='*60}")


if __name__ == "__main__":
    main()
