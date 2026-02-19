#!/usr/bin/env python3
import argparse
import random
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Set

# Reuse the same filename conventions as in filter_dataset.py:
#   <split_id>_<episode:6d>_..._instance_<instance:3d>.<ext>
EPISODE_WITH_PREFIX_RE = re.compile(r"^(?P<split_id>.+?)_(?P<episode>\d{6})(?:_|\.|$)")
INSTANCE_RE = re.compile(r"instance_(?P<instance>\d{3})(?:_|\.|$)")


@dataclass(frozen=True)
class EpisodeKey:
    split_id: str  # e.g. 'batch2_split_4' or '75_batch2_split_3'
    episode_id: str  # zero-padded 6-digit
    instance_id: str  # zero-padded 3-digit


def parse_episode_and_instance(filename: str) -> Optional[EpisodeKey]:
    """Parse episode and instance ids from a filename.

    Filenames are expected to contain both an episode id (6 digits) and an
    instance id (3 digits) in the same format as used elsewhere in the
    multiplayer data pipeline. Additionally, a \"split id\" prefix is extracted
    from the portion of the filename before the episode id.

    Example filenames and resulting split ids:
      - 'batch2_split_4_000058_Bravo_instance_001_episode_info' -> 'batch2_split_4'
      - '75_batch2_split_3_000058_Alpha_instance_001_episode_info' -> '75_batch2_split_3'
      - 'batch2_split_16_000095_Alpha_instance_003.json' -> 'batch2_split_16'
    """
    ep_match = EPISODE_WITH_PREFIX_RE.search(filename)
    inst_match = INSTANCE_RE.search(filename)
    if not ep_match or not inst_match:
        raise ValueError(
            f"Invalid filename does not contain both an episode id and an instance id: {filename}"
        )

    # Use the same definition of split_id as in filter_dataset.py:
    # everything up to (but not including) the 6-digit episode id.
    split_id = ep_match.group("split_id")
    if not split_id:
        raise ValueError(
            f"Invalid filename does not contain a split id prefix: {filename}"
        )

    return EpisodeKey(
        split_id=split_id,
        episode_id=ep_match.group("episode"),
        instance_id=inst_match.group("instance"),
    )


def collect_files_by_key(final_dir: Path) -> Dict[EpisodeKey, List[Path]]:
    """Group files in the final dataset by (episode, instance).

    Only top-level files in `final_dir` are considered; subdirectories are
    ignored. Files that do not contain both an episode id and an instance id
    in their name are skipped.
    """
    files_by_key: Dict[EpisodeKey, List[Path]] = {}

    for entry in final_dir.iterdir():
        if not entry.is_file():
            continue
        key = parse_episode_and_instance(entry.name)
        files_by_key.setdefault(key, []).append(entry)

    return files_by_key


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Split an already-processed final dataset directory into global "
            "train/test subdirectories by episode+instance."
        )
    )
    parser.add_argument(
        "final_dir",
        type=str,
        help=(
            "Path to the dataset directory produced by "
            "postprocess/prepare_train_dataset.py."
        ),
    )
    parser.add_argument(
        "--test-percent",
        "-p",
        type=float,
        default=1.0,
        help=(
            "Test split percentage (0-100). Episodes are shuffled globally "
            "and assigned to test according to this fraction."
        ),
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for deterministic splitting (default: 42).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print planned split but do not move any files.",
    )
    args = parser.parse_args()

    final_dir = Path(args.final_dir).resolve()
    if not final_dir.is_dir():
        print(f"ERROR: final_dir is not a directory: {final_dir}", file=sys.stderr)
        sys.exit(1)

    train_dir = final_dir / "train"
    test_dir = final_dir / "test"

    # To avoid accidentally re-splitting an already split directory, refuse to
    # run if train/ or test/ already exist.
    if train_dir.exists() or test_dir.exists():
        print(
            f"ERROR: '{final_dir}' already contains a 'train' or 'test' "
            "subdirectory. Aborting to avoid re-splitting.",
            file=sys.stderr,
        )
        sys.exit(1)

    files_by_key = collect_files_by_key(final_dir)
    if not files_by_key:
        print(
            f"ERROR: No files with episode+instance identifiers found in {final_dir}.",
            file=sys.stderr,
        )
        sys.exit(1)

    keys: List[EpisodeKey] = sorted(
        files_by_key.keys(), key=lambda k: (k.split_id, k.instance_id, k.episode_id)
    )

    # Global random split across all (episode, instance) keys.
    rng = random.Random(args.seed)
    keys_shuffled = keys[:]
    rng.shuffle(keys_shuffled)

    total_keys = len(keys_shuffled)
    percent = max(0.0, min(100.0, float(args.test_percent)))
    test_size = int(round(total_keys * (percent / 100.0)))
    test_size = max(0, min(test_size, total_keys))

    test_keys: Set[EpisodeKey] = set(keys_shuffled[:test_size])

    print(f"Total (episode, instance) keys: {total_keys}")
    print(f"Test percent requested: {percent:.2f}%")
    print(f"Test keys selected: {len(test_keys)}")
    print(f"Train keys selected: {total_keys - len(test_keys)}")

    if args.dry_run:
        print("\nDry run; no files will be moved.")
        sys.exit(0)

    # Create destination subdirectories.
    train_dir.mkdir(parents=True, exist_ok=False)
    test_dir.mkdir(parents=True, exist_ok=False)

    moved_train = 0
    moved_test = 0

    for key in keys_shuffled:
        dest_root = test_dir if key in test_keys else train_dir
        for src in files_by_key[key]:
            dst = dest_root / src.name
            if dst.exists():
                # This should not normally happen, but avoid overwriting.
                print(f"Skipping existing destination file: {dst}", file=sys.stderr)
                continue
            src.rename(dst)
            if dest_root is test_dir:
                moved_test += 1
            else:
                moved_train += 1

    print("\nCompleted splitting final dataset into train/test.")
    print(f"Files moved -> train: {moved_train}")
    print(f"Files moved -> test:  {moved_test}")


if __name__ == "__main__":
    main()
