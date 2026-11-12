#!/usr/bin/env python3
"""
Generate multiple Docker Compose configurations for parallel Minecraft data collection.
Each instance will have its own ports and output directories to avoid conflicts.

Enhancements:
- Support generating a mix of flatland and normal worlds via
  `--num_flatland_world` and `--num_normal_world`.
- Add `--viewer_rendering_disabled` (default: 1) applied to act_recorder/controller.
- Keep `--bootstrap_wait_time` unchanged as an argument.
"""

import argparse
import os
import re
import time
from pathlib import Path
from typing import Optional

import yaml


DEFAULT_PLAYERS = [
    "Alpha", "Bravo", "Charlie", "Delta", "Echo",
    "Foxtrot", "Golf", "Hotel", "India", "Juliett",
    "Kilo", "Lima", "Mike", "November", "Oscar",
    "Papa", "Quebec", "Romeo", "Sierra", "Tango",
    "Uniform", "Victor", "Whiskey", "Xray", "Yankee", "Zulu",
]
DEFAULT_SKINS = {
    "Alpha": "technoblade.png",
    "Bravo": "test.png",
    "Charlie": "charlie.png",
}


def absdir(path: str) -> str:
    """Return an absolute path.

    If `path` is relative, it's resolved against the current working directory.
    """
    if os.path.isabs(path):
        return path
    return os.path.abspath(os.path.join(os.getcwd(), path))


def camera_paths(
    instance_id: int,
    players: list,
    output_bases: list,
    data_bases: list,
) -> dict:
    assert len(output_bases) == len(players)
    assert len(data_bases) == len(players)
    paths = {}
    for i, name in enumerate(players):
        key = name.lower()
        paths[f"{key}_output_host"] = os.path.join(output_bases[i], str(instance_id))
        paths[f"{key}_data_host"] = os.path.join(data_bases[i], str(instance_id))
    return paths


def camera_ports(
    instance_id: int,
    players: list,
    vnc_bases: list,
    novnc_bases: list,
    display_base: int,
    vnc_step: int,
    display_step: int,
) -> dict:
    assert len(vnc_bases) == len(players)
    assert len(novnc_bases) == len(players)
    ports = {}
    for i, name in enumerate(players):
        key = name.lower()
        ports[f"{key}_vnc"] = vnc_bases[i] + vnc_step * instance_id
        ports[f"{key}_novnc"] = novnc_bases[i] + vnc_step * instance_id
        ports[f"{key}_display"] = f":{display_base + display_step * instance_id + i}"
    return ports


def generate_terrain_settings(biome, surface_block):
    """Generate terrain settings JSON for flat world generation."""
    terrain_settings = {
        "layers": [
            {"block": "minecraft:bedrock", "height": 1},
            {"block": "minecraft:stone", "height": 124},
            {"block": "minecraft:dirt", "height": 2},
            {"block": f"minecraft:{surface_block}", "height": 1},
        ],
        "biome": f"minecraft:{biome}",
    }
    return terrain_settings


