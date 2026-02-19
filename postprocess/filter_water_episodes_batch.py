#!/usr/bin/env python3
"""
Batch filter water episodes by detecting the oxygen bar HUD element in video frames.

This script uses multiprocessing to process all video files in batch_2_split_*/aligned/
directories and outputs JSON files categorizing episodes as water or non-water.

Episodes are processed as Alpha-Bravo pairs - if either video shows underwater indicators,
the entire pair is classified as a water episode.
"""

import argparse
import json
import multiprocessing as mp
import os
import re
from dataclasses import dataclass, field
from glob import glob
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image
from tqdm import tqdm

# Crop coordinates for the oxygen bar region
CROP_X = 670
CROP_Y = 573


@dataclass
class VideoAnalysisResult:
    """Result of analyzing a single video for water detection."""

    filename: str
    top_percentile_similarity: float
    top_5_frame_numbers: List[int]
    all_similarities: List[float] = field(default_factory=list)


@dataclass
class EpisodePairResult:
    """Result for an Alpha-Bravo episode pair."""

    episode_id: str
    instance_id: str
    split_number: str
    alpha_filename: Optional[str]
    bravo_filename: Optional[str]
    alpha_top_percentile: Optional[float]
    bravo_top_percentile: Optional[float]
    alpha_top_5_frames: Optional[List[int]]
    bravo_top_5_frames: Optional[List[int]]
    is_water_episode: bool

    def to_dict(self) -> dict:
        return {
            "episode_id": self.episode_id,
            "instance_id": self.instance_id,
            "split_number": self.split_number,
            "alpha_filename": self.alpha_filename,
            "bravo_filename": self.bravo_filename,
            "alpha_top_percentile_similarity": self.alpha_top_percentile,
            "bravo_top_percentile_similarity": self.bravo_top_percentile,
            "alpha_top_5_frame_numbers": self.alpha_top_5_frames,
            "bravo_top_5_frame_numbers": self.bravo_top_5_frames,
        }


def parse_video_filename(filename: str) -> Optional[Dict[str, str]]:
    """
    Parse a video filename to extract metadata.

    Expected format: 20251207_141853_000076_Alpha_instance_002_camera.mp4

    Returns:
        Dict with keys: datetime, episode_id, role, instance_id
        Or None if parsing fails
    """
    pattern = r"^(\d{8}_\d{6})_(\d{6})_(Alpha|Bravo)_instance_(\d{3})_camera\.mp4$"
    match = re.match(pattern, filename)

    if match:
        return {
            "datetime": match.group(1),
            "episode_id": match.group(2),
            "role": match.group(3),
            "instance_id": match.group(4),
        }
    return None


def load_oxygen_bar_template() -> Tuple[np.ndarray, np.ndarray]:
    """
    Load the oxygen bar template and return RGB values and alpha mask.

    Returns:
        rgb_template: RGB values of the template (H, W, 3)
        alpha_mask: Boolean mask where alpha == 255 (H, W)
    """
    asset_path = Path(__file__).parent / "assets" / "minecraft-hud-oxygen-bar-rgba.png"
    img = Image.open(asset_path)
    img_array = np.array(img)

    rgb_template = img_array[:, :, :3]  # RGB channels
    alpha_mask = img_array[:, :, 3] == 255  # Boolean mask where alpha is 255
    assert alpha_mask.sum() > 0, "Alpha mask is empty!"

    return rgb_template, alpha_mask


def compute_cosine_similarity_masked(
    frame_crop: np.ndarray, template_rgb: np.ndarray, alpha_mask: np.ndarray
) -> float:
    """
    Compute cosine similarity between cropped frame and template,
    only using pixels where alpha mask is True.
    """
    # Extract only the masked pixels and flatten
    frame_masked = frame_crop[alpha_mask].flatten().astype(np.float32)
    template_masked = template_rgb[alpha_mask].flatten().astype(np.float32)

    # Compute cosine similarity
    dot_product = np.dot(frame_masked, template_masked)
    norm_frame = np.linalg.norm(frame_masked)
    norm_template = np.linalg.norm(template_masked)

    if norm_frame == 0 or norm_template == 0:
        return 0.0

    return dot_product / (norm_frame * norm_template)


