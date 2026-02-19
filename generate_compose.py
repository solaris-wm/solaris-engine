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


def absdir(path: str) -> str:
    """Return an absolute path.

    If `path` is relative, it's resolved against the current working directory.
    """
    if os.path.isabs(path):
        return path
    return os.path.abspath(os.path.join(os.getcwd(), path))


def camera_paths(
    instance_id: int,
    alpha_base: str,
    bravo_base: str,
    data_alpha_base: str,
    data_bravo_base: str,
) -> dict:
    return {
        "alpha_output_host": os.path.join(alpha_base, str(instance_id)),
        "bravo_output_host": os.path.join(bravo_base, str(instance_id)),
        "alpha_data_host": os.path.join(data_alpha_base, str(instance_id)),
        "bravo_data_host": os.path.join(data_bravo_base, str(instance_id)),
    }


def camera_ports(
    instance_id: int,
    alpha_vnc_base: int,
    alpha_novnc_base: int,
    bravo_vnc_base: int,
    bravo_novnc_base: int,
    display_base: int,
    vnc_step: int,
    display_step: int,
) -> dict:
    return {
        "alpha_vnc": alpha_vnc_base + vnc_step * instance_id,
        "alpha_novnc": alpha_novnc_base + vnc_step * instance_id,
        "bravo_vnc": bravo_vnc_base + vnc_step * instance_id,
        "bravo_novnc": bravo_novnc_base + vnc_step * instance_id,
        "alpha_display": f":{display_base + display_step * instance_id}",
        "bravo_display": f":{display_base + display_step * instance_id + 1}",
    }


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
    # camera specific
    camera_output_alpha_base,
    camera_output_bravo_base,
    camera_data_alpha_base,
    camera_data_bravo_base,
    camera_alpha_vnc_base,
    camera_alpha_novnc_base,
    camera_bravo_vnc_base,
    camera_bravo_novnc_base,
    display_base,
    vnc_step,
    display_step,
    # CPU pinning
    cpuset: Optional[str] = None,
    cpuset_camera_alpha: Optional[str] = None,
    cpuset_camera_bravo: Optional[str] = None,
    # GPU settings
    gpu_device_id: Optional[int] = None,
    gpu_mode: str = "egl",
    # Eval options
    eval_time_set_day: int = 0,
    # Flatland options
    flatland_world_disable_structures: bool = False,
):
    """Generate a Docker Compose configuration for a single instance."""

    # Calculate ports for this instance
    mc_port = base_port + instance_id
    rcon_port = base_rcon_port + instance_id

    # Directories - each instance gets its own data subdirectory
    data_dir = f"{data_dir_base}/{instance_id}"

    cam_paths = camera_paths(
        instance_id,
        camera_output_alpha_base,
        camera_output_bravo_base,
        camera_data_alpha_base,
        camera_data_bravo_base,
    )
    cam_ports = camera_ports(
        instance_id,
        camera_alpha_vnc_base,
        camera_alpha_novnc_base,
        camera_bravo_vnc_base,
        camera_bravo_novnc_base,
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
    config = {
        "networks": {f"mc_network_{instance_id}": {"driver": "bridge"}},
        "services": {
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
                    "chmod -R 777 /data/plugins /data/skins",
                ],
                "volumes": [
                    f"{data_dir}:/data",
                    f"{project_root}/server/plugins:/source_plugins:ro",
                    f"{project_root}/server/skins:/source_skins:ro",
                ],
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
            f"controller_alpha_instance_{instance_id}": {
                "image": "solaris-engine-base:latest",
                "build": {
                    "context": project_root,
                    "dockerfile": "Dockerfile",
                },
                "depends_on": {
                    f"mc_instance_{instance_id}": {"condition": "service_healthy"},
                    f"act_recorder_alpha_instance_{instance_id}": {
                        "condition": "service_started"
                    },
                },
                **({"cpuset": cpuset} if cpuset else {}),
                "volumes": [f"{output_dir}:/output"],
                "environment": {
                    "BOT_NAME": "Alpha",
                    "OTHER_BOT_NAME": "Bravo",
                    "ACT_RECORDER_HOST": f"act_recorder_alpha_instance_{instance_id}",
                    "ACT_RECORDER_PORT": act_recorder_port,
                    "COORD_PORT": coord_port,
                    "OTHER_COORD_HOST": f"controller_bravo_instance_{instance_id}",
                    "OTHER_COORD_PORT": coord_port,
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
                    "TELEPORT_RADIUS": 50000,
                    "WORLD_TYPE": str(world_type).lower(),
                    "SMOKE_TEST": smoke_test,
                    "INSTANCE_ID": instance_id,
                    "OUTPUT_DIR": "/output",
                    "EVAL_TIME_SET_DAY": eval_time_set_day,
                },
                "extra_hosts": ["host.docker.internal:host-gateway"],
                "networks": [f"mc_network_{instance_id}"],
                "command": "./controller/entrypoint.sh",
            },
            f"controller_bravo_instance_{instance_id}": {
                "image": "solaris-engine-base:latest",
                "build": {
                    "context": project_root,
                    "dockerfile": "Dockerfile",
                },
                "depends_on": {
                    f"mc_instance_{instance_id}": {"condition": "service_healthy"},
                    f"act_recorder_bravo_instance_{instance_id}": {
                        "condition": "service_started"
                    },
                    f"controller_alpha_instance_{instance_id}": {
                        "condition": "service_started"
                    },
                },
                **({"cpuset": cpuset} if cpuset else {}),
                "volumes": [f"{output_dir}:/output"],
                "environment": {
                    "BOT_NAME": "Bravo",
                    "OTHER_BOT_NAME": "Alpha",
                    "ACT_RECORDER_HOST": f"act_recorder_bravo_instance_{instance_id}",
                    "ACT_RECORDER_PORT": act_recorder_port,
                    "COORD_PORT": coord_port,
                    "OTHER_COORD_HOST": f"controller_alpha_instance_{instance_id}",
                    "OTHER_COORD_PORT": coord_port,
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
                    "TELEPORT_RADIUS": 250,
                    "WORLD_TYPE": str(world_type).lower(),
                    "SMOKE_TEST": smoke_test,
                    "INSTANCE_ID": instance_id,
                    "OUTPUT_DIR": "/output",
                    "EVAL_TIME_SET_DAY": eval_time_set_day,
                },
                "extra_hosts": ["host.docker.internal:host-gateway"],
                "networks": [f"mc_network_{instance_id}"],
                "command": "./controller/entrypoint.sh",
            },
            f"act_recorder_alpha_instance_{instance_id}": {
                "image": "solaris-engine-base:latest",
                "environment": {
                    "PORT": act_recorder_port,
                    "NAME": "Alpha",
                    "INSTANCE_ID": instance_id,
                    "EPISODE_START_ID": episode_start_id,
                    "VIEWER_RENDERING_DISABLED": viewer_rendering_disabled,
                },
                "tty": True,
                **({"cpuset": cpuset} if cpuset else {}),
                "volumes": [f"{output_dir}:/output"],
                "networks": [f"mc_network_{instance_id}"],
                "command": "./controller/act_recorder/entrypoint.sh",
            },
            f"act_recorder_bravo_instance_{instance_id}": {
                "image": "solaris-engine-base:latest",
                "environment": {
                    "PORT": act_recorder_port,
                    "NAME": "Bravo",
                    "INSTANCE_ID": instance_id,
                    "EPISODE_START_ID": episode_start_id,
                    "VIEWER_RENDERING_DISABLED": viewer_rendering_disabled,
                },
                "tty": True,
                **({"cpuset": cpuset} if cpuset else {}),
                "volumes": [f"{output_dir}:/output"],
                "networks": [f"mc_network_{instance_id}"],
                "command": "./controller/act_recorder/entrypoint.sh",
            },
            # Camera alpha: recording client
            f"camera_alpha_instance_{instance_id}": {
                "image": "solaris-engine-camera:latest",
                "build": {
                    "context": os.path.join(project_root, "camera"),
                    "dockerfile": "Dockerfile",
                },
                "restart": "unless-stopped",
                "network_mode": "host",
                **({"cpuset": cpuset_camera_alpha} if cpuset_camera_alpha else {}),
                "depends_on": {
                    f"mc_instance_{instance_id}": {"condition": "service_healthy"}
                },
                "environment": {
                    "MC_VERSION": "1.21",
                    "MC_HOST": "127.0.0.1",
                    "MC_PORT": mc_port,
                    "CAMERA_NAME": "CameraAlpha",
                    "DISPLAY": cam_ports["alpha_display"],
                    "VNC_PORT": str(cam_ports["alpha_vnc"]),
                    "NOVNC_PORT": str(cam_ports["alpha_novnc"]),
                    "WIDTH": "1280",
                    "HEIGHT": "720",
                    "FPS": "20",
                    "VNC_PASSWORD": "research",
                    "ENABLE_RECORDING": "1",
                    "RECORDING_PATH": "/output/camera_alpha.mkv",
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
                    f"{cam_paths['alpha_data_host']}:/root",
                    f"{cam_paths['alpha_output_host']}:/output",
                ],
            },
            # Plugin starter: waits for all players then triggers episode start
            f"plugin_starter_instance_{instance_id}": {
                "image": "node:20",
                "network_mode": "host",
                **({"cpuset": cpuset} if cpuset else {}),
                "depends_on": {
                    f"mc_instance_{instance_id}": {"condition": "service_healthy"},
                    f"camera_alpha_instance_{instance_id}": {
                        "condition": "service_started"
                    },
                },
                "working_dir": "/app",
                "environment": {
                    "RCON_HOST": "127.0.0.1",
                    "RCON_PORT": rcon_port,
                    "RCON_PASSWORD": "research",
                    "EPISODE_START_RETRIES": "300",
                    "EPISODE_REQUIRED_PLAYERS": "Alpha,CameraAlpha,Bravo,CameraBravo,SpectatorAlpha,SpectatorBravo",
                    "EPISODE_START_COMMAND": "episode start Alpha CameraAlpha technoblade.png Bravo CameraBravo test.png",
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
            },
            # Camera bravo: recording client
            f"camera_bravo_instance_{instance_id}": {
                "image": "solaris-engine-camera:latest",
                "build": {
                    "context": os.path.join(project_root, "camera"),
                    "dockerfile": "Dockerfile",
                },
                "restart": "unless-stopped",
                "network_mode": "host",
                **({"cpuset": cpuset_camera_bravo} if cpuset_camera_bravo else {}),
                "depends_on": {
                    f"mc_instance_{instance_id}": {"condition": "service_healthy"}
                },
                "environment": {
                    "MC_VERSION": "1.21",
                    "MC_HOST": "127.0.0.1",
                    "MC_PORT": mc_port,
                    "CAMERA_NAME": "CameraBravo",
                    "DISPLAY": cam_ports["bravo_display"],
                    "VNC_PORT": str(cam_ports["bravo_vnc"]),
                    "NOVNC_PORT": str(cam_ports["bravo_novnc"]),
                    "WIDTH": "1280",
                    "HEIGHT": "720",
                    "FPS": "20",
                    "VNC_PASSWORD": "research",
                    "ENABLE_RECORDING": "1",
                    "RECORDING_PATH": "/output/camera_bravo.mkv",
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
                    f"{cam_paths['bravo_data_host']}:/root",
                    f"{cam_paths['bravo_output_host']}:/output",
                ],
            },
            # Passive spectator alpha
            f"spectator_alpha_instance_{instance_id}": {
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
                    "MC_USERNAME": "SpectatorAlpha",
                },
                "extra_hosts": [
                    "host.docker.internal:host-gateway",
                ],
                "networks": [f"mc_network_{instance_id}"],
                "command": ["node", "spectator/spectator.js"],
            },
            # Passive spectator bravo
            f"spectator_bravo_instance_{instance_id}": {
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
                    "MC_USERNAME": "SpectatorBravo",
                },
                "extra_hosts": [
                    "host.docker.internal:host-gateway",
                ],
                "networks": [f"mc_network_{instance_id}"],
                "command": ["node", "spectator/spectator.js"],
            },
        },
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
    # Camera-specific bases (absolute paths)
    parser.add_argument(
        "--camera_output_alpha_base",
        required=True,
        help="Absolute base dir for per-instance Camera Alpha outputs (e.g., /abs/.../camera/output_alpha)",
    )
    parser.add_argument(
        "--camera_output_bravo_base",
        required=True,
        help="Absolute base dir for per-instance Camera Bravo outputs (e.g., /abs/.../camera/output_bravo)",
    )
    parser.add_argument(
        "--camera_data_alpha_base",
        default=None,
        help="Absolute base dir for per-instance Camera Alpha data (default: <project>/camera/data_alpha)",
    )
    parser.add_argument(
        "--camera_data_bravo_base",
        default=None,
        help="Absolute base dir for per-instance Camera Bravo data (default: <project>/camera/data_bravo)",
    )
    parser.add_argument("--camera_alpha_vnc_base", type=int, default=5901)
    parser.add_argument("--camera_alpha_novnc_base", type=int, default=6901)
    parser.add_argument("--camera_bravo_vnc_base", type=int, default=5902)
    parser.add_argument("--camera_bravo_novnc_base", type=int, default=6902)
    parser.add_argument("--display_base", type=int, default=99)
    parser.add_argument("--vnc_step", type=int, default=2)
    parser.add_argument("--display_step", type=int, default=2)
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

    args = parser.parse_args()
    # Ensure required dirs are absolute
    args.output_dir = absdir(args.output_dir)
    args.data_dir = absdir(args.data_dir)
    args.camera_output_alpha_base = absdir(args.camera_output_alpha_base)
    args.camera_output_bravo_base = absdir(args.camera_output_bravo_base)

    # Defaults for camera data bases
    project_root = str(Path(__file__).resolve().parent)
    if args.camera_data_alpha_base is None:
        args.camera_data_alpha_base = absdir(
            os.path.join(project_root, "camera", "data_alpha")
        )
    else:
        args.camera_data_alpha_base = absdir(args.camera_data_alpha_base)
    if args.camera_data_bravo_base is None:
        args.camera_data_bravo_base = absdir(
            os.path.join(project_root, "camera", "data_bravo")
        )
    else:
        args.camera_data_bravo_base = absdir(args.camera_data_bravo_base)

    # Create compose directory
    compose_dir = Path(args.compose_dir)
    compose_dir.mkdir(exist_ok=True)

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
    for i in range(total_instances):
        gpu_id = i % gpu_count
        print(f"    Instance {i}: GPU {gpu_id}")

    print(f"Generating {total_instances} Docker Compose configurations...")

    for i in range(total_instances):
        world_type = world_plan[i]
        # Calculate cpuset string for this instance if CPU pinning is enabled
        instance_cpuset = None
        camera_alpha_cpuset = None
        camera_bravo_cpuset = None

        # Calculate GPU assignment for this instance (round-robin across available GPUs)
        gpu_device_id = i % gpu_count

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
            args.bootstrap_wait_time,
            args.episode_category,
            args.episode_types,
            args.smoke_test,
            args.viewer_rendering_disabled,
            world_type,
            str(args.render_distance),
            str(args.simulation_distance),
            str(args.graphics_mode),
            # camera args
            args.camera_output_alpha_base,
            args.camera_output_bravo_base,
            args.camera_data_alpha_base,
            args.camera_data_bravo_base,
            args.camera_alpha_vnc_base,
            args.camera_alpha_novnc_base,
            args.camera_bravo_vnc_base,
            args.camera_bravo_novnc_base,
            args.display_base,
            args.vnc_step,
            args.display_step,
            # CPU pinning
            cpuset=instance_cpuset,
            cpuset_camera_alpha=camera_alpha_cpuset,
            cpuset_camera_bravo=camera_bravo_cpuset,
            # GPU settings
            gpu_device_id=gpu_device_id,
            gpu_mode=args.gpu_mode,
            # Eval options
            eval_time_set_day=args.eval_time_set_day,
            # Flatland options
            flatland_world_disable_structures=bool(
                args.flatland_world_disable_structures
            ),
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
            args.camera_output_alpha_base,
            args.camera_output_bravo_base,
            args.camera_data_alpha_base,
            args.camera_data_bravo_base,
        )
        os.makedirs(cp["alpha_output_host"], exist_ok=True)
        os.makedirs(cp["bravo_output_host"], exist_ok=True)
        os.makedirs(cp["alpha_data_host"], exist_ok=True)
        os.makedirs(cp["bravo_data_host"], exist_ok=True)

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
    # Collision validation for camera ports
    alpha_vncs = {
        args.camera_alpha_vnc_base + args.vnc_step * i for i in range(total_instances)
    }
    alpha_novncs = {
        args.camera_alpha_novnc_base + args.vnc_step * i for i in range(total_instances)
    }
    bravo_vncs = {
        args.camera_bravo_vnc_base + args.vnc_step * i for i in range(total_instances)
    }
    bravo_novncs = {
        args.camera_bravo_novnc_base + args.vnc_step * i for i in range(total_instances)
    }
    assert len(alpha_vncs) == total_instances, "alpha VNC port collisions detected"
    assert len(alpha_novncs) == total_instances, "alpha noVNC port collisions detected"
    assert len(bravo_vncs) == total_instances, "bravo VNC port collisions detected"
    assert len(bravo_novncs) == total_instances, "bravo noVNC port collisions detected"
    print(
        f"  Camera Alpha noVNC: {args.camera_alpha_novnc_base}..{args.camera_alpha_novnc_base + args.vnc_step * (total_instances - 1)}"
    )
    print(
        f"  Camera Bravo noVNC: {args.camera_bravo_novnc_base}..{args.camera_bravo_novnc_base + args.vnc_step * (total_instances - 1)}"
    )
    print(
        "Bridge network services (act_recorder, controller) use internal communication only."
    )


if __name__ == "__main__":
    main()
