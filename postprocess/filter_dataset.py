#!/usr/bin/env python3
"""Filter a multiplayer dataset by moving selected episodes to a discarded/ dir.

This script is intended to work with episode lists of the form produced by
`postprocess/detect_water_episodes_batch.py`, i.e. a JSON array where each element is
an object containing:

    {
        "batch_id": "batch_0",
        "episode_id": "000011",
        "instance_id": "002"
    }

The dataset directory is expected to contain files whose *base names* encode
these three fields, e.g.::

    batch_0_000000_Alpha_instance_000.mp4
    batch_0_000058_Bravo_instance_001_episode_info.json

Here,
- batch id  -> prefix before the 6‑digit episode id (e.g. "batch_0")
- episode id -> 6 zero‑padded digits (e.g. "000000")
- instance id -> 3 zero‑padded digits after "instance_" (e.g. "000")

All files in the dataset directory whose parsed (batch_id, episode_id,
instance_id) triple appears in the JSON list will be moved into a sibling
subdirectory called "discarded".
"""

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Set


# Match a 6-digit episode id that is preceded by some batch id prefix.
# Example: "batch_0_000000_Alpha_instance_000.mp4"
#          ^--------------batch_id-------------^ ^episode^
# After the 6 digits we allow either an underscore, a dot (file extension),
# or end-of-string.
EPISODE_WITH_PREFIX_RE = re.compile(
    r"^(?P<batch_id>.+?)_(?P<episode>\d{6})(?:_|\.|$)"
)

# Match the 3-digit instance id near the end of the filename.
# After the 3 digits we allow underscore, dot, or end-of-string.
INSTANCE_RE = re.compile(r"instance_(?P<instance>\d{3})(?:_|\.|$)")


@dataclass(frozen=True)
class EpisodeKey:
    batch_id: str
    episode_id: str  # zero-padded 6-digit
    instance_id: str  # zero-padded 3-digit


def parse_episode_key_from_name(name: str) -> Optional[EpisodeKey]:
    """Parse (batch_id, episode_id, instance_id) from a filename.

    Returns None if the name does not contain the expected patterns.
    """

    ep_match = EPISODE_WITH_PREFIX_RE.search(name)
    inst_match = INSTANCE_RE.search(name)
    if not ep_match or not inst_match:
        print(f"Could not parse episode key from name: {name}. {ep_match} {inst_match}")
        return None

    batch_id = ep_match.group("batch_id")
    episode_id = ep_match.group("episode")
    instance_id = inst_match.group("instance")
    return EpisodeKey(batch_id=batch_id, episode_id=episode_id, instance_id=instance_id)


def load_excluded_keys(json_path: Path) -> Set[EpisodeKey]:
    """Load the JSON list of episodes to exclude and return a set of EpisodeKey.

    The JSON must be a list of objects each containing "batch_id",
    "episode_id", and "instance_id" as strings.
    """

    with json_path.open("r") as f:
        data = json.load(f)

    if not isinstance(data, list):
        raise ValueError(f"Expected JSON array at {json_path}, got {type(data)!r}")

    excluded: Set[EpisodeKey] = set()
    for idx, item in enumerate(data):
        if not isinstance(item, dict):
            raise ValueError(
                f"Entry #{idx} in {json_path} is not an object: {item!r}"
            )
        try:
            batch_id = str(item["batch_id"])
            episode_id = str(item["episode_id"])
            instance_id = str(item["instance_id"])
        except KeyError as e:
            raise ValueError(
                f"Entry #{idx} in {json_path} is missing key {e!s}: {item!r}"
            ) from e

        excluded.add(EpisodeKey(batch_id=batch_id, episode_id=episode_id, instance_id=instance_id))

    return excluded


def filter_dataset(dataset_dir: Path, excluded_keys: Set[EpisodeKey]) -> None:
    """Move matching files in `dataset_dir` into a `discarded/` subdirectory.

    Only top-level files in `dataset_dir` are considered; subdirectories are
    ignored. Any file whose parsed EpisodeKey matches one of `excluded_keys`
    is moved (via rename) into `dataset_dir / "discarded"`.
    """

    if not dataset_dir.is_dir():
        raise ValueError(f"dataset_dir is not a directory: {dataset_dir}")

    discarded_dir = dataset_dir / "discarded"
    discarded_dir.mkdir(parents=True, exist_ok=True)

    total_files = 0
    parsed_files = 0
    moved_files = 0
    skipped_unparsed = 0
    skipped_existing = 0

    for entry in sorted(dataset_dir.iterdir()):
        if not entry.is_file():
            continue
        total_files += 1

        key = parse_episode_key_from_name(entry.name)
        if key is None:
            skipped_unparsed += 1
            continue
        parsed_files += 1

        if key not in excluded_keys:
            continue

        dest = discarded_dir / entry.name
        if dest.exists():
            print(f"Skipping move; destination already exists: {dest}", file=sys.stderr)
            skipped_existing += 1
            continue

        entry.rename(dest)
        moved_files += 1

    print(f"Dataset directory: {dataset_dir}")
    print(f"Total files inspected: {total_files}")
    print(f"Files with parseable episode keys: {parsed_files}")
    print(f"Files moved to 'discarded': {moved_files}")
    if skipped_unparsed:
        print(f"Files skipped (unparseable name): {skipped_unparsed}")
    if skipped_existing:
        print(f"Files skipped (destination already existed): {skipped_existing}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Filter a multiplayer dataset by moving selected episodes into a "
            "'discarded' subdirectory based on a JSON list of "
            "(batch_id, episode_id, instance_id) triples."
        )
    )
    parser.add_argument(
        "--episodes-json",
        type=str,
        required=True,
        help=(
            "Path to JSON file containing a list of objects with "
            "'batch_id', 'episode_id', and 'instance_id' keys. "
            "All matching episodes will be discarded."
        ),
    )
    parser.add_argument(
        "dataset_dir",
        type=str,
        help=(
            "Path to dataset directory containing files such as "
            "'batch_0_000000_Alpha_instance_000.*'. "
            "Matching files will be moved into a 'discarded' subdirectory."
        ),
    )

    args = parser.parse_args()

    episodes_json = Path(args.episodes_json).resolve()
    if not episodes_json.is_file():
        print(f"ERROR: episodes_json is not a file: {episodes_json}", file=sys.stderr)
        sys.exit(1)

    dataset_dir = Path(args.dataset_dir).resolve()
    if not dataset_dir.is_dir():
        print(f"ERROR: dataset_dir is not a directory: {dataset_dir}", file=sys.stderr)
        sys.exit(1)

    try:
        excluded_keys = load_excluded_keys(episodes_json)
    except Exception as e:  # pragma: no cover - defensive
        print(
            f"ERROR: failed to load excluded episodes from {episodes_json}: {e}",
            file=sys.stderr,
        )
        sys.exit(1)

    if not excluded_keys:
        print("No excluded episodes found; nothing to do.")
        return

    print(f"Loaded {len(excluded_keys)} episodes to exclude from {episodes_json}.")

    try:
        filter_dataset(dataset_dir, excluded_keys)
    except Exception as e:  # pragma: no cover - defensive
        print(f"ERROR while filtering dataset: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
