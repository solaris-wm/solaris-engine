# Minecraft Skin System

This directory contains the player skins used during data collection episodes. Each skin consists of two files:

- `<name>.png` — The 64x64 Minecraft skin texture
- `<name>.png.customskin` — Pre-signed Mojang texture data (generated once, never expires)

Both files are copied into Docker containers at `/data/skins/` and loaded by the MirrorBot plugin at episode start.

## How it works

Minecraft clients only accept skin textures that are **cryptographically signed by Mojang's servers**. A raw PNG file alone is not enough — it must be uploaded to Mojang (via the [MineSkin API](https://mineskin.org)), which returns a signed `value` + `signature` pair.

The `.customskin` file stores this signed data so the Docker containers **never need to contact MineSkin at runtime**. This eliminates rate-limit failures that previously caused skins to not load.

### Validation

`generate_compose.py` checks that every `.png` in this directory has a matching `.customskin` file **before generating any Docker Compose configs**. If any are missing, it exits with an error and no containers are launched. This ensures skin problems are caught immediately when running `run.sh`, not silently at runtime.

### Runtime flow

1. `generate_compose.py` validates all skins have cache files, then copies this directory into each Docker container
2. The MirrorBot plugin loads all `.png` files and their `.customskin` caches at episode start
3. Pre-signed texture data is injected into SkinsRestorer's storage
4. Skins are applied to players — no external API calls needed

## Adding a new skin

1. Place your 64x64 skin PNG in this directory (e.g., `my_skin.png`)

2. Generate the `.customskin` cache file from the **host machine** (requires internet):

   ```bash
   # Single skin
   python3 regenerate_skin_cache.py server/skins/my_skin.png

   # All skins missing cache files
   python3 regenerate_skin_cache.py server/skins/
   ```

3. Commit both files:

   ```bash
   git add server/skins/my_skin.png server/skins/my_skin.png.customskin
   git commit -m "Add my_skin"
   ```

4. Reference the skin in `generate_compose.py` by updating the `EPISODE_START_COMMAND`:

   ```
   episode start Alpha CameraAlpha my_skin.png Bravo CameraBravo other_skin.png
   ```

## Regenerating cache files

The signed texture data does not expire. You only need to regenerate if you modify the PNG:

```bash
python3 regenerate_skin_cache.py --force server/skins/my_skin.png
```

## Troubleshooting

- **`FileNotFoundError: Missing .customskin cache files`** when running `run.sh` or `generate_compose.py`: Run `regenerate_skin_cache.py` on the host to generate the missing cache files, then retry.
- **`regenerate_skin_cache.py` rate limited**: The script handles this automatically with retries. If it persists, wait a few minutes and try again.
- **Requires `requests`**: Install with `pip install requests`.

## File format

The `.customskin` file is JSON:

```json
{
  "skinName": "my_skin.png",
  "value": "<base64-encoded Mojang texture property>",
  "signature": "<base64-encoded Mojang signature>",
  "dataVersion": 1
}
```
