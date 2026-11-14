CLI
===

Entry Point
-----------

This page describes the main command-line entry points for data collection: ``run.sh`` (training data) and ``run_evals.sh`` (evaluation data).

.. _run-sh:

``run.sh``
----------------------------------

`[Source] <https://github.com/solaris-wm/solaris-engine/blob/dev/run.sh>`_

Runs the full training data collection pipeline. It works sequentially in batches. For each batch, it generates compose configs, starts Minecraft instances, collects episodes, and postprocesses them. When all batches are ready, it transforms, validates, and combines all of them into the final training dataset.

Usage
~~~~~

.. code-block:: bash

   ./run.sh [OPTIONS]

Options
~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 25 15 60

   * - Option
     - Default
     - Description
   * - ``--output-dir DIR``
     - ``output2``
     - Base data directory for outputs
   * - ``--num-batches N``
     - ``2``
     - Number of batches to run
   * - ``--start-batch N``
     - ``0``
     - Batch index to start from. Use to split batches across machines without collisions (machine A runs ``--start-batch 0 --num-batches 5``, machine B runs ``--start-batch 5 --num-batches 5``, etc.).
   * - ``--num-flat-world N``
     - ``1``
     - Number of flat worlds per batch
   * - ``--num-normal-world N``
     - ``1``
     - Number of normal worlds per batch
   * - ``--num-episodes N``
     - ``2``
     - Number of episodes per batch (ignored when ``--smoke-test 1``)
   * - ``--num-players N``
     - ``2``
     - Number of player bots per instance. Each instance spawns ``N`` controller, camera, spectator, and ``act_recorder`` containers (plus a single Minecraft server). The NVENC encoder cap of 8 sessions/GPU also bounds the per-instance count: max ``floor(8 / N)`` instances. ``run.sh`` works out of the box for up to 3 players (skins are bundled for Alpha, Bravo, and Charlie); 4 to 8 players are untested and require calling :ref:`generate_compose.py <generate-compose-py>` directly with ``--skins``; more than 8 is not supported. With more than 2 players, only episode types that declare ``SUPPORTS_N_PLAYER`` are scheduled (currently ``chaseNp``, ``walkLookNp``, ``buildTowerNp``).
   * - ``--dataset-name NAME``
     - ``multiplayer``
     - Name of the output dataset under ``<output-dir>/datasets/``
   * - ``--filter-water-episodes true|false``
     - ``true``
     - Whether to detect and exclude water episodes from the train dataset (see :ref:`Water filtering <run-sh-water-filtering>`)
   * - ``--disable-advancements true|false``
     - ``true``
     - Disable Minecraft advancement pop-ups server-wide via ``spigot.yml``. When ``true``, the controller bootstrap-popup wait is overridden to ``0`` since popups cannot appear.
   * - ``--encoder ENCODER``
     - ``auto``
     - Video encoder used for camera recording and postprocessing: ``auto``, ``libx264`` (CPU), or ``h264_nvenc`` (NVIDIA NVENC). With ``auto``, the camera container probes NVENC with a one-frame test encode and falls back to ``libx264`` on GPUs without NVENC silicon (e.g. A100/H100), and postprocessing uses ``libx264``. Passing ``libx264`` or ``h264_nvenc`` forces that encoder for both stages.
   * - ``--postprocess-workers N``
     - ``8``
     - Number of parallel postprocess workers. Capped at ``8`` when ``--encoder h264_nvenc`` is selected, since NVENC supports at most 8 concurrent encoding sessions per GPU.
   * - ``--smoke-test 0|1``
     - ``0``
     - When ``1``, run one episode per eligible episode type in alphabetical order. ``--num-episodes`` is ignored. Useful for catching regressions across the full episode catalog quickly.
   * - ``-h``, ``--help``
     -
     - Show usage and exit

.. _run-sh-water-filtering:

Water filtering
~~~~~~~~~~~~~~~

When ``--filter-water-episodes true`` (the default), the script:

1. After all batches complete, runs :ref:`detect_water_episodes_batch.py <detect-water-episodes-batch-py>` to detect episodes where any player shows underwater indicators (oxygen bar HUD). Results are written to ``<output-dir>/data_collection/train/water_episodes.json``.

2. After ``prepare_train_dataset.py`` runs, runs :ref:`filter_dataset.py <filter-dataset-py>` to move detected water episodes into a ``<output-dir>/datasets/<dataset-name>/discarded/`` subdirectory, excluding them from the train dataset.

Use ``--filter-water-episodes false`` to skip detection and filtering and keep all episodes.

.. _run-sh-output-layout:

Output layout
~~~~~~~~~~~~~

Data is written under ``<output-dir>/``. The following tree shows the directory structure. ``<Bot>`` stands for a capitalized NATO phonetic name (``Alpha``, ``Bravo``, ``Charlie``, ...) and ``<bot>`` for its lowercase form; for the default 2‑player run the values are ``Alpha``/``alpha`` and ``Bravo``/``bravo``. With ``--num-players N`` every ``<Bot>`` / ``<bot>`` block below is repeated once per player, drawing names from the NATO phonetic series in order.

