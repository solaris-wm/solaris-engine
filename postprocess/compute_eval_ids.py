#!/usr/bin/env python3

"""
Compute eval_ids.json for each eval type under an eval root.

Each subdir of EVAL_ROOT is a distinct eval type (e.g. wallOcclusionEval,
wallWalkEval).

Input layout (already produced by the data engine):
    <EVAL_ROOT>/<EVAL_TYPE>/test/<episode>_<bot>_instance_<n>.json
    <EVAL_ROOT>/<EVAL_TYPE>/test/<episode>_<bot>_instance_<n>_camera.mp4

Bot names are auto-detected per eval type by parsing the second token of
each *_camera.mp4 filename. Any N≥1 bots are supported (e.g. Alpha+Bravo,
or Alpha+Bravo+Charlie). Override with --bots if needed.

For each episode, the eval window starts at the last frame of the first
consecutive chunk of `sneak` actions (plus a fixed post-sneak delay),
picked from whichever bot's marker has the latest `renderTime`; each bot's
own timeline is then bisected against that start_time.

Output record per episode (tuple, positional):
    (episode_id, bot_A_start, bot_A_end, bot_B_start, bot_B_end, ...)
in alphabetical bot-name order. The order is logged per eval type.

Modes:
    In-place (no --dest-dir): writes <EVAL_ROOT>/<EVAL_TYPE>/eval_ids.json
        next to each eval type's test/ dir. Fails fast if <EVAL_ROOT> is
        read-only.
    Separate dest (--dest-dir DIR): copies each full <EVAL_TYPE>/ tree
        (test/, annotated/, anything else) into <DIR>/<EVAL_TYPE>/, then
        writes <DIR>/<EVAL_TYPE>/eval_ids.json. The result is a
        self-contained packaged dataset.

Refuses to run (pass --force to override) if:
    - --dest-dir is given and already exists.
    - any <EVAL_ROOT>/<EVAL_TYPE>/eval_ids.json already exists.

Data errors (no eval_ids.json is written for the affected eval type,
and the script exits non-zero at the end):
    - an episode is missing a bot's video or actions file.
    - an episode has empty actions, no sneak frames, non-increasing
      renderTimes, an invalid start index, or is shorter than num_frames
      after the sneak window.
    - an eval type yields zero complete episodes.
    All broken eval types are still processed so you see every problem in
    one run; under --dest-dir the copy is left in place for inspection.

Warnings (informational; output still written):
    - an eval type contains unexpected subdirs (besides test/ and annotated/).
    - detected bot sets differ across eval types.
    - an episode's start index is a >4σ outlier.

Standalone: only depends on numpy (for outlier z-scores).
"""

import argparse
import bisect
import json
import logging
import os
import shutil
import sys
from pathlib import Path
from typing import Any, Optional

import numpy as np

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

# See async function sneak in data:utils/movement.js
START_DELAY_AFTER_SNEAK = 25


class EvalDataError(Exception):
    """Raised when an episode's data is malformed or incomplete."""


def detect_bots(test_dir: Path) -> list[str]:
    """Parse bot names from *_camera.mp4 filenames (token index 1 of stem)."""
    bots: set[str] = set()
    for mp4 in test_dir.glob("*_camera.mp4"):
        tokens = mp4.stem.split("_")
        if len(tokens) >= 2:
            bots.add(tokens[1])
    return sorted(bots)