def analyze_video(
    args: Tuple[str, np.ndarray, np.ndarray, int, int],
) -> VideoAnalysisResult:
    """
    Analyze a single video for water detection.

    Args:
        args: Tuple of (video_path, template_rgb, alpha_mask, max_frames, top_percentile)

    Returns:
        VideoAnalysisResult with analysis results
    """
    video_path, template_rgb, alpha_mask, max_frames, top_percentile = args
    filename = os.path.basename(video_path)

    cap = cv2.VideoCapture(video_path)

    if not cap.isOpened():
        print(f"  Warning: Could not open video: {video_path}")
        return VideoAnalysisResult(
            filename=filename,
            top_percentile_similarity=0.0,
            top_5_frame_numbers=[],
        )

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    template_h, template_w = template_rgb.shape[:2]

    # Determine which frames to sample (uniformly distributed)
    if total_frames <= max_frames:
        frames_to_process = set(range(total_frames))
    else:
        frames_to_process = set(
            np.linspace(0, total_frames - 1, max_frames, dtype=int).tolist()
        )

    similarities = []
    frame_similarity_pairs = []  # (frame_idx, similarity)

    # Read frames sequentially (faster than seeking) but only process selected ones
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # Only process selected frames
        if frame_idx not in frames_to_process:
            frame_idx += 1
            continue

        # Convert BGR to RGB
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        # Crop the oxygen bar region
        crop = frame_rgb[CROP_Y : CROP_Y + template_h, CROP_X : CROP_X + template_w]

        # Check if crop is valid
        if crop.shape[0] != template_h or crop.shape[1] != template_w:
            frame_idx += 1
            continue

        # Compute similarity
        sim = compute_cosine_similarity_masked(crop, template_rgb, alpha_mask)
        similarities.append(sim)
        frame_similarity_pairs.append((frame_idx, sim))

        frame_idx += 1

    cap.release()

    if not similarities:
        return VideoAnalysisResult(
            filename=filename,
            top_percentile_similarity=0.0,
            top_5_frame_numbers=[],
        )

    # Calculate top N percentile (e.g., top 10% = 90th percentile)
    numpy_percentile = 100 - top_percentile
    top_percentile_value = float(np.percentile(similarities, numpy_percentile))

    # Get top 5 frames by similarity
    frame_similarity_pairs.sort(key=lambda x: x[1], reverse=True)
    top_5_frames = [pair[0] for pair in frame_similarity_pairs[:5]]

    return VideoAnalysisResult(
        filename=filename,
        top_percentile_similarity=top_percentile_value,
        top_5_frame_numbers=top_5_frames,
    )


def group_videos_by_episode_pair(
    video_files: List[str],
) -> Dict[Tuple[str, str], Dict[str, str]]:
    """
    Group video files by episode ID and instance ID pairs.

    Returns:
        Dict mapping (episode_id, instance_id) -> {"Alpha": filename, "Bravo": filename}
    """
    pairs: Dict[Tuple[str, str], Dict[str, str]] = {}

    for video_file in video_files:
        filename = os.path.basename(video_file)
        parsed = parse_video_filename(filename)

        if parsed is None:
            print(f"  Warning: Could not parse filename: {filename}")
            continue

        key = (parsed["episode_id"], parsed["instance_id"])

        if key not in pairs:
            pairs[key] = {"Alpha": None, "Bravo": None}

        pairs[key][parsed["role"]] = video_file

    return pairs