.. code-block:: text

   <output-dir>/
   ├── data_collection/
   │   └── train/
   │       ├── batch_<batch_id>/
   │       │   ├── aligned/
   │       │   │   ├── <timestep>_<episode_id>_<Bot>_instance_<instance_id>_camera.mp4         # one per bot
   │       │   │   ├── <timestep>_<episode_id>_<Bot>_instance_<instance_id>_camera_meta.json   # one per bot
   │       │   │   └── ... (other episodes)
   │       │   ├── camera/
   │       │   │   ├── data_<bot>/                                                             # one dir per bot
   │       │   │   │   └── <instance_id>/
   │       │   │   └── output_<bot>/                                                           # one dir per bot
   │       │   │       └── <instance_id>/
   │       │   │           ├── camera_<bot>.mkv
   │       │   │           └── camera_<bot>_meta.json
   │       │   ├── compose_configs/
   │       │   │   ├── docker-compose-<instance_id>.yml
   │       │   │   └── ... (one per instance)
   │       │   ├── data/
   │       │   │   └── <instance_id>/
   │       │   ├── logs/
   │       │   │   └── docker-compose-<instance_id>/
   │       │   │       ├── controller_<bot>_instance_<instance_id>.log                         # one per bot
   │       │   │       ├── camera_<bot>_instance_<instance_id>.log                             # one per bot
   │       │   │       ├── act_recorder_<bot>_instance_<instance_id>.log                       # one per bot
   │       │   │       ├── mc_instance_<instance_id>.log
   │       │   │       └── ...
   │       │   └── output/
   │       │       ├── <timestep>_<episode_id>_<Bot>_instance_<instance_id>.json               # one per bot
   │       │       ├── <timestep>_<episode_id>_<Bot>_instance_<instance_id>_meta.json          # one per bot
   │       │       ├── <timestep>_<episode_id>_<Bot>_instance_<instance_id>_episode_info.json  # one per bot
   │       │       └── ... (other episodes)
   │       └── water_episodes.json
   └── datasets/
       └── <dataset-name>/
           ├── train/
           │   ├── batch_<batch_id>_<episode_id>_<Bot>_instance_<instance_id>.mp4              # one per bot
           │   ├── batch_<batch_id>_<episode_id>_<Bot>_instance_<instance_id>.json             # one per bot
           │   ├── batch_<batch_id>_<episode_id>_<Bot>_instance_<instance_id>_episode_info.json
           │   └── ... (other episodes)
           ├── test/
           │   └── (same file patterns as train/)
           ├── annotated/
           │   └── batch_<batch_id>_<episode_id>_instance_<instance_id>.mp4_combined.mp4
           └── discarded/
               └── (water episodes moved here)

.. list-table::
   :header-rows: 1
   :widths: 45 55

   * - Path (relative to ``<output-dir>``)
     - Description
   * - ``data_collection/train/batch_<batch_id>/aligned/``
     - Per-episode aligned camera videos and metadata, one pair per bot: ``<timestep>_<episode_id>_<Bot>_instance_<instance_id>_camera.mp4`` and ``<timestep>_<episode_id>_<Bot>_instance_<instance_id>_camera_meta.json``. Produced by :ref:`process_recordings.py <process-recordings-py>` (called once per bot).
   * - ``data_collection/train/batch_<batch_id>/camera/data_<bot>/<instance_id>/``
     - Minecraft client home directory for the camera bot ``<bot>``. Contains ``.minecraft/`` and client runtime data. One directory per bot.
   * - ``data_collection/train/batch_<batch_id>/camera/output_<bot>/<instance_id>/``
     - Raw camera recordings and metadata for bot ``<bot>``: ``camera_<bot>.mkv``, ``camera_<bot>_meta.json``. One directory per bot. Input to :ref:`process_recordings.py <process-recordings-py>`.
   * - ``data_collection/train/batch_<batch_id>/compose_configs/docker-compose-<instance_id>.yml``
     - Generated Docker Compose file. Produced by :ref:`generate_compose.py <generate-compose-py>`.
   * - ``data_collection/train/batch_<batch_id>/data/<instance_id>/``
     - Minecraft server data (world, config, logs).
   * - ``data_collection/train/batch_<batch_id>/logs/docker-compose-<instance_id>/``
     - Docker logs for every service: one ``controller_<bot>_instance_<instance_id>.log`` / ``camera_<bot>_instance_<instance_id>.log`` / ``act_recorder_<bot>_instance_<instance_id>.log`` per bot, plus the shared ``mc_instance_<instance_id>.log`` and ``spectator_*`` logs.
   * - ``data_collection/train/batch_<batch_id>/output/``
     - Controller actions (see :ref:`Action file format <action-file-format>`), one set per bot: ``<timestep>_<episode_id>_<Bot>_instance_<instance_id>.json`` is copied to the final dataset folder as-is. Episode metadata ``<timestep>_<episode_id>_<Bot>_instance_<instance_id>_meta.json``, and episode info (see :ref:`Episode info file format <episode-info-file-format>`) ``<timestep>_<episode_id>_<Bot>_instance_<instance_id>_episode_info.json`` is also copied to the final dataset folder as-is.
   * - ``data_collection/train/water_episodes.json``
     - (When water filtering enabled) List of detected water episodes for :ref:`filter_dataset.py <filter-dataset-py>`.
   * - ``datasets/<dataset-name>/train/``, ``test/``
     - Prepared splits: ``batch_<batch_id>_<episode_id>_<Bot>_instance_<instance_id>.mp4`` plus its action JSON (see :ref:`Action file format <action-file-format>`) and episode info JSON (see :ref:`Episode info file format <episode-info-file-format>`), one set per bot. Produced by :ref:`prepare_train_dataset.py <prepare-train-dataset-py>` and :ref:`split_train_test.py <split-train-test-py>`.
   * - ``datasets/<dataset-name>/annotated/``
     - Debug videos with overlaid actions (per‑player views vertically stacked in alphabetical bot‑name order). Produced by :ref:`annotate_video_batch.py <annotate-video-batch-py>`.
   * - ``datasets/<dataset-name>/discarded/``
     - Episodes excluded by water filtering (when enabled).

