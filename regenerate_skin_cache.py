#!/usr/bin/env python3
"""
Generate .customskin cache files for Minecraft skin PNGs.

This script uploads a skin PNG to the MineSkin API (https://mineskin.org)
to obtain Mojang-signed texture data, then saves it as a .customskin file
alongside the PNG. The signed data does not expire.

Usage:
    # Generate cache for a single skin
    python3 regenerate_skin_cache.py server/skins/my_skin.png

    # Generate cache for all PNGs missing a .customskin file
    python3 regenerate_skin_cache.py server/skins/

    # Force regenerate (overwrite existing cache files)
    python3 regenerate_skin_cache.py --force server/skins/my_skin.png

Requirements:
    pip install requests

The resulting .customskin files should be committed to the repository
alongside their PNGs. They are required by the MirrorBot plugin at runtime.
"""

import argparse
import json
import sys
import time
from pathlib import Path

try:
    import requests
except ImportError:
    print("Error: 'requests' package is required. Install it with: pip install requests", file=sys.stderr)
    sys.exit(1)

MINESKIN_API_URL = "https://api.mineskin.org/generate/upload"


def generate_customskin(png_path: Path, force: bool = False) -> bool:
    """Generate a .customskin cache file for a given PNG.

    Returns True on success, False on failure.
    """
    cache_path = png_path.with_suffix(png_path.suffix + ".customskin")

    if cache_path.exists() and not force:
        print(f"  Skipping {png_path.name} (cache already exists, use --force to regenerate)")
        return True

    print(f"  Uploading {png_path.name} to MineSkin API...")

    try:
        with open(png_path, "rb") as f:
            response = requests.post(
                MINESKIN_API_URL,
                files={"file": (png_path.name, f, "image/png")},
                data={"variant": "classic", "visibility": 1},
                timeout=60,
            )
    except requests.RequestException as e:
        print(f"  ERROR: Request failed for {png_path.name}: {e}", file=sys.stderr)
        return False

    if response.status_code == 429:
        # Rate limited — extract wait time and retry
        try:
            wait_data = response.json()
            delay = wait_data.get("nextRequest", 10)
            # nextRequest is a unix timestamp in seconds
            wait_seconds = max(delay - time.time(), 1) if delay > 1000 else delay
        except Exception:
            wait_seconds = 10
        print(f"  Rate limited. Waiting {wait_seconds:.0f}s before retrying...")
        time.sleep(wait_seconds)
        return generate_customskin(png_path, force=True)  # Retry once

    if response.status_code != 200:
        print(f"  ERROR: MineSkin returned status {response.status_code} for {png_path.name}", file=sys.stderr)
        try:
            print(f"  Response: {response.json()}", file=sys.stderr)
        except Exception:
            print(f"  Response: {response.text[:500]}", file=sys.stderr)
        return False

    try:
        data = response.json()
        texture = data["data"]["texture"]
        value = texture["value"]
        signature = texture["signature"]
    except (KeyError, TypeError) as e:
        print(f"  ERROR: Unexpected response format for {png_path.name}: {e}", file=sys.stderr)
        return False

    cache_data = {
        "skinName": png_path.name,
        "value": value,
        "signature": signature,
        "dataVersion": 1,
    }

    cache_path.write_text(json.dumps(cache_data))
    print(f"  Created {cache_path.name}")
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Generate .customskin cache files for Minecraft skin PNGs.",
        epilog="The resulting .customskin files should be committed to git alongside their PNGs.",
    )
    parser.add_argument(
        "path",
        type=Path,
        help="Path to a .png file or a directory containing .png files",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing .customskin files",
    )

    args = parser.parse_args()
    path: Path = args.path

    if path.is_file():
        if not path.suffix == ".png":
            print(f"Error: {path} is not a .png file", file=sys.stderr)
            sys.exit(1)
        png_files = [path]
    elif path.is_dir():
        png_files = sorted(path.glob("*.png"))
        if not png_files:
            print(f"No .png files found in {path}")
            sys.exit(0)
    else:
        print(f"Error: {path} does not exist", file=sys.stderr)
        sys.exit(1)

    # Filter to only files needing generation (unless --force)
    if not args.force:
        needed = [p for p in png_files if not p.with_suffix(p.suffix + ".customskin").exists()]
        if not needed:
            print(f"All {len(png_files)} skin(s) already have .customskin cache files. Use --force to regenerate.")
            sys.exit(0)
        print(f"Generating cache for {len(needed)} of {len(png_files)} skin(s)...")
        png_files = needed
    else:
        print(f"Generating cache for {len(png_files)} skin(s) (force mode)...")

    success = 0
    failed = 0
    for png in png_files:
        if generate_customskin(png, force=args.force):
            success += 1
        else:
            failed += 1
        # Small delay between requests to avoid rate limits
        if png != png_files[-1]:
            time.sleep(2)

    print(f"\nDone: {success} succeeded, {failed} failed.")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
