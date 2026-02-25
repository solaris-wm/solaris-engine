#!/usr/bin/env python3

"""
Copies and renames episode files (.json and .mp4) to a new destination directory,
removing the timestamp prefix from the filenames.

Supports processing either:
- A single episodes directory (with 'output/' and 'aligned/' subdirectories)
- A parent directory containing multiple episode directories
"""

import argparse
import os
import shutil
import sys


def process_episodes_dir(episodes_dir, destination_dir, ignore_first_episode):
    """
    Process a single episodes directory (containing 'output/' and 'aligned/' subdirectories).

    Args:
        episodes_dir: Path to the episodes directory
        destination_dir: Path to output the renamed files
        ignore_first_episode: If True, skip episodes with ID 000000

    Returns:
        Tuple of (copied_count, skipped_count, not_found_count)
    """
    output_dir = os.path.join(episodes_dir, "output")
    output_aligned_dir = os.path.join(episodes_dir, "aligned")

    # Validate structure
    if not os.path.isdir(output_dir):
        return None  # Signal that this is not a valid episodes directory
    if not os.path.isdir(output_aligned_dir):
        return None

    # Create destination directory
    try:
        os.makedirs(destination_dir, exist_ok=True)
    except OSError as e:
        print(
            f"Error: Could not create destination directory {destination_dir}: {e}",
            file=sys.stderr,
        )
        return (0, 0, 0)

    copied_count = 0
    skipped_count = 0
    not_found_count = 0

    for video_fname in os.listdir(output_aligned_dir):
        if not video_fname.endswith("_camera.mp4"):
            continue

        # Get the base name (with timestamp) from the video file
        # e.g., "20251111_071151_000031_Alpha_instance_000"
        base_with_timestamp = video_fname.replace("_camera.mp4", "")

        # --- Determine parts for checking and renaming ---
        parts = base_with_timestamp.split("_")
        if len(parts) <= 2:
            print(
                f"Warning: Filename format unexpected for {base_with_timestamp}, skipping."
            )
            skipped_count += 1
            continue

        # The episode ID is the 3rd part (index 2)
        # e.g., "000031" from "20251111_071151_000031_Alpha_instance_000"
        episode_id = parts[2]

        # --- Check for episode 0 ignore rule ---
        if ignore_first_episode and episode_id == "000000":
            print(f"  Skipping ignored episode 0 (ID 000000): {base_with_timestamp}")
            skipped_count += 1
            continue

        # --- Find corresponding JSON file ---
        json_fname = base_with_timestamp + ".json"
        src_json_path = os.path.join(output_dir, json_fname)
        src_video_path = os.path.join(output_aligned_dir, video_fname)

        if not os.path.exists(src_json_path):
            print(f"  Warning: JSON file not found for {video_fname}, skipping.")
            print(f"    (Expected at: {src_json_path})")
            not_found_count += 1
            continue

        # --- Determine new filenames ---
        # Re-join parts, skipping the first two (date and time)
        # e.g., "000031_Alpha_instance_000"
        new_base_name = "_".join(parts[2:])

        new_video_fname = new_base_name + "_camera.mp4"
        new_json_fname = new_base_name + ".json"

        dest_json_path = os.path.join(destination_dir, new_json_fname)
        dest_video_path = os.path.join(destination_dir, new_video_fname)

        # --- Copy files ---
        try:
            shutil.copy2(src_json_path, dest_json_path)
            shutil.copy2(src_video_path, dest_video_path)
            copied_count += 1
        except (IOError, os.error) as e:
            print(f"  Error copying {base_with_timestamp}: {e}", file=sys.stderr)
            skipped_count += 1

    return (copied_count, skipped_count, not_found_count)


def main():
    """
    Main function to parse arguments and process files.
    """
    parser = argparse.ArgumentParser(
        description="Prepare episode files for evaluation by copying and renaming them."
    )
    parser.add_argument(
        "--source-dir",
        type=str,
        required=True,
        help="Path to either: (1) a single episodes directory (containing 'output/' and 'aligned/' subdirectories), "
        "or (2) a parent directory containing multiple episode directories.",
    )
    parser.add_argument(
        "--destination-dir",
        type=str,
        required=True,
        help="Path to the new destination directory for renamed files.",
    )
    parser.add_argument(
        "--ignore-first-episode",
        action="store_true",
        help="If set, ignore the first episode (e.g., ..._instance_000) for each instance.",
    )

    args = parser.parse_args()

    # --- 1. Validate input directory exists ---
    if not os.path.isdir(args.source_dir):
        print(
            f"Error: Episodes directory not found: {args.source_dir}", file=sys.stderr
        )
        sys.exit(1)

    # --- 2. Determine if this is a single episodes dir or a parent containing multiple ---
    output_dir = os.path.join(args.source_dir, "output")
    aligned_dir = os.path.join(args.source_dir, "aligned")

    is_single_episodes_dir = os.path.isdir(output_dir) and os.path.isdir(aligned_dir)

    total_copied = 0
    total_skipped = 0
    total_not_found = 0
    dirs_processed = 0

    if is_single_episodes_dir:
        # --- Process single episodes directory (original behavior) ---
        print(f"Processing single episodes directory: {args.source_dir}")
        destination_dir = os.path.join(args.destination_dir, "test")

        result = process_episodes_dir(
            args.source_dir, destination_dir, args.ignore_first_episode
        )
        if result is not None:
            total_copied, total_skipped, total_not_found = result
            dirs_processed = 1
            print(f"  Output to: {destination_dir}")
    else:
        # --- Process parent directory containing multiple episode directories ---
        print(f"Processing parent directory: {args.source_dir}")
        print(
            "Looking for episode directories with 'output/' and 'aligned/' subdirectories...\n"
        )

        # Get list of subdirectories and sort them for consistent ordering
        subdirs = sorted(
            [
                d
                for d in os.listdir(args.source_dir)
                if os.path.isdir(os.path.join(args.source_dir, d))
            ]
        )

        for subdir_name in subdirs:
            subdir_path = os.path.join(args.source_dir, subdir_name)

            # Create corresponding destination subdirectory with /test appended
            dest_subdir = os.path.join(args.destination_dir, subdir_name, "test")

            result = process_episodes_dir(
                subdir_path, dest_subdir, args.ignore_first_episode
            )

            if result is None:
                # Not a valid episodes directory, skip silently
                continue

            copied, skipped, not_found = result
            total_copied += copied
            total_skipped += skipped
            total_not_found += not_found
            dirs_processed += 1

            print(f"Processed: {subdir_name} -> {copied} file pairs copied")

        if dirs_processed == 0:
            print(
                "Warning: No valid episode directories found (directories must contain 'output/' and 'aligned/' subdirectories)."
            )

    # --- 3. Print summary ---
    print("\n--- Processing Complete ---")
    print(f"Episode directories processed: {dirs_processed}")
    print(f"Successfully copied file pairs: {total_copied}")
    print(f"Skipped files (rule or format): {total_skipped}")
    print(f"Missing JSON counterparts:     {total_not_found}")
    print("-----------------------------\n")


if __name__ == "__main__":
    main()
