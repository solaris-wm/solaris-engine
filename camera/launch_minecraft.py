#!/usr/bin/env python3
import hashlib
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import minecraft_launcher_lib


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def ensure_version(version: str, minecraft_dir: Path) -> None:
    minecraft_dir.mkdir(parents=True, exist_ok=True)
    version_dir = minecraft_dir / "versions" / version
    jar_file = version_dir / f"{version}.jar"
    json_file = version_dir / f"{version}.json"
    if jar_file.exists() and json_file.exists():
        print(
            f"[launcher] found cached Minecraft {version} at {version_dir}, skipping install",
            flush=True,
        )
        return
    minecraft_launcher_lib.install.install_minecraft_version(version, minecraft_dir)


def ensure_option(minecraft_dir: Path, key: str, value: str) -> None:
    options_path = minecraft_dir / "options.txt"
    if options_path.exists():
        lines = options_path.read_text().splitlines()
    else:
        options_path.parent.mkdir(parents=True, exist_ok=True)
        lines = []

    entry = f"{key}:{value}"
    for idx, line in enumerate(lines):
        if line.startswith(f"{key}:"):
            if line == entry:
                return
            lines[idx] = entry
            break
    else:
        lines.append(entry)

    options_path.write_text("\n".join(lines) + "\n")


def offline_login(username: str) -> dict[str, str]:
    data = ("OfflinePlayer:" + username).encode("utf-8")
    offline_uuid = uuid.UUID(hashlib.md5(data).hexdigest())
    return {
        "name": username,
        "uuid": str(offline_uuid),
        "token": "0",
    }


def build_launch_command(version: str, minecraft_dir: Path) -> list[str]:
    username = os.environ.get("CAMERA_NAME", "CameraAlpha")
    login = offline_login(username)

    width = env_int("WIDTH", 1280)
    height = env_int("HEIGHT", 720)
    host = os.environ.get("MC_HOST", "mc")
    port = os.environ.get("MC_PORT", "25565")

    quickplay_path = minecraft_dir / "quickplay" / "multiplayer.json"
    quickplay_path.parent.mkdir(parents=True, exist_ok=True)
    quickplay_entry = {
        "address": f"{host}:{port}",
        "name": host or "server",
        "icon": None,
    }
    quickplay_path.write_text(json.dumps(quickplay_entry, separators=(",", ":")))
    ensure_option(minecraft_dir, "skipQuickPlayFirstLaunchPrompt", "true")
    ensure_option(minecraft_dir, "accessibilityOnboarded", "true")
    ensure_option(minecraft_dir, "tutorialStep", "none")

    options = {
        "username": login["name"],
        "uuid": login["uuid"],
        "token": login["token"],
        "userType": "legacy",
        "launcherName": "mc-multiplayer-camera",
        "launcherVersion": "0.1",
        "gameDirectory": str(minecraft_dir),
        "customResolution": True,
        "resolutionWidth": str(width),
        "resolutionHeight": str(height),
        "jvmArguments": [
            "-Xmx" + os.environ.get("MC_MAX_MEMORY", "4G"),
            "-Xms" + os.environ.get("MC_MIN_MEMORY", "2G"),
            "-XX:+UnlockExperimentalVMOptions",
            "-XX:+UseG1GC",
            "-XX:G1NewSizePercent=20",
            "-XX:G1ReservePercent=20",
            "-XX:MaxGCPauseMillis=50",
            "-XX:G1HeapRegionSize=32M",
            "-Dsun.net.client.defaultConnectTimeout=2000",
            "-Dsun.net.client.defaultReadTimeout=2000",
        ],
        "javaExecutable": os.environ.get("JAVA_BIN", "/usr/bin/java"),
    }

    command = minecraft_launcher_lib.command.get_minecraft_command(
        version, minecraft_dir, options
    )

    java_bin = os.environ.get("JAVA_BIN")
    if java_bin:
        command[0] = java_bin

    quickplay_target = f"{host}:{port}"
    command.extend(["--quickPlayPath", str(quickplay_path)])
    command.extend(["--quickPlayMultiplayer", quickplay_target])

    return command


def main() -> int:
    minecraft_dir = Path(os.environ.get("MINECRAFT_HOME", "/root/.minecraft"))
    version = os.environ.get("MC_VERSION", "1.21")

    print(f"[launcher] ensuring Minecraft {version} in {minecraft_dir}", flush=True)
    ensure_version(version, minecraft_dir)

    command = build_launch_command(version, minecraft_dir)
    print(
        f"[launcher] starting Minecraft with command: {' '.join(command)}", flush=True
    )

    env = os.environ.copy()
    process = subprocess.Popen(command, env=env)

    try:
        return process.wait()
    except KeyboardInterrupt:
        process.terminate()
        return process.wait()


if __name__ == "__main__":
    sys.exit(main())
