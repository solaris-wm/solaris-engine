#!/usr/bin/env python3
"""Collect all water episodes from a batch root into a single JSON file.

The root directory is expected to contain multiple batch subdirectories, e.g.::

    /data/fred/mc_multiplayer_v2_gpu/
        batch2_split_0/
            water_episodes.json
        batch2_split_1/
            water_episodes.json
        ...

For every batch subdirectory, this script looks for a file named
``water_episodes.json`` with the structure illustrated by
``water_episodes.json`` beside the training data. It then collects all
entries from the ``"water_episodes"`` list.

Each output episode entry has three fields:

- ``batch_id``: the batch subdirectory name
- ``instance_id``: copied from the input JSON entry, coerced to string
- ``episode_id``: copied from the input JSON entry, coerced to string

The final output is a single top-level JSON list of such episode objects.

Example usage
-------------

    python postprocess/collect_water_episodes.py \
        --root /data/fred/mc_multiplayer_v2_gpu \
        --out-path /tmp/all_water_episodes.json
"""

import argparse
import json
from pathlib import Path
from typing import Iterable, List, Dict, Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Collect all water episodes from a batch root into a single JSON list."
        )
    )

    parser.add_argument(
        "--root",
        type=str,
        required=True,
        help="Root directory containing batch subdirectories (each with water_episodes.json).",
    )

    parser.add_argument(
        "--out-path",
        type=str,
        default="all_water_episodes.json",
        help=(
            "Output file path for the aggregated JSON. "
            "Defaults to 'all_water_episodes.json' in the current directory."
        ),
    )

    return parser.parse_args()


def iter_batch_dirs(root: Path) -> Iterable[Path]:
    """Yield immediate subdirectories of *root* sorted by name."""
    if not root.exists():
        print(f"Warning: root directory does not exist, skipping: {root}")
        return
    if not root.is_dir():
        print(f"Warning: root path is not a directory, skipping: {root}")
        return

    for entry in sorted(root.iterdir()):
        if entry.is_dir():
            yield entry


def collect_water_episodes(root: Path) -> List[Dict[str, Any]]:
    """Collect all water episodes from the given root.

    Parameters
    ----------
    root:
        Root directory. All immediate subdirectories are treated as batches
        and expected to contain ``water_episodes.json``.
    """

    episodes: List[Dict[str, Any]] = []

    for batch_dir in iter_batch_dirs(root):
        batch_name = batch_dir.name
        json_path = batch_dir / "water_episodes.json"

        if not json_path.exists():
            print(f"Warning: missing water_episodes.json in {batch_dir}, skipping")
            continue

        try:
            with json_path.open("r") as f:
                data = json.load(f)
        except Exception as e:
            print(f"Error reading {json_path}: {e}")
            continue

        water_list = data.get("water_episodes", [])
        if not isinstance(water_list, list):
            print(f"Warning: 'water_episodes' is not a list in {json_path}, skipping")
            continue

        batch_id = batch_name

        for ep in water_list:
            if not isinstance(ep, dict):
                continue
            episode_id = ep.get("episode_id")
            instance_id = ep.get("instance_id")

            # Coerce to strings to be consistent even if source uses ints.
            if episode_id is None or instance_id is None:
                continue

            episodes.append(
                {
                    "batch_id": str(batch_id),
                    "episode_id": str(episode_id),
                    "instance_id": str(instance_id),
                }
            )

    return episodes


def main() -> None:
    args = parse_args()
    root = Path(args.root).resolve()
    all_episodes = collect_water_episodes(root)

    output_path = Path(args.out_path).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("w") as f:
        json.dump(all_episodes, f, indent=2)

    print(f"Wrote {len(all_episodes)} water episodes to {output_path}")


if __name__ == "__main__":  # pragma: no cover
    main()