.. _action-file-format:

Action file format
~~~~~~~~~~~~~~~~~~

Action files are named ``*_<Bot>_instance_*.json`` (one per bot, with ``<Bot>`` drawn from the NATO phonetic series — e.g. ``*_Alpha_instance_*.json``, ``*_Bravo_instance_*.json``, ``*_Charlie_instance_*.json`` for a 3‑player run). Each contains a JSON array of per-frame objects, one per timestep:

.. code-block:: json

   [
     {
       "x": -4425.5,
       "y": 64,
       "z": 2298.5,
       "yaw": 4.636,
       "pitch": 0,
       "action": {
         "forward": false,
         "back": false,
         "left": false,
         "right": false,
         "jump": false,
         "sprint": false,
         "sneak": false,
         "camera": [0, 0],
         "attack": false,
         "use": false,
         "mount": false,
         "dismount": false,
         "place_block": false,
         "place_entity": false,
         "mine": false,
         "hotbar.1": false,
         "hotbar.2": false,
         "hotbar.3": false,
         "hotbar.4": false,
         "hotbar.5": false,
         "hotbar.6": false,
         "hotbar.7": false,
         "hotbar.8": false,
         "hotbar.9": false
       },
       "inventory": {
         "quickBarSlot": 4,
         "mainInventory": [],
         "heldItem": null,
         "offHandItem": null,
         "hotbar": [
           {
             "type": 1,
             "count": 64,
             "name": "stone",
             "displayName": "Stone",
             "slot": 36
           },
           {
             "type": 840,
             "count": 1,
             "name": "diamond_pickaxe",
             "displayName": "Diamond Pickaxe",
             "slot": 37
           }
         ]
       },
       "renderTime": 1770812761734,
       "physicsTime": 276613.613413,
       "relativeTimeMs": 0.0,
       "epochTime": 1770812761.734,
       "worldAgeTicks": 5649,
       "isInWater": false,
       "frame_count": 0,
       "episode_id": 0,
       "extra_info": {
         "seed": 42
       }
     }
   ]

The array contains one such object per frame.

.. _yaw-pitch-conventions:

Yaw and pitch conventions
^^^^^^^^^^^^^^^^^^^^^^^^^

The ``yaw``, ``pitch``, and ``action.camera`` fields are recorded in `Mineflayer <https://github.com/PrismarineJS/mineflayer>`_'s **internal** camera convention (radians), not Minecraft's native (Notchian) convention. ``action.camera`` is ``[Δyaw, Δpitch]`` relative to the previous recorded frame (shortest-arc for yaw), in the same units and convention.

The internal convention matches standard 3D-math / OpenGL-style conventions (Y-up, −Z-forward, CCW positive yaw about +Y, positive pitch = looking up). Minecraft's wire protocol uses the opposite convention on both axes: 0 yaw = South (+Z), CW positive, and positive pitch = looking down.

**Yaw**

.. list-table::
   :header-rows: 1
   :widths: 25 35 35

   * -
     - Internal (recorded)
     - Notchian (Minecraft)
   * - Units
     - radians
     - degrees
   * - Range
     - ``[0, 2π)``
     - ``(-180°, 180°]`` typical
   * - Zero direction
     - North (−Z)
     - South (+Z)
   * - Rotation sense (viewed from +Y)
     - CCW positive
     - CW positive
   * - North (−Z)
     - ``0``
     - ``180°``
   * - East (+X)
     - ``3π/2`` (≈ ``4.712``)
     - ``-90°`` / ``270°``
   * - South (+Z)
     - ``π`` (≈ ``3.142``)
     - ``0°``
   * - West (−X)
     - ``π/2`` (≈ ``1.571``)
     - ``90°``

**Pitch**

.. list-table::
   :header-rows: 1
   :widths: 25 35 35

   * -
     - Internal (recorded)
     - Notchian (Minecraft)
   * - Units
     - radians
     - degrees
   * - Range
     - ``[-π/2, π/2]``
     - ``[-90°, 90°]``
   * - Horizon
     - ``0``
     - ``0°``
   * - Looking up
     - positive (``+π/2`` = straight up)
     - **negative** (``-90°`` = straight up)
   * - Looking down
     - negative (``-π/2`` = straight down)
     - **positive** (``+90°`` = straight down)