def generate_compose_config(
    instance_id,
    base_port,
    base_rcon_port,
    act_recorder_port,
    coord_port,
    data_dir_base,
    output_dir,
    num_episodes,
    episode_start_id,
    bootstrap_wait_time,
    episode_category,
    episode_types,
    smoke_test,
    viewer_rendering_disabled,
    world_type,
    render_distance,
    simulation_distance,
    graphics_mode,
    # per-player
    players,
    skins,
    camera_output_bases,
    camera_data_bases,
    camera_vnc_bases,
    camera_novnc_bases,
    display_base,
    vnc_step,
    display_step,
    # CPU pinning
    cpuset: Optional[str] = None,
    cpusets_camera: Optional[list] = None,
    # GPU settings
    gpu_device_id: Optional[int] = None,
    gpu_mode: str = "egl",
    disable_nvenc: bool = False,
    # Eval options
    eval_time_set_day: int = 0,
    # Flatland options
    flatland_world_disable_structures: bool = False,
    # Advancement options
    disable_advancements: bool = False,
    # Camera encoder ("h264_nvenc" or "libx264"); None = auto-detect in container
    camera_encoder: Optional[str] = None,
):
    """Generate a Docker Compose configuration for a single instance."""

    # Calculate ports for this instance
    mc_port = base_port + instance_id
    rcon_port = base_rcon_port + instance_id

    # Directories - each instance gets its own data subdirectory
    data_dir = f"{data_dir_base}/{instance_id}"
    camera_env_overrides = (
        {"CAMERA_ENCODER": camera_encoder} if camera_encoder else {}
    )

    cam_paths = camera_paths(
        instance_id,
        players,
        camera_output_bases,
        camera_data_bases,
    )
    cam_ports = camera_ports(
        instance_id,
        players,
        camera_vnc_bases,
        camera_novnc_bases,
        display_base,
        vnc_step,
        display_step,
    )

    project_root = str(Path(__file__).resolve().parent)

    plugin_starter_package_json_host = os.path.join(project_root, "server", "plugin-starter", "package.json")
    # If the only episode type is turnToLookEval, use the fixed seed "solaris"
    if episode_types == "turnToLookEval" or episode_types == "turnToLookOppositeEval":
        seed = "solaris"
        print(
            f"turnToLookEval episode type passsed. Using fixed seed 'solaris' for all instances."
        )
    else:
        seed = str(instance_id) + str(int(time.time()))
    services = {
        f"prep_data_instance_{instance_id}": {
            "image": "busybox:latest",
            "command": [
                "sh",
                "-c",
                "mkdir -p /data /data/plugins /data/skins && "
                "chmod 777 /data /data/plugins /data/skins && "
                'if [ -d /source_plugins ] && [ -n "$(ls -A /source_plugins 2>/dev/null)" ]; then '
                "  cp -r /source_plugins/. /data/plugins/; "
                "fi; "
                'if [ -d /source_skins ] && [ -n "$(ls -A /source_skins 2>/dev/null)" ]; then '
                "  cp -r /source_skins/. /data/skins/; "
                "fi; "
                + (
                    "cp /source_config/spigot.yml /data/spigot.yml; "
                    if disable_advancements
                    else ""
                )
                + "chmod -R 777 /data/plugins /data/skins",
            ],
            "volumes": [
                f"{data_dir}:/data",
                f"{project_root}/server/plugins:/source_plugins:ro",
                f"{project_root}/server/skins:/source_skins:ro",
            ]
            + (
                [f"{project_root}/server/config:/source_config:ro"]
                if disable_advancements
                else []
            ),
            "restart": "no",
        },
        f"mc_instance_{instance_id}": {
            "depends_on": {
                f"prep_data_instance_{instance_id}": {
                    "condition": "service_completed_successfully"
                }
            },
            "image": "itzg/minecraft-server:java21",
            "tty": True,
            "network_mode": "host",
            **({"cpuset": cpuset} if cpuset else {}),
            "environment": (
                lambda: {
                    # Base server env, common to both normal and flat worlds
                    "EULA": "TRUE",
                    "VERSION": "1.21",
                    "TYPE": "PAPER",
                    "MODE": "survival",
                    "RCON_PORT": rcon_port,
                    "SERVER_PORT": mc_port,
                    "ALLOW_FLIGHT": True,
                    "ONLINE_MODE": False,
                    "SPAWN_PROTECTION": 0,
                    "SEED": seed,
                    "ENFORCE_SECURE_PROFILE": False,
                    "RCON_PASSWORD": "research",
                    "BROADCAST_RCON_TO_OPS": True,
                    **(
                        {
                            "LEVEL_TYPE": "minecraft:flat",
                            "GENERATOR_SETTINGS": "TERRAIN_SETTINGS_PLACEHOLDER",
                            **(
                                {"GENERATE_STRUCTURES": "false"}
                                if flatland_world_disable_structures
                                else {}
                            ),
                        }
                        if str(world_type).lower() == "flat"
                        else {}
                    ),
                }
            )(),
            "volumes": [f"{data_dir}:/data"],
            "healthcheck": {
                "test": [
                    "CMD-SHELL",
                    f"mc-monitor status --host localhost --port {mc_port}",
                ],
                "interval": "10s",
                "timeout": "5s",
                "retries": 12,
            },
        },
    }

    for i, name in enumerate(players):
        key = name.lower()
        peer_endpoints = ",".join(
            f"{p}:controller_{p.lower()}_instance_{instance_id}:{coord_port}"
            for p in players
            if p != name
        )
        camera_cpuset = cpusets_camera[i] if cpusets_camera else None
        # First player gets a world-scale teleport; peers land close to it.
        teleport_radius = 50000 if i == 0 else 250

        controller_deps = {
            f"mc_instance_{instance_id}": {"condition": "service_healthy"},
            f"act_recorder_{key}_instance_{instance_id}": {
                "condition": "service_started"
            },
        }
        if i > 0:
            prev_key = players[i - 1].lower()
            controller_deps[f"controller_{prev_key}_instance_{instance_id}"] = {
                "condition": "service_started"
            }

        services[f"controller_{key}_instance_{instance_id}"] = {
            "image": "solaris-engine-base:latest",
            "build": {
                "context": project_root,
                "dockerfile": "Dockerfile",
            },
            "depends_on": controller_deps,
            **({"cpuset": cpuset} if cpuset else {}),
            "volumes": [f"{output_dir}:/output"],
            "environment": {
                "BOT_NAME": name,
                "ACT_RECORDER_HOST": f"act_recorder_{key}_instance_{instance_id}",
                "ACT_RECORDER_PORT": act_recorder_port,
                "COORD_PORT": coord_port,
                "PEER_ENDPOINTS": peer_endpoints,
                "BOT_RNG_SEED": str(12345 + instance_id),
                "EPISODES_NUM": num_episodes,
                "EPISODE_START_ID": episode_start_id,
                "EPISODE_TYPES": episode_types,
                "MC_HOST": "host.docker.internal",
                "MC_PORT": mc_port,
                "RCON_HOST": "host.docker.internal",
                "RCON_PORT": rcon_port,
                "RCON_PASSWORD": "research",
                "BOOTSTRAP_WAIT_TIME": bootstrap_wait_time,
                "ENABLE_CAMERA_WAIT": 1,
                "CAMERA_READY_RETRIES": 300,
                "CAMERA_READY_CHECK_INTERVAL": 2000,
                "MC_VERSION": "1.21",
                "VIEWER_RENDERING_DISABLED": viewer_rendering_disabled,
                "VIEWER_RECORDING_INTERVAL": 50,
                "WALK_TIMEOUT": 5,
                "TELEPORT": 1,
                "TELEPORT_RADIUS": teleport_radius,
                "WORLD_TYPE": str(world_type).lower(),
                "SMOKE_TEST": smoke_test,
                "INSTANCE_ID": instance_id,
                "OUTPUT_DIR": "/output",
                "EVAL_TIME_SET_DAY": eval_time_set_day,
            },
            "extra_hosts": ["host.docker.internal:host-gateway"],
            "networks": [f"mc_network_{instance_id}"],
            "command": "./controller/entrypoint.sh",
        }

        services[f"act_recorder_{key}_instance_{instance_id}"] = {
            "image": "solaris-engine-base:latest",
            "environment": {
                "PORT": act_recorder_port,
                "NAME": name,
                "INSTANCE_ID": instance_id,
                "EPISODE_START_ID": episode_start_id,
                "VIEWER_RENDERING_DISABLED": viewer_rendering_disabled,
            },
            "tty": True,
            **({"cpuset": cpuset} if cpuset else {}),
            "volumes": [f"{output_dir}:/output"],
            "networks": [f"mc_network_{instance_id}"],
            "command": "./controller/act_recorder/entrypoint.sh",
        }

        services[f"camera_{key}_instance_{instance_id}"] = {
            "image": "solaris-engine-camera:latest",
            "build": {
                "context": os.path.join(project_root, "camera"),
                "dockerfile": "Dockerfile",
            },
            "restart": "unless-stopped",
            "network_mode": "host",
            **({"cpuset": camera_cpuset} if camera_cpuset else {}),
            "depends_on": {
                f"mc_instance_{instance_id}": {"condition": "service_healthy"}
            },
            "environment": {
                "MC_VERSION": "1.21",
                "MC_HOST": "127.0.0.1",
                "MC_PORT": mc_port,
                **camera_env_overrides,
                "CAMERA_NAME": f"Camera{name}",
                "DISPLAY": cam_ports[f"{key}_display"],
                "VNC_PORT": str(cam_ports[f"{key}_vnc"]),
                "NOVNC_PORT": str(cam_ports[f"{key}_novnc"]),
                "WIDTH": "1280",
                "HEIGHT": "720",
                "FPS": "20",
                "VNC_PASSWORD": "research",
                "ENABLE_RECORDING": "1",
                "RECORDING_PATH": f"/output/camera_{key}.mkv",
                "DISABLE_NVENC": "1" if disable_nvenc else "0",
                "RENDER_DISTANCE": render_distance,
                "SIMULATION_DISTANCE": simulation_distance,
                "GRAPHICS_MODE": graphics_mode,
                **(
                    {
                        "NVIDIA_DRIVER_CAPABILITIES": "all",
                        "NVIDIA_VISIBLE_DEVICES": gpu_device_id,
                    }
                ),
            },
            "runtime": "nvidia",
            "volumes": [
                f"{cam_paths[f'{key}_data_host']}:/root",
                f"{cam_paths[f'{key}_output_host']}:/output",
            ],
        }

        services[f"spectator_{key}_instance_{instance_id}"] = {
            "image": "solaris-engine-base:latest",
            "build": {
                "context": project_root,
                "dockerfile": "Dockerfile",
            },
            "restart": "unless-stopped",
            **({"cpuset": cpuset} if cpuset else {}),
            "depends_on": {
                f"mc_instance_{instance_id}": {"condition": "service_healthy"}
            },
            "working_dir": "/usr/src/app",
            "environment": {
                "MC_HOST": "host.docker.internal",
                "MC_PORT": mc_port,
                "MC_USERNAME": f"Spectator{name}",
            },
            "extra_hosts": [
                "host.docker.internal:host-gateway",
            ],
            "networks": [f"mc_network_{instance_id}"],
            "command": ["node", "spectator/spectator.js"],
        }

    # Plugin starter: waits for all players then triggers episode start
    first_key = players[0].lower()
    required_players = ",".join(
        f"{p},Camera{p},Spectator{p}" for p in players
    )
    start_command_args = " ".join(
        f"{p} Camera{p} {skins[i]}" for i, p in enumerate(players)
    )
    services[f"plugin_starter_instance_{instance_id}"] = {
        "image": "node:20",
        "network_mode": "host",
        **({"cpuset": cpuset} if cpuset else {}),
        "depends_on": {
            f"mc_instance_{instance_id}": {"condition": "service_healthy"},
            f"camera_{first_key}_instance_{instance_id}": {
                "condition": "service_started"
            },
        },
        "working_dir": "/app",
        "environment": {
            "RCON_HOST": "127.0.0.1",
            "RCON_PORT": rcon_port,
            "RCON_PASSWORD": "research",
            "EPISODE_START_RETRIES": "300",
            "EPISODE_REQUIRED_PLAYERS": required_players,
            "EPISODE_START_COMMAND": f"episode start {start_command_args}",
        },
        "volumes": [
            f"{os.path.join(project_root, 'server', 'plugin-starter', 'plugin_starter.js')}:/app/plugin_starter.js:ro",
            f"{plugin_starter_package_json_host}:/app/package.json:ro",
        ],
        "command": [
            "sh",
            "-c",
            "npm install --omit=dev --no-progress && node plugin_starter.js",
        ],
    }

    config = {
        "networks": {f"mc_network_{instance_id}": {"driver": "bridge"}},
        "services": services,
    }

    return config