def discover_episodes(
    test_dir: Path, bot_names: list[str]
) -> tuple[list[dict[str, dict[str, str]]], list[str]]:
    """Pair every bot's video+actions per episode.

    Returns (complete_episodes, errors). An episode is complete only if
    every bot has both a video and an action file. Incomplete episodes
    are reported in `errors` rather than silently dropped. Discovery is
    driven by the first bot's *_camera.mp4 files; other bots' filenames
    are derived by swapping the bot-name segment.
    """
    if not bot_names:
        return [], []
    anchor = bot_names[0]
    episodes: list[dict[str, dict[str, str]]] = []
    errors: list[str] = []
    for anchor_video in sorted(test_dir.glob(f"*_{anchor}_*_camera.mp4")):
        episode: dict[str, dict[str, str]] = {}
        missing: list[str] = []
        for bot in bot_names:
            video_name = anchor_video.name.replace(f"_{anchor}_", f"_{bot}_", 1)
            video_path = test_dir / video_name
            actions_path = video_path.with_suffix(".json")
            if actions_path.name.endswith("_camera.json"):
                actions_path = actions_path.with_name(
                    actions_path.name.replace("_camera.json", ".json")
                )
            bot_missing = [p.name for p in (video_path, actions_path) if not p.exists()]
            if bot_missing:
                missing.extend(bot_missing)
            else:
                episode[bot] = {
                    "video_path": video_path.name,
                    "actions_path": actions_path.name,
                }
        if missing:
            errors.append(
                f"Episode anchored at {anchor_video.name}: missing files {missing}"
            )
        else:
            episodes.append(episode)
    return episodes, errors


def get_episode_info(
    test_dir: Path,
    paths: dict[str, dict[str, str]],
    num_frames: int,
    bot_names: list[str],
) -> dict[str, Any]:
    """Compute the eval window start/end idx for every bot.

    Raises EvalDataError on any data defect.
    """
    actions_by_bot: dict[str, list[dict[str, Any]]] = {}
    for bot in bot_names:
        with open(test_dir / paths[bot]["actions_path"], "r") as f:
            actions_by_bot[bot] = json.load(f)
        if len(actions_by_bot[bot]) < 1:
            raise EvalDataError(f"empty actions for {bot}")

    def last_frame_of_first_chunk(actions):
        sneak_frames = [
            {"index": i, "action": a}
            for i, a in enumerate(actions)
            if a["action"]["sneak"]
        ]
        if not sneak_frames:
            return None
        first_chunk_end = 0
        for i in range(1, len(sneak_frames)):
            if sneak_frames[i]["index"] != sneak_frames[i - 1]["index"] + 1:
                break
            first_chunk_end = i
        return sneak_frames[first_chunk_end]

    markers: dict[str, Optional[dict[str, Any]]] = {
        bot: last_frame_of_first_chunk(actions_by_bot[bot]) for bot in bot_names
    }
    if all(m is None for m in markers.values()):
        raise EvalDataError("no sneak frames in any bot")

    # Pick the latest marker by renderTime, then advance by the delay.
    # Ties break to the later bot in sorted order, matching the original
    # 2-bot code's `if marker1.rt > marker2.rt else marker2` preference.
    latest_bot: Optional[str] = None
    for bot in bot_names:
        m = markers[bot]
        if m is None:
            continue
        if (
            latest_bot is None
            or m["action"]["renderTime"] >= markers[latest_bot]["action"]["renderTime"]
        ):
            latest_bot = bot
    start_index = markers[latest_bot]["index"] + START_DELAY_AFTER_SNEAK
    if start_index >= len(actions_by_bot[latest_bot]):
        raise EvalDataError(
            f"sneak+delay index {start_index} exceeds {latest_bot} actions length "
            f"{len(actions_by_bot[latest_bot])}"
        )
    start_time = actions_by_bot[latest_bot][start_index]["renderTime"]

    bots_out: dict[str, dict[str, int]] = {}
    for bot in bot_names:
        times = [a["renderTime"] for a in actions_by_bot[bot]]
        if not all(n > p for p, n in zip(times, times[1:])):
            raise EvalDataError(f"non-increasing renderTimes for {bot}")
        start_idx = bisect.bisect_right(times, start_time) - 1
        if start_idx < 0:
            raise EvalDataError(
                f"{bot} invalid start_idx={start_idx}, start_time={start_time}"
            )
        end_idx = start_idx + num_frames
        if end_idx >= len(actions_by_bot[bot]):
            raise EvalDataError(
                f"{bot} too short for window: end_idx={end_idx} "
                f">= actions length {len(actions_by_bot[bot])} (num_frames={num_frames})"
            )
        bots_out[bot] = {"start_idx": start_idx, "end_idx": end_idx}

    return {"start_time": start_time, "bots": bots_out}