**Conversion functions**

.. code-block:: javascript

   const PI = Math.PI
   const TO_DEG = 180 / PI
   const TO_RAD = PI / 180

   // Internal (radians) → Notchian (degrees)
   function internalToNotchian (yawRad, pitchRad) {
     let yawDeg = (PI - yawRad) * TO_DEG
     // Normalize to (-180, 180]
     yawDeg = ((yawDeg + 180) % 360 + 360) % 360 - 180
     const pitchDeg = -pitchRad * TO_DEG
     return [yawDeg, pitchDeg]
   }

   // Notchian (degrees) → internal (radians)
   function notchianToInternal (yawDeg, pitchDeg) {
     const raw = (PI - yawDeg * TO_RAD)
     // Wrap to [0, 2π)
     const yawRad = ((raw % (2 * PI)) + 2 * PI) % (2 * PI)
     const pitchRad = -pitchDeg * TO_RAD
     return [yawRad, pitchRad]
   }

These match the formulas used in ``mineflayer/lib/conversions.js`` (``toNotchianYaw``, ``fromNotchianYaw``, ``toNotchianPitch``, ``fromNotchianPitch``).

For ``action.camera`` deltas, the ``π`` offset on yaw cancels under subtraction, but the reflection does not — internal yaw rotates CCW while Notchian rotates CW, so any delta flips sign when converting between conventions. Both axes flip:

- ``Δyaw_notchian_deg  = -Δyaw_internal * 180/π``
- ``Δpitch_notchian_deg = -Δpitch_internal * 180/π``

.. _episode-info-file-format:

Episode info file format
~~~~~~~~~~~~~~~~~~~~~~~~

Episode info files (``*_episode_info.json``) contain a single JSON object:

.. code-block:: json

   {
     "timestamp": "2026-02-11T12:25:11.506Z",
     "bot_name": "Alpha",                               // capitalized NATO phonetic name; one episode_info file per bot
     "world_type": "normal",
     "episode_number": 0,
     "episode_type": "mine",
     "instance_id": 1,
     "encountered_error": false,
     "peer_encountered_error": false,
     "bot_died": false,
     "episode_recording_started": true,
     "eval_metadata": {}
   }

.. _run-evals-sh:

``run_evals.sh``
-----------------------------------------

`[Source] <https://github.com/solaris-wm/solaris-engine/blob/dev/run_evals.sh>`_

Runs evaluation data collection for several episode types. It works sequentially per episode type, where an episode type acts as a batch. Just as in :ref:`run.sh <run-sh>`, for each batch, it generates compose configs, starts Minecraft instances, collects episodes, and postprocesses them. When all batches are ready, it prepares each batch (episode type)into a separate evaluation dataset.

Usage
~~~~~

.. code-block:: bash

   ./run_evals.sh [OPTIONS]

Options
~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 25 15 60

   * - Option
     - Default
     - Description
   * - ``--output-dir DIR``
     - ``output``
     - Base data directory for outputs
   * - ``--num-players N``
     - ``2``
     - Number of player bots per instance. All eval episode types are 2-player only, so leave this at ``2``.
   * - ``-h``, ``--help``
     -
     - Show usage and exit

Environment
~~~~~~~~~~~

- ``EVAL_TIME_SET_DAY`` — If set (e.g. ``1``), episode start time is set to day for all eval episodes. Default: ``1``.

Eval episode types
~~~~~~~~~~~~~~~~~~

The script runs one batch per eval type:

- ``rotationEval``
- ``translationEval``
- ``structureEval``
- ``turnToLookEval``
- ``turnToLookOppositeEval``
- ``bothLookAwayEval``
- ``oneLooksAwayEval``

For ``turnToLookEval`` and ``turnToLookOppositeEval`` the script uses 1 normal world and 32 episodes; for the rest, it uses 2 flatland worlds and 16 episodes per type.

Output layout
~~~~~~~~~~~~~

Data is written under ``<output-dir>/``. The following tree shows the directory structure:

.. code-block:: text

   <output-dir>/
   ├── data_collection/
   │   └── eval/
   │       ├── rotationEval/
   │       │   └── ...
   │       ├── translationEval/
   │       │   └── ...
   │       ├── structureEval/
   │       │   └── ...
   │       └── ... (other eval types)
   └── datasets/
       └── eval/
           ├── rotationEval/
           │   └── test/
           │       └── ...
           ├── translationEval/
           │   └── test/
           │       └── ...
           ├── structureEval/
           │   └── test/
           │       └── ...
           └── ... (other eval types)