def process_split_folder(
    split_folder: str,
    template_rgb: np.ndarray,
    alpha_mask: np.ndarray,
    threshold: float,
    max_frames: int,
    num_workers: int,
    top_percentile: int,
) -> Tuple[List[EpisodePairResult], List[EpisodePairResult]]:
    """
    Process all videos in a split folder and categorize episodes.

    Returns:
        Tuple of (water_episodes, non_water_episodes)
    """
    aligned_folder = os.path.join(split_folder, "aligned")

    if not os.path.exists(aligned_folder):
        print(f"  Warning: Aligned folder not found: {aligned_folder}")
        return [], []

    # Find all video files
    video_pattern = os.path.join(aligned_folder, "*_camera.mp4")
    video_files = glob(video_pattern)

    if not video_files:
        print(f"  No video files found in: {aligned_folder}")
        return [], []

    print(f"  Found {len(video_files)} video files")

    # Group videos by episode pairs
    episode_pairs = group_videos_by_episode_pair(video_files)
    print(f"  Found {len(episode_pairs)} episode pairs")

    # Prepare tasks for multiprocessing
    all_video_paths = []
    for pair_files in episode_pairs.values():
        if pair_files["Alpha"]:
            all_video_paths.append(pair_files["Alpha"])
        if pair_files["Bravo"]:
            all_video_paths.append(pair_files["Bravo"])

    # Create task arguments
    tasks = [
        (path, template_rgb, alpha_mask, max_frames, top_percentile)
        for path in all_video_paths
    ]

    # Process videos with multiprocessing
    print(f"  Processing {len(tasks)} videos with {num_workers} workers...")

    with mp.Pool(processes=num_workers) as pool:
        results = list(
            tqdm(
                pool.imap(analyze_video, tasks),
                total=len(tasks),
                desc="  Analyzing videos",
                unit="video",
            )
        )

    # Build a mapping from filename to result
    results_by_filename: Dict[str, VideoAnalysisResult] = {}
    for result in results:
        results_by_filename[result.filename] = result

    # Extract split number from folder name
    split_match = re.search(r"batch2_split_(\d+)", split_folder, re.IGNORECASE)
    split_number = split_match.group(1) if split_match else "unknown"

    # Categorize episode pairs
    water_episodes: List[EpisodePairResult] = []
    non_water_episodes: List[EpisodePairResult] = []

    for (episode_id, instance_id), pair_files in episode_pairs.items():
        alpha_filename = (
            os.path.basename(pair_files["Alpha"]) if pair_files["Alpha"] else None
        )
        bravo_filename = (
            os.path.basename(pair_files["Bravo"]) if pair_files["Bravo"] else None
        )

        alpha_result = (
            results_by_filename.get(alpha_filename) if alpha_filename else None
        )
        bravo_result = (
            results_by_filename.get(bravo_filename) if bravo_filename else None
        )

        alpha_top_pct = alpha_result.top_percentile_similarity if alpha_result else None
        bravo_top_pct = bravo_result.top_percentile_similarity if bravo_result else None

        alpha_top_5_frames = alpha_result.top_5_frame_numbers if alpha_result else None
        bravo_top_5_frames = bravo_result.top_5_frame_numbers if bravo_result else None

        # Episode is water if either Alpha or Bravo exceeds threshold
        is_water = False
        if alpha_top_pct is not None and alpha_top_pct >= threshold:
            is_water = True
        if bravo_top_pct is not None and bravo_top_pct >= threshold:
            is_water = True

        pair_result = EpisodePairResult(
            episode_id=episode_id,
            instance_id=instance_id,
            split_number=split_number,
            alpha_filename=alpha_filename,
            bravo_filename=bravo_filename,
            alpha_top_percentile=alpha_top_pct,
            bravo_top_percentile=bravo_top_pct,
            alpha_top_5_frames=alpha_top_5_frames,
            bravo_top_5_frames=bravo_top_5_frames,
            is_water_episode=is_water,
        )

        if is_water:
            water_episodes.append(pair_result)
        else:
            non_water_episodes.append(pair_result)

    # Sort by instance_id (most significant), then episode_id (2nd most significant)
    sort_key = lambda ep: (ep.instance_id, ep.episode_id)
    water_episodes.sort(key=sort_key)
    non_water_episodes.sort(key=sort_key)

    return water_episodes, non_water_episodes