def compute_eval_ids_for_type(
    test_dir: Path,
    out_path: Path,
    num_frames: int,
    bot_names: list[str],
) -> tuple[int, int]:
    """Returns (num_ids_written, num_errors). On any error, no file is written."""
    episodes, discovery_errors = discover_episodes(test_dir, bot_names)
    logging.info(f"  Bots: {bot_names}")
    logging.info(f"  Discovered {len(episodes)} complete episodes in {test_dir}")

    ids: list[tuple] = []
    paths_map: dict[int, dict[str, dict[str, str]]] = {}
    episode_errors: list[str] = []
    for i, paths in enumerate(episodes):
        try:
            info = get_episode_info(test_dir, paths, num_frames, bot_names)
        except EvalDataError as e:
            episode_errors.append(f"Episode {i} {paths}: {e}")
            continue
        paths_map[i] = paths
        record = [int(i)]
        for bot in bot_names:
            record.append(info["bots"][bot]["start_idx"])
            record.append(info["bots"][bot]["end_idx"])
        ids.append(tuple(record))

    all_errors = list(discovery_errors) + episode_errors
    if not episodes and not discovery_errors:
        all_errors.append(
            f"no episodes discovered (expected *_{bot_names[0]}_*_camera.mp4 in {test_dir})"
        )

    if all_errors:
        logging.error(
            f"  {len(all_errors)} data error(s) in {test_dir}; "
            "eval_ids.json NOT written:"
        )
        for e in all_errors:
            logging.error(f"    {e}")
        return 0, len(all_errors)

    # Stats + outliers (clean run only).
    all_starts = [record[1 + 2 * k] for record in ids for k in range(len(bot_names))]
    mean_s, std_s = float(np.mean(all_starts)), float(np.std(all_starts))
    logging.info(f"  Start idx — mean={mean_s:.2f}, std={std_s:.2f}")
    for record in ids:
        eid = record[0]
        outlier_bots = []
        for k, bot in enumerate(bot_names):
            s = record[1 + 2 * k]
            z = abs(s - mean_s) / std_s if std_s > 0 else 0
            if z > 4:
                outlier_bots.append(f"{bot}={s} (z={z:.2f})")
        if outlier_bots:
            logging.warning(
                f"  Outlier episode {eid}: {', '.join(outlier_bots)} "
                f"paths={paths_map[eid]}"
            )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(ids, f, indent=2)
    return len(ids), 0


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "eval_root",
        help="Parent dir containing <EVAL_TYPE>/test/ subdirs.",
    )
    parser.add_argument(
        "--dest-dir",
        default=None,
        help="If given, each <EVAL_TYPE>/ tree is copied into "
             "<dest-dir>/<EVAL_TYPE>/ and eval_ids.json is written there "
             "(self-contained output). If omitted, eval_ids.json is written "
             "in-place under eval_root; eval_root must then be writable.",
    )
    parser.add_argument(
        "--num-frames",
        type=int,
        default=257,
        help="Length of the eval window written into each record as "
             "end_idx = start_idx + num_frames (default: 257). An episode "
             "shorter than this window is treated as a data error.",
    )
    parser.add_argument(
        "--bots",
        default=None,
        help="Comma-separated bot names (e.g. Alpha,Bravo,Charlie). "
             "If omitted, bots are auto-detected per eval type from "
             "*_camera.mp4 filenames.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Bypass safety refusals: allow writing into an existing --dest-dir "
             "(its <EVAL_TYPE>/ subdirs will be rmtree'd before copy) and "
             "overwrite any pre-existing <EVAL_TYPE>/eval_ids.json under "
             "eval_root.",
    )
    args = parser.parse_args()

    eval_root = Path(args.eval_root).expanduser().resolve()
    if not eval_root.is_dir():
        print(f"Error: eval_root not found: {eval_root}", file=sys.stderr)
        sys.exit(1)

    if args.dest_dir:
        dest_root = Path(args.dest_dir).expanduser().resolve()
    else:
        if not os.access(eval_root, os.W_OK):
            print(
                f"Error: eval_root is not writable ({eval_root}). "
                "Pass --dest-dir to write eval_ids.json elsewhere.",
                file=sys.stderr,
            )
            sys.exit(1)
        dest_root = eval_root

    eval_types = sorted(p for p in eval_root.iterdir() if p.is_dir() and (p / "test").is_dir())
    if not eval_types:
        print(
            f"Error: no <EVAL_TYPE>/test/ subdirs found under {eval_root}",
            file=sys.stderr,
        )
        sys.exit(1)

    copy_eval_types = dest_root != eval_root

    if copy_eval_types and dest_root.exists() and not args.force:
        print(
            f"Error: dest-dir already exists: {dest_root}. "
            "Pass --force to overwrite.",
            file=sys.stderr,
        )
        sys.exit(1)

    existing_eval_ids = [et / "eval_ids.json" for et in eval_types if (et / "eval_ids.json").exists()]
    if existing_eval_ids and not args.force:
        print(
            "Error: eval_ids.json already exists under eval_root:",
            file=sys.stderr,
        )
        for p in existing_eval_ids:
            print(f"  {p}", file=sys.stderr)
        print("Pass --force to overwrite.", file=sys.stderr)
        sys.exit(1)

    override_bots: Optional[list[str]] = None
    if args.bots:
        override_bots = sorted({b.strip() for b in args.bots.split(",") if b.strip()})
        if not override_bots:
            print("Error: --bots parsed to an empty list.", file=sys.stderr)
            sys.exit(1)

    # Resolve bots per eval type (override or auto-detect) and cross-check sets.
    bots_by_type: dict[str, list[str]] = {}
    for et in eval_types:
        if override_bots is not None:
            bots_by_type[et.name] = override_bots
        else:
            detected = detect_bots(et / "test")
            if not detected:
                print(
                    f"Error: could not detect any bots in {et / 'test'} "
                    "(no *_camera.mp4 files). Pass --bots to override.",
                    file=sys.stderr,
                )
                sys.exit(1)
            bots_by_type[et.name] = detected

    distinct_sets = {tuple(v) for v in bots_by_type.values()}
    if len(distinct_sets) > 1:
        logging.warning(
            "Detected bot sets differ across eval types: "
            + ", ".join(f"{name}={bots}" for name, bots in bots_by_type.items())
        )

    expected_subdirs = {"test", "annotated"}

    written: list[tuple[Path, int]] = []
    failed_types: list[str] = []
    total_errors = 0
    for eval_type in eval_types:
        logging.info(f"--- {eval_type.name} ---")
        src_test = eval_type / "test"

        unexpected = sorted(
            p.name for p in eval_type.iterdir()
            if p.is_dir() and p.name not in expected_subdirs
        )
        if unexpected:
            logging.warning(
                f"  {eval_type.name}: unexpected subdirs {unexpected} "
                f"(expected only {sorted(expected_subdirs)}). "
                "Check that eval_root points to the right dataset."
            )

        if copy_eval_types:
            dest_eval_type = dest_root / eval_type.name
            if dest_eval_type.is_symlink():
                dest_eval_type.unlink()
            elif dest_eval_type.exists():
                shutil.rmtree(dest_eval_type)
            shutil.copytree(eval_type, dest_eval_type)
            logging.info(f"  Copied {eval_type} -> {dest_eval_type}")

        out_path = dest_root / eval_type.name / "eval_ids.json"
        n, errs = compute_eval_ids_for_type(
            src_test, out_path, args.num_frames, bots_by_type[eval_type.name],
        )
        if errs:
            total_errors += errs
            failed_types.append(eval_type.name)
        else:
            logging.info(f"  Wrote {n} eval ids to {out_path}")
            written.append((out_path, n))

    logging.info("=" * 50)
    logging.info(f"Done. {len(written)} eval type(s) written cleanly:")
    for path, n in written:
        logging.info(f"  {path} ({n} ids)")
    if total_errors:
        logging.error(
            f"{total_errors} data error(s) across {len(failed_types)} eval type(s): "
            f"{failed_types}. Fix data and re-run."
        )
        sys.exit(1)
    logging.info("=" * 50)


if __name__ == "__main__":
    main()