.. list-table::
   :header-rows: 1
   :widths: 45 55

   * - Path (relative to ``<output-dir>``)
     - Description
   * - ``data_collection/eval/<eval_type>/``
     - Per-type batch directory. Structure under each ``<eval_type>`` (e.g. ``rotationEval``) mirrors ``data_collection/train/batch_<batch_id>/`` in :ref:`run.sh output layout <run-sh-output-layout>`: ``aligned/``, ``camera/``, ``compose_configs/``, ``data/``, ``logs/``, ``output/``. 
   * - ``datasets/eval/<eval_type>/``
     - Prepared eval datasets per type. Each ``<eval_type>`` has only a ``test/`` subdir; structure and file patterns mirror ``datasets/<dataset-name>/test/`` in :ref:`run.sh output layout <run-sh-output-layout>`. Produced by :ref:`prepare_eval_datasets.py <prepare-eval-datasets-py>`.

Postprocessing
--------------

This section covers the postprocessing utilities that run as part of :ref:`run.sh <run-sh>` and :ref:`run_evals.sh <run-evals-sh>`, and turn raw camera recordings and action files into final train/eval datasets and optional annotated videos.

.. _process-recordings-py:

``process_recordings.py``
-------------------------

`[Source] <https://github.com/solaris-wm/solaris-engine/blob/dev/postprocess/process_recordings.py>`_

Aligns raw Minecraft camera recordings with Mineflayer action episode files for a single bot, producing per-episode aligned camera videos. It can operate on a full directory of episodes or a single episode file.

Usage
~~~~~

.. code-block:: bash

   python postprocess/process_recordings.py --actions-dir ACTIONS_DIR --camera-prefix CAMERA_DIR --bot BOT [OPTIONS]

Options
~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 30 15 55

   * - Option
     - Default
     - Description
   * - ``--actions-dir PATH``
     - (required)
     - Directory containing Mineflayer action files (``*.json``).
   * - ``--camera-prefix PATH``
     - (required)
     - Directory containing camera outputs (expects an ``output_<name>/`` subdirectory matching ``--bot``).
   * - ``--bot NAME``
     - (required)
     - Which bot to process. Pass a single capitalized NATO phonetic name (e.g. ``Alpha``, ``Bravo``, ``Charlie``, …). Run the script once per bot to align all players in an N‑player run.
   * - ``--encoder {libx264,h264_nvenc}``
     - ``libx264``
     - ffmpeg encoder used to write aligned videos.
   * - ``--output-dir PATH``
     - ``./aligned/<bot>``
     - Base directory for aligned videos and metadata.
   * - ``--episode-file PATH``
     - ``None``
     - Process a single episode JSON instead of scanning ``--actions-dir``.

Output layout
~~~~~~~~~~~~~

- ``<output-dir>/<episode>_camera.mp4`` — aligned camera video per episode.
- ``<output-dir>/<episode>_camera_meta.json`` — alignment metadata and diagnostics (including per‑frame mappings and quality stats).

.. _detect-water-episodes-batch-py:

``detect_water_episodes_batch.py``
-----------------------------------

`[Source] <https://github.com/solaris-wm/solaris-engine/blob/dev/postprocess/detect_water_episodes_batch.py>`_

Batch detects water episodes by detecting the oxygen bar HUD element in video frames. Uses multiprocessing to process all video files in all batch directories under a base path. An episode is classified as a water episode if **any** of its per‑bot videos shows underwater indicators (oxygen bar). This generalises across the full ``--num-players`` count — the script discovers bot videos by filename pattern rather than enumerating Alpha/Bravo specifically. Outputs per‑batch JSON files and an aggregated water episodes list suitable for :ref:`filter_dataset.py <filter-dataset-py>`.

Usage
~~~~~

.. code-block:: bash

   python postprocess/detect_water_episodes_batch.py --base-path BASE_PATH [OPTIONS]

Options
~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 30 15 55

   * - Option
     - Default
     - Description
   * - ``--base-path PATH``
     - (required)
     - Base path containing batch folders (each with an ``aligned/`` subdirectory).
   * - ``--threshold FLOAT``
     - ``0.8``
     - Cosine similarity threshold for water detection (oxygen bar match).
   * - ``--max-frames N``
     - ``1000``
     - Maximum number of frames to sample per video.
   * - ``--num-workers N``
     - CPU count
     - Number of worker processes.
   * - ``--top-percentile N``
     - ``10``
     - Top N percentile for similarity thresholding (e.g. 10 = top 10%).
   * - ``--out-path PATH``
     - ``<base-path>/all_water_episodes.json``
     - Output path for aggregated water episodes JSON (list of ``batch_id``, ``episode_id``, ``instance_id``).

Output layout
~~~~~~~~~~~~~

- Per batch: ``<batch_folder>/water_episodes.json`` — categorized water/non‑water episodes and metadata.
- Aggregated: ``<out-path>`` — flat list of water episode keys for use by :ref:`filter_dataset.py <filter-dataset-py>`.

.. _filter-dataset-py:

``filter_dataset.py``
---------------------

`[Source] <https://github.com/solaris-wm/solaris-engine/blob/dev/postprocess/filter_dataset.py>`_

Filters a multiplayer dataset by moving selected episodes into a ``discarded/`` subdirectory. Expects a JSON list of episode keys (typically from :ref:`detect_water_episodes_batch.py <detect-water-episodes-batch-py>`) with ``batch_id``, ``episode_id``, and ``instance_id``. File names in the dataset directory must encode these fields, e.g. ``batch_0_000058_<Bot>_instance_001_episode_info.json``. Files for **all** bots that share an episode key are moved together.