def main():
    parser = argparse.ArgumentParser(
        description="Generate Docker Compose files for parallel Minecraft data "
        "collection"
    )
    parser.add_argument(
        "--instances",
        type=int,
        default=15,
        help="Number of instances to generate (default: 32)",
    )
    # World-split counts: if provided (>0), overrides --instances
    parser.add_argument(
        "--num_flatland_world",
        type=int,
        default=0,
        help="Number of flatland-world instances to generate (default: 0)",
    )
    parser.add_argument(
        "--num_normal_world",
        type=int,
        default=0,
        help="Number of normal-world instances to generate (default: 0)",
    )
    parser.add_argument(
        "--compose_dir",
        default="compose_configs",
        help="Directory to store generated compose files",
    )
    parser.add_argument(
        "--base_port",
        type=int,
        default=25565,
        help="Base Minecraft server port (default: 25565)",
    )
    parser.add_argument(
        "--base_rcon_port",
        type=int,
        default=25675,
        help="Base RCON port (default: 25675)",
    )
    parser.add_argument(
        "--act_recorder_port",
        type=int,
        default=8090,
        help="Act recorder port for bridge network services (default: 8090)",
    )
    parser.add_argument(
        "--coord_port",
        type=int,
        default=8100,
        help="Coordination port for bridge network services (default: 8100)",
    )
    parser.add_argument(
        "--data_dir",
        required=True,
        help="Base directory for instance data directories (default: ./data)",
    )
    parser.add_argument(
        "--output_dir",
        default="./output",
        required=True,
        help="Shared output directory for all instances (default: ./output)",
    )
    parser.add_argument(
        "--num_players",
        type=int,
        default=2,
        help=f"Number of players per instance (default: 2, max: {len(DEFAULT_PLAYERS)})",
    )
    parser.add_argument(
        "--skins",
        nargs="*",
        default=None,
        help="Per-player skin filenames (length must equal --num_players). "
        "Defaults to DEFAULT_SKINS lookup when players are the default NATO prefix.",
    )
    # Camera-specific bases (absolute paths) — one per player
    parser.add_argument(
        "--camera_output_bases",
        nargs="+",
        required=True,
        help="Absolute base dirs for per-instance camera outputs, one per player "
        "(length must equal --num_players).",
    )
    parser.add_argument(
        "--camera_data_bases",
        nargs="*",
        default=None,
        help="Absolute base dirs for per-instance camera data, one per player "
        "(default: <project>/camera/data_<playername>).",
    )
    parser.add_argument(
        "--camera_vnc_bases",
        nargs="*",
        type=int,
        default=None,
        help="Starting VNC ports, one per player (default: 5901..5901+N-1).",
    )
    parser.add_argument(
        "--camera_novnc_bases",
        nargs="*",
        type=int,
        default=None,
        help="Starting noVNC ports, one per player (default: 6901..6901+N-1).",
    )
    parser.add_argument("--display_base", type=int, default=99)
    parser.add_argument(
        "--vnc_step",
        type=int,
        default=None,
        help="Stride between instances for VNC/noVNC ports (default: --num_players).",
    )
    parser.add_argument(
        "--display_step",
        type=int,
        default=None,
        help="Stride between instances for X display numbers (default: --num_players).",
    )
    parser.add_argument(
        "--num_episodes",
        type=int,
        default=5,
        help="Number of episodes to run (default: 5)",
    )
    parser.add_argument(
        "--episode_start_id",
        type=int,
        default=0,
        help="Starting episode ID (default: 0)",
    )
    parser.add_argument(
        "--bootstrap_wait_time",
        type=int,
        default=60,
        help="Bootstrap wait time (default: 60)",
    )
    parser.add_argument(
        "--episode_category",
        default="look",
        help="Episode category (default: look)",
    )
    parser.add_argument(
        "--episode_types",
        default="all",
        help="Comma-separated episode types to run (default: all)",
    )

    parser.add_argument(
        "--viewer_rendering_disabled",
        type=int,
        choices=[0, 1],
        default=1,
        help="Disable viewer rendering for act_recorder/controller (default: 1)",
    )
    parser.add_argument(
        "--smoke_test",
        type=int,
        default=0,
        choices=[0, 1],
        help="Enable smoke test mode to run all episode types (default: 0)",
    )
    parser.add_argument(
        "--eval_time_set_day",
        type=int,
        default=0,
        choices=[0, 1],
        help="Set time to day at the start of eval episodes (default: 0)",
    )
    parser.add_argument(
        "--flatland_world_disable_structures",
        type=int,
        default=0,
        choices=[0, 1],
        help="Disable structure generation for flatland worlds (default: 0)",
    )
    parser.add_argument(
        "--render_distance",
        type=int,
        default=8,
        help="Minecraft render distance in chunks (2-32, lower = faster, our default: 8, MC default: 12.)",
    )
    parser.add_argument(
        "--simulation_distance",
        type=int,
        default=4,
        help="Minecraft simulation distance in chunks (5-32, lower = faster, our default: 4, MC default: 8.)",
    )
    parser.add_argument(
        "--graphics_mode",
        type=int,
        default=1,
        choices=[0, 1, 2],
        help="Minecraft graphics mode (0=Fast, 1=Fancy, 2=Fabulous, default: 1)",
    )
    parser.add_argument(
        "--gpu_mode",
        type=str,
        default="egl",
        choices=["egl", "x11", "auto"],
        help="GPU rendering mode: egl (headless), x11 (requires host X), auto (default: egl)",
    )
    parser.add_argument(
        "--disable_advancements",
        type=str,
        default="false",
        choices=["true", "false"],
        help="Disable all Minecraft advancements via spigot.yml (default: false). When true, bootstrap_wait_time is overridden to 0 since advancement popups cannot appear.",
    )
    parser.add_argument(
        "--camera_encoder",
        type=str,
        default=None,
        choices=["libx264", "h264_nvenc"],
        help="Video encoder for camera recording: libx264 (CPU) or h264_nvenc (NVIDIA GPU). "
        "If unset, the container probes NVENC with a one-frame test encode and "
        "falls back to libx264 on GPUs without NVENC silicon (e.g. A100/H100).",
    )
    parser.add_argument(
        "--disable_nvenc",
        type=int,
        default=0,
        choices=[0, 1],
        help="Force CPU (libx264) video encoding in camera containers. Normally "
        "unnecessary: the camera entrypoint probes NVENC with a test encode and "
        "falls back to CPU automatically on GPUs without NVENC silicon (e.g. "
        "A100/H100). Use this to skip the probe or force CPU encoding; "
        "equivalent to --camera_encoder libx264 (default: 0)",
    )

    args = parser.parse_args()
    # Ensure required dirs are absolute
    args.output_dir = absdir(args.output_dir)
    args.data_dir = absdir(args.data_dir)

    # Resolve player list and validate per-player arg lengths
    if args.num_players < 1 or args.num_players > len(DEFAULT_PLAYERS):
        raise ValueError(
            f"--num_players must be between 1 and {len(DEFAULT_PLAYERS)}"
        )
    players = DEFAULT_PLAYERS[: args.num_players]

    if args.skins is None:
        missing = [p for p in players if p not in DEFAULT_SKINS]
        if missing:
            raise ValueError(
                f"No default skin for players {missing}; pass --skins explicitly."
            )
        args.skins = [DEFAULT_SKINS[p] for p in players]
    if len(args.skins) != args.num_players:
        raise ValueError("--skins length must equal --num_players")

    if len(args.camera_output_bases) != args.num_players:
        raise ValueError("--camera_output_bases length must equal --num_players")
    args.camera_output_bases = [absdir(p) for p in args.camera_output_bases]

    project_root = str(Path(__file__).resolve().parent)
    if args.camera_data_bases is None:
        args.camera_data_bases = [
            absdir(os.path.join(project_root, "camera", f"data_{p.lower()}"))
            for p in players
        ]
    else:
        if len(args.camera_data_bases) != args.num_players:
            raise ValueError("--camera_data_bases length must equal --num_players")
        args.camera_data_bases = [absdir(p) for p in args.camera_data_bases]

    if args.camera_vnc_bases is None:
        args.camera_vnc_bases = [5901 + i for i in range(args.num_players)]
    elif len(args.camera_vnc_bases) != args.num_players:
        raise ValueError("--camera_vnc_bases length must equal --num_players")
    if args.camera_novnc_bases is None:
        args.camera_novnc_bases = [6901 + i for i in range(args.num_players)]
    elif len(args.camera_novnc_bases) != args.num_players:
        raise ValueError("--camera_novnc_bases length must equal --num_players")

    if args.vnc_step is None:
        args.vnc_step = args.num_players
    if args.display_step is None:
        args.display_step = args.num_players

    # Create compose directory
    compose_dir = Path(args.compose_dir)
    compose_dir.mkdir(parents=True, exist_ok=True)

    # Determine number of instances and world plan
    use_split = (args.num_flatland_world > 0) or (args.num_normal_world > 0)
    if use_split:
        total_instances = args.num_flatland_world + args.num_normal_world
        world_plan = ["flat"] * args.num_flatland_world + [
            "normal"
        ] * args.num_normal_world
    else:
        total_instances = args.instances
        world_plan = ["normal"] * total_instances

    # GPU configuration validation
    gpu_count = 1

    # GPU configuration summary
    print(f"GPU rendering enabled: {gpu_count} GPUs available, mode={args.gpu_mode}")
    print(f"  Instances will be distributed round-robin across GPUs")
    print(f"  ! Due to a known NVIDIA driver bug, only GPU 0 can be used for now. See Docs->Known Issue(s) for details")
    print(f"  ! https://solaris-wm.github.io/solaris-engine/getting_started.html#known-issue-s")
    for i in range(total_instances):
        gpu_id = i % gpu_count
        print(f"    Instance {i}: GPU {gpu_id}")

    max_instances = 8 // args.num_players
    if total_instances > max_instances:
        raise ValueError(
            f"total_instances={total_instances} exceeds the NVENC limit of 8 "
            f"simultaneous encoding sessions per GPU "
            f"({args.num_players} cameras/instance → {max_instances} instances max)."
        )

    # Validate that all skin PNGs have pre-cached .customskin files
    skins_dir = Path(project_root) / "server" / "skins"
    if skins_dir.is_dir():
        missing = [
            p.name for p in sorted(skins_dir.glob("*.png"))
            if not p.with_suffix(p.suffix + ".customskin").exists()
        ]
        if missing:
            raise FileNotFoundError(
                f"Missing .customskin cache files for: {', '.join(missing)}. "
                f"Run: python3 regenerate_skin_cache.py {skins_dir}"
            )
    else:
        raise FileNotFoundError(f"Skins directory not found: {skins_dir}")

    print(f"Generating {total_instances} Docker Compose configurations...")

    for i in range(total_instances):
        world_type = world_plan[i]
        # Calculate cpuset string for this instance if CPU pinning is enabled
        instance_cpuset = None
        cpusets_camera = None

        # Calculate GPU assignment for this instance (round-robin across available GPUs)
        gpu_device_id = i % gpu_count

        # When advancements are disabled server-side, popups cannot appear,
        # so the bootstrap wait (originally needed to let popups clear) is skipped.
        effective_bootstrap_wait_time = (
            0
            if args.disable_advancements == "true"
            else args.bootstrap_wait_time
        )

        config = generate_compose_config(
            i,
            args.base_port,
            args.base_rcon_port,
            args.act_recorder_port,
            args.coord_port,
            args.data_dir,
            args.output_dir,
            args.num_episodes,
            args.episode_start_id,
            effective_bootstrap_wait_time,
            args.episode_category,
            args.episode_types,
            args.smoke_test,
            args.viewer_rendering_disabled,
            world_type,
            str(args.render_distance),
            str(args.simulation_distance),
            str(args.graphics_mode),
            # per-player
            players=players,
            skins=args.skins,
            camera_output_bases=args.camera_output_bases,
            camera_data_bases=args.camera_data_bases,
            camera_vnc_bases=args.camera_vnc_bases,
            camera_novnc_bases=args.camera_novnc_bases,
            display_base=args.display_base,
            vnc_step=args.vnc_step,
            display_step=args.display_step,
            # CPU pinning
            cpuset=instance_cpuset,
            cpusets_camera=cpusets_camera,
            # GPU settings
            gpu_device_id=gpu_device_id,
            gpu_mode=args.gpu_mode,
            disable_nvenc=bool(args.disable_nvenc),
            # Eval options
            eval_time_set_day=args.eval_time_set_day,
            # Flatland options
            flatland_world_disable_structures=bool(
                args.flatland_world_disable_structures
            ),
            # Advancement options
            disable_advancements=(args.disable_advancements == "true"),
            camera_encoder=args.camera_encoder,
        )

        # Write compose file
        compose_file = compose_dir / f"docker-compose-{i:03d}.yml"
        with open(compose_file, "w") as f:
            yaml.dump(config, f, default_flow_style=False, sort_keys=False)

        # For flat worlds, inject generator settings into the compose file
        if world_type == "flat":
            terrain_options = [
                ("plains", "grass_block"),
                ("windswept_hills", "grass_block"),
                ("snowy_plains", "snow"),
                ("desert", "sand"),
                ("desert", "red_sand"),
            ]
            biome, surface_block = terrain_options[i % len(terrain_options)]
            terrain_settings = generate_terrain_settings(biome, surface_block)

            layers_json = []
            for layer in terrain_settings["layers"]:
                layer_str = (
                    f'{{ "block": "{layer["block"]}", "height": {layer["height"]} }}'
                )
                layers_json.append(layer_str)
            layers_str = ",\n    ".join(layers_json)
            biome_val = terrain_settings["biome"]
            terrain_json = f'{{\n  "layers": [\n    {layers_str}\n  ],\n  "biome": "{biome_val}"\n}}'
            newline = "\n"
            terrain_multiline = (
                f">-\n        {terrain_json.replace(newline, newline + '        ')}"
            )

            with open(compose_file, "r") as f:
                content = f.read()
            content = re.sub(
                r"GENERATOR_SETTINGS: TERRAIN_SETTINGS_PLACEHOLDER",
                f"GENERATOR_SETTINGS: {terrain_multiline}",
                content,
            )
            with open(compose_file, "w") as f:
                f.write(content)

        # Create necessary directories
        os.makedirs(f"{args.data_dir}/{i}", exist_ok=True)
        # Camera output/data per-instance dirs
        cp = camera_paths(
            i,
            players,
            args.camera_output_bases,
            args.camera_data_bases,
        )
        for name in players:
            key = name.lower()
            os.makedirs(cp[f"{key}_output_host"], exist_ok=True)
            os.makedirs(cp[f"{key}_data_host"], exist_ok=True)

        print(f"Generated: {compose_file}")

    # Create shared output directory
    os.makedirs(args.output_dir, exist_ok=True)

    print(f"\nGenerated {total_instances} configurations in {compose_dir}/")
    print("Published port ranges (host network):")
    print(
        f"  Minecraft servers: {args.base_port}-{args.base_port + total_instances - 1}"
    )
    print(
        f"  RCON ports: {args.base_rcon_port}-{args.base_rcon_port + total_instances - 1}"
    )
    # Collision validation for camera ports (per-player)
    for name, vnc_base, novnc_base in zip(
        players, args.camera_vnc_bases, args.camera_novnc_bases
    ):
        vncs = {vnc_base + args.vnc_step * i for i in range(total_instances)}
        novncs = {novnc_base + args.vnc_step * i for i in range(total_instances)}
        assert len(vncs) == total_instances, f"{name} VNC port collisions detected"
        assert len(novncs) == total_instances, f"{name} noVNC port collisions detected"
    for name, base in zip(players, args.camera_novnc_bases):
        print(
            f"  Camera {name} noVNC: {base}..{base + args.vnc_step * (total_instances - 1)}"
        )
    print(
        "Bridge network services (act_recorder, controller) use internal communication only."
    )


if __name__ == "__main__":
    main()