def save_results_json(
    output_path: str,
    water_episodes: List[EpisodePairResult],
    non_water_episodes: List[EpisodePairResult],
    threshold: float,
    top_percentile: int,
):
    """Save categorized episodes to JSON file."""
    output_data = {
        "metadata": {
            "threshold": threshold,
            "top_percentile": top_percentile,
            "total_episodes": len(water_episodes) + len(non_water_episodes),
            "water_episode_count": len(water_episodes),
            "non_water_episode_count": len(non_water_episodes),
        },
        "water_episodes": [ep.to_dict() for ep in water_episodes],
        "non_water_episodes": [ep.to_dict() for ep in non_water_episodes],
    }

    with open(output_path, "w") as f:
        json.dump(output_data, f, indent=2)

    print(f"  Saved results to: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Filter water episodes from Minecraft video recordings"
    )
    parser.add_argument(
        "--base-path",
        type=str,
        required=True,
        help="Base path containing batch_2_split_* folders",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.8,
        help="Cosine similarity threshold for water detection (default: 0.8)",
    )
    parser.add_argument(
        "--max-frames",
        type=int,
        default=1000,
        help="Maximum number of frames to sample per video (default: 1000)",
    )
    parser.add_argument(
        "--num-workers",
        type=int,
        default=None,
        help="Number of worker processes (default: number of CPU cores)",
    )
    parser.add_argument(
        "--split-pattern",
        type=str,
        default="batch2_split_*",
        help="Glob pattern for split folders (default: batch2_split_*)",
    )
    parser.add_argument(
        "--top-percentile",
        type=int,
        default=10,
        help="Top N percentile to use for similarity thresholding (default: 10, meaning top 10%%)",
    )

    args = parser.parse_args()

    # Set number of workers
    num_workers = args.num_workers if args.num_workers else mp.cpu_count()
    print(f"Using {num_workers} worker processes")
    print(f"Threshold: {args.threshold}")
    print(f"Top percentile: {args.top_percentile}%")
    print(f"Max frames per video: {args.max_frames}")

    # Load template once
    print("\nLoading oxygen bar template...")
    template_rgb, alpha_mask = load_oxygen_bar_template()
    print(f"  Template shape: {template_rgb.shape}")
    print(f"  Masked pixels: {alpha_mask.sum()}")

    # Find all split folders
    split_pattern = os.path.join(args.base_path, args.split_pattern)
    split_folders = sorted(glob(split_pattern))

    if not split_folders:
        print(f"\nNo split folders found matching: {split_pattern}")
        return

    print(f"\nFound {len(split_folders)} split folders")

    # Process each split folder
    total_water = 0
    total_non_water = 0

    for split_folder in split_folders:
        split_name = os.path.basename(split_folder)
        print(f"\n{'='*60}")
        print(f"Processing: {split_name}")
        print(f"{'='*60}")

        water_episodes, non_water_episodes = process_split_folder(
            split_folder=split_folder,
            template_rgb=template_rgb,
            alpha_mask=alpha_mask,
            threshold=args.threshold,
            max_frames=args.max_frames,
            num_workers=num_workers,
            top_percentile=args.top_percentile,
        )

        # Save results
        output_path = os.path.join(split_folder, "water_episodes.json")
        save_results_json(
            output_path,
            water_episodes,
            non_water_episodes,
            args.threshold,
            args.top_percentile,
        )

        print(f"  Water episodes: {len(water_episodes)}")
        print(f"  Non-water episodes: {len(non_water_episodes)}")

        total_water += len(water_episodes)
        total_non_water += len(non_water_episodes)

    # Final summary
    print(f"\n{'='*60}")
    print("FINAL SUMMARY")
    print(f"{'='*60}")
    print(f"Total water episodes: {total_water}")
    print(f"Total non-water episodes: {total_non_water}")
    print(f"Total episodes processed: {total_water + total_non_water}")
    if total_water + total_non_water > 0:
        water_percent = 100 * total_water / (total_water + total_non_water)
        print(f"Water episode percentage: {water_percent:.1f}%")


if __name__ == "__main__":
    main()