Usage
~~~~~

.. code-block:: bash

   python postprocess/filter_dataset.py --episodes-json PATH dataset_dir

Options
~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 30 15 55

   * - Option
     - Default
     - Description
   * - ``--episodes-json PATH``
     - (required)
     - Path to JSON file with list of objects containing ``batch_id``, ``episode_id``, and ``instance_id``. Matching episodes are moved to ``discarded/``.
   * - ``dataset_dir``
     - (required)
     - Dataset directory containing files such as ``batch_0_000000_<Bot>_instance_000.*`` (one set per bot). Matching files for every bot in the same episode are moved into a ``discarded/`` subdirectory.

Output layout
~~~~~~~~~~~~~

Matching files are moved from ``<dataset_dir>/`` into ``<dataset_dir>/discarded/``. Only top‑level files are considered; subdirectories are ignored.

.. _prepare-train-dataset-py:

``prepare_train_dataset.py``
-----------------------------

`[Source] <https://github.com/solaris-wm/solaris-engine/blob/dev/postprocess/prepare_train_dataset.py>`_

Validates and consolidates aligned camera videos and action JSONs into a single final dataset directory for training. It filters for episodes where every bot listed in ``--bots`` has consistent video/action pairs and enforces one‑to‑one alignment between frames and actions.

Usage
~~~~~

.. code-block:: bash

   python postprocess/prepare_train_dataset.py --source-dir SOURCE_DIR --destination-dir DEST_DIR [OPTIONS]

Options
~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 30 15 55

   * - Option
     - Default
     - Description
   * - ``--source-dir PATH``
     - (required)
     - Directory that contains one or more episode runs with ``aligned/`` and ``output/`` subdirs.
   * - ``--instance-ids IDS``
     - ``None``
     - Optional list of instance IDs to include (space‑ or comma‑separated).
   * - ``--file-prefix STR``
     - ``""``
     - Optional prefix prepended to destination filenames.
   * - ``--destination-dir PATH``
     - (required)
     - Target directory where the consolidated final dataset is written.
   * - ``--bots NAME [NAME ...]``
     - ``Alpha Bravo``
     - Bot names whose per‑episode files must all be present and self‑consistent. Pass one capitalized NATO phonetic name per player (e.g. ``Alpha Bravo Charlie`` for a 3‑player run).

Output layout
~~~~~~~~~~~~~

All validated per‑episode files (one video and one action JSON per bot in ``--bots``) are copied into ``<destination-dir>/`` with timestamp prefixes stripped and an optional prefix applied. Only episodes where frame counts match action counts for **every** bot are included.

.. _split-train-test-py:

``split_train_test.py``
-----------------------

`[Source] <https://github.com/solaris-wm/solaris-engine/blob/dev/postprocess/split_train_test.py>`_

Splits a consolidated final dataset directory into train/test splits.

Usage
~~~~~

.. code-block:: bash

   python postprocess/split_train_test.py FINAL_DIR [OPTIONS]

Options
~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 30 15 55

   * - Option
     - Default
     - Description
   * - ``final_dir``
     - (required)
     - Path to final dataset produced by ``prepare_train_dataset.py``.
   * - ``--test-percent PCT``
     - ``1.0``
     - Percentage of (episode, instance) keys assigned to the test split.
   * - ``--seed N``
     - ``42``
     - Random seed for deterministic splitting.
   * - ``--dry-run``
     - ``False``
     - Print the planned split without moving any files.

Output layout
~~~~~~~~~~~~~

Creates ``<final_dir>/train/`` and ``<final_dir>/test/`` and moves entire episode‑instance groups into one of the two subdirectories.

.. _prepare-eval-datasets-py:

``prepare_eval_datasets.py``
-----------------------------

`[Source] <https://github.com/solaris-wm/solaris-engine/blob/dev/postprocess/prepare_eval_datasets.py>`_

Prepares evaluation datasets from aligned eval episodes, mirroring the structure expected by Solaris model code. It filters, validates, and reshapes eval episodes into a unified directory layout.

Usage
~~~~~

.. code-block:: bash

   python postprocess/prepare_eval_datasets.py --source-dir SOURCE_DIR --destination-dir DEST_DIR [OPTIONS]

Options
~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 30 15 55

   * - Option
     - Default
     - Description
   * - ``--source-dir PATH``
     - (required)
     - Directory with eval runs (aligned videos and action JSONs).
   * - ``--destination-dir PATH``
     - (required)
     - Output directory for prepared eval datasets.

.. _annotate-video-batch-py:

``annotate_video_batch.py``
---------------------------

`[Source] <https://github.com/solaris-wm/solaris-engine/blob/dev/postprocess/annotate_video_batch.py>`_

Batch annotates aligned camera videos with overlaid action information and vertically concatenates the per‑player views into a single debug video per episode. Player views are stacked alphabetically by bot name (e.g. Alpha on top, Bravo below it, Charlie below that, …) so the layout is deterministic regardless of ``--num-players``. It can run on a single videos directory or over multiple subdirectories and supports parallel processing.

Usage
~~~~~

.. code-block:: bash

   python postprocess/annotate_video_batch.py VIDEOS_DIR [OPTIONS]

Options
~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 30 15 55

   * - Option
     - Default
     - Description
   * - ``videos_dir``
     - (required)
     - Directory that has ``aligned/`` and ``output/`` (or already split ``test/``) subdirectories, or a parent directory with multiple such subdirectories.
   * - ``--workers N``
     - ``8``
     - Number of parallel workers.
   * - ``--output-dir PATH``
     - ``<videos_dir>/annotated``
     - Where to write annotated videos (per directory or per subdirectory).
   * - ``--limit N``
     - ``10``
     - Maximum number of episodes to process (stratified across instances).

Output layout
~~~~~~~~~~~~~

Writes combined debug videos (one row per player, stacked vertically in alphabetical bot‑name order) under an ``annotated/`` subdirectory (or the directory specified via ``--output-dir``).

Docker Orchestration
--------------------

This section documents the Python tools that generate and orchestrate the Docker Compose instances used by :ref:`run.sh <run-sh>`/:ref:`run_evals.sh <run-evals-sh>`.

.. _generate-compose-py:

``generate_compose.py``
-----------------------

`[Source] <https://github.com/solaris-wm/solaris-engine/blob/dev/generate_compose.py>`_

Generates multiple Docker Compose files, each describing a full ``SolarisEngine`` instance (Minecraft server, controller bots, camera bots, spectators, and helper containers). It supports mixed flat/normal worlds, GPU‑backed camera rendering, configurable player counts via ``--num_players``, and a wide range of episode customization options.

Usage
~~~~~

.. code-block:: bash

   python generate_compose.py --data_dir DATA_DIR --output_dir OUTPUT_DIR \
       --num_players N --camera_output_bases BASE1 BASE2 ... [OPTIONS]

Options
~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 30 15 55

   * - Option
     - Default
     - Description
   * - ``--instances N``
     - ``15``
     - Number of instances to generate when world counts are not overridden.
   * - ``--num_flatland_world N``
     - ``0``
     - Number of flat‑world instances (overrides ``--instances`` when > 0).
   * - ``--num_normal_world N``
     - ``0``
     - Number of normal‑world instances (overrides ``--instances`` when > 0).
   * - ``--compose_dir DIR``
     - ``compose_configs``
     - Directory to store generated ``docker-compose-XXX.yml`` files.
   * - ``--base_port PORT``
     - ``25565``
     - Base Minecraft server port (one per instance, contiguous range).
   * - ``--base_rcon_port PORT``
     - ``25675``
     - Base RCON port (one per instance, contiguous range).
   * - ``--act_recorder_port PORT``
     - ``8090``
     - Act recorder port used inside the bridge network.
   * - ``--coord_port PORT``
     - ``8100``
     - Coordination port used by controller bots.
   * - ``--data_dir DIR``
     - (required)
     - Base directory for per‑instance Minecraft server data.
   * - ``--output_dir DIR``
     - (required)
     - Shared output directory for controller/act_recorder episode outputs.
   * - ``--num_players N``
     - ``2``
     - Number of player bots per instance, from 2 to 8: each player's camera takes one of the 8 NVENC sessions per GPU, and the instance count is capped at ``floor(8 / N)``. Lengths of all per‑player list flags below must match this value.
   * - ``--skins NAME [NAME ...]``
     - lookup by player name
     - One skin filename per player. When omitted, falls back to the project's default-skin lookup (Alpha, Bravo, Charlie are bundled; supplying ``--skins`` is required for ``--num_players > 3``).
   * - ``--camera_output_bases DIR [DIR ...]``
     - (required)
     - Absolute base directories for per‑instance camera outputs, one per player. List length must equal ``--num_players``.
   * - ``--camera_data_bases DIR [DIR ...]``
     - ``camera/data_<name>``
     - Absolute base directories for per‑instance camera home/data, one per player. Defaults to ``<repo>/camera/data_<name>`` for each player name (lowercased).
   * - ``--camera_vnc_bases PORT [PORT ...]``
     - ``5901..5901+N-1``
     - Starting VNC port for each player. List length must equal ``--num_players`` when provided.
   * - ``--camera_novnc_bases PORT [PORT ...]``
     - ``6901..6901+N-1``
     - Starting noVNC port for each player. List length must equal ``--num_players`` when provided.
   * - ``--vnc_step N``
     - ``--num_players``
     - Stride between consecutive instances for VNC/noVNC ports.
   * - ``--display_step N``
     - ``--num_players``
     - Stride between consecutive instances for X display numbers.
   * - ``--disable_advancements {true,false}``
     - ``false``
     - When ``true``, generated compose files mount a ``spigot.yml`` override that disables advancement pop-ups server-wide. Pairs with the ``run.sh`` ``--disable-advancements`` flag.
   * - ``--camera_encoder {libx264,h264_nvenc}``
     - auto‑detect
     - Forces the camera ffmpeg encoder. When omitted, the camera container probes NVENC with a one-frame test encode and falls back to ``libx264`` on GPUs without NVENC silicon (e.g. A100/H100).
   * - ``--disable_nvenc {0,1}``
     - ``0``
     - Force CPU (``libx264``) video encoding in camera containers, skipping the NVENC probe. Equivalent to ``--camera_encoder libx264``.
   * - ``--num_episodes N``
     - ``5``
     - Number of episodes to run per instance.
   * - ``--episode_start_id N``
     - ``0``
     - Starting episode ID.
   * - ``--bootstrap_wait_time SEC``
     - ``60``
     - Time for servers/plugins to bootstrap before controllers start. Overridden to ``0`` when ``--disable_advancements true`` is set, since popups cannot appear and no wait is needed.
   * - ``--episode_category STR``
     - ``look``
     - High‑level episode category name.
   * - ``--episode_types STR``
     - ``all``
     - Comma‑separated episode types for controllers.
   * - ``--viewer_rendering_disabled {0,1}``
     - ``1``
     - Disable viewer rendering for controller/act_recorder (recommended for speed).
   * - ``--smoke_test {0,1}``
     - ``0``
     - If set, enable smoke‑test mode that exercises all episode types.
   * - ``--eval_time_set_day {0,1}``
     - ``0``
     - If set, force eval episodes to start at day time.
   * - ``--flatland_world_disable_structures {0,1}``
     - ``0``
     - Disable structure generation in flat worlds.
   * - ``--render_distance N``
     - ``8``
     - Minecraft render distance (chunks) for camera clients.
   * - ``--simulation_distance N``
     - ``4``
     - Minecraft simulation distance (chunks).
   * - ``--graphics_mode {0,1,2}``
     - ``1``
     - Minecraft graphics mode (Fast, Fancy, Fabulous).
   * - ``--gpu_mode {egl,x11,auto}``
     - ``egl``
     - GPU rendering mode for camera containers.

Output layout
~~~~~~~~~~~~~

- ``<compose_dir>/docker-compose-XXX.yml`` — one Docker Compose file per instance.
- Per‑instance data and camera output/data directories are created under ``--data_dir`` and the camera base paths; ``--output_dir`` is created as the shared controller output root.

.. _orchestrate-py:

``orchestrate.py``
------------------

`[Source] <https://github.com/solaris-wm/solaris-engine/blob/dev/orchestrate.py>`_

Orchestrates one or more generated Docker Compose instances produced by :ref:`generate_compose.py <generate-compose-py>`. The script starts/stops them, captures logs, inspects status, and optionally runs postprocessing over their outputs.

Usage
~~~~~

.. code-block:: bash

   python orchestrate.py {start,stop,status,logs,postprocess} [OPTIONS]

Options
~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 30 15 55

   * - Option
     - Default
     - Description
   * - ``command``
     - (required)
     - One of ``start``, ``stop``, ``status``, ``logs``, or ``postprocess``.
   * - ``--compose-dir DIR``
     - ``compose_configs``
     - Directory containing the ``docker-compose-XXX.yml`` files.
   * - ``--build``
     - ``False``
     - If set with ``start``, build images before starting (otherwise they are pulled).
   * - ``--logs-dir DIR``
     - ``logs``
     - Directory where per‑service logs are stored.
   * - ``--instance PATTERN``
     - ``None``
     - Filter for a subset of instances when showing logs.
   * - ``--follow``, ``-f``
     - ``False``
     - Follow logs (for the ``logs`` command when targeting a single instance).
   * - ``--tail N``
     - ``50``
     - Number of lines to show from saved logs.
   * - ``--workers N``
     - ``4``
     - Parallel workers for the ``postprocess`` command.
   * - ``--comparison-video``
     - ``False``
     - When running ``postprocess``, also build side‑by‑side comparison videos.
   * - ``--debug``
     - ``False``
     - Extra logging for ``postprocess`` episode discovery.
   * - ``--output-dir PATH``
     - ``None``
     - Base ``aligned`` directory to postprocess (see ``postprocess_recordings`` docstring).
   * - ``--num-players N``
     - ``2``
     - Number of player bots per instance. Must match the value used when generating the compose files via :ref:`generate_compose.py <generate-compose-py>`. Drives service naming (``controller_<bot>_instance_<id>``, ``camera_<bot>_instance_<id>``, ``act_recorder_<bot>_instance_<id>``) and bot detection during postprocessing.
   * - ``--encoder {libx264,h264_nvenc}``
     - ``libx264``
     - Video encoder used during the ``postprocess`` command. Capped at 8 concurrent NVENC sessions per GPU when ``h264_nvenc`` is selected.

Behavior summary
~~~~~~~~~~~~~~~~

- ``start`` — starts all compose instances in parallel, waits for controller completion, captures per‑service logs, then shuts everything down.
- ``stop`` — stops all running instances and tears down volumes.
- ``status`` — reports how many instances have running containers.
- ``logs`` — tails saved per‑service logs (or falls back to ``docker compose logs`` if none are saved yet).
- ``postprocess`` — runs camera alignment over all episodes under a given ``--output-dir`` using the postprocessing pipeline.
