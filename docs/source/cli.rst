CLI
===

Entry Point
-----------

This page describes the main command-line entry points for data collection: ``run.sh`` (training data) and ``run_evals.sh`` (evaluation data).

.. _run-sh:

``run.sh``
----------------------------------

`[Source] <https://github.com/georgysavva/mc-multiplayer-data/tree/release/run.sh>`_

runs the full training data collection pipeline: it generates compose configs, starts Minecraft instances per batch, collects episodes, stops them, postprocesses, then prepares and splits the train dataset and annotates some test videos.

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
   * - ``--num-flat-world N``
     - ``1``
     - Number of flat worlds per batch
   * - ``--num-normal-world N``
     - ``1``
     - Number of normal worlds per batch
   * - ``--num-episodes N``
     - ``2``
     - Number of episodes per batch
   * - ``--dataset-name NAME``
     - ``duet``
     - Name of the output dataset under ``<output-dir>/datasets/``
   * - ``-h``, ``--help``
     -
     - Show usage and exit

Output layout
~~~~~~~~~~~~~

Data is written under ``<output-dir>/``:

- ``data_collection/train/batch_<i>/`` — per-batch compose configs, logs, and aligned outputs
- ``datasets/<dataset-name>/`` — prepared train dataset (after postprocess and split); some test split videos are annotated by `postprocess/annotate_video_batch.py <https://github.com/georgysavva/mc-multiplayer-data/tree/release/postprocess/annotate_video_batch.py>`_

.. _run-evals-sh:

``run_evals.sh``
-----------------------------------------

`[Source] <https://github.com/georgysavva/mc-multiplayer-data/tree/release/run_evals.sh>`_

Runs evaluation data collection for several episode types, then prepares the eval datasets and annotates some of the videos for debugging.

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
     - ``output2``
     - Base data directory for outputs
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

For ``turnToLookEval`` and ``turnToLookOppositeEval`` the script uses 1 normal world and 32 episodes; for the rest it uses 2 flatland worlds and 16 episodes per type.

Output layout
~~~~~~~~~~~~~

- ``<output-dir>/data_collection/eval/<eval_type>/`` — per-type compose configs, logs, and aligned outputs
- ``<output-dir>/datasets/eval/`` — prepared eval datasets (from `postprocess/prepare_eval_datasets.py <https://github.com/georgysavva/mc-multiplayer-data/tree/release/postprocess/prepare_eval_datasets.py>`_); some videos are annotated by `postprocess/annotate_video_batch.py <https://github.com/georgysavva/mc-multiplayer-data/tree/release/postprocess/annotate_video_batch.py>`_

Postprocessing
--------------

This section covers the postprocessing utilities that run as part of :ref:`run.sh <run-sh>` and :ref:`run_evals.sh <run-evals-sh>`, and turn raw camera recordings and action files into final train/eval datasets and optional annotated videos.

.. _process-recordings-py:

``process_recordings.py``
-------------------------

`[Source] <https://github.com/georgysavva/mc-multiplayer-data/tree/release/postprocess/process_recordings.py>`_

Aligns raw Minecraft camera recordings with Mineflayer action episode files for a single bot, producing per-episode aligned camera videos. It can operate on a full directory of episodes or a single episode file.

Usage
~~~~~

.. code-block:: bash

   python postprocess/process_recordings.py --actions-dir ACTIONS_DIR --camera-prefix CAMERA_DIR --bot {Alpha,Bravo} [OPTIONS]

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
     - Directory containing camera outputs (expects ``output_alpha/`` or ``output_bravo/``).
   * - ``--bot {Alpha,Bravo}``
     - (required)
     - Which bot to process.
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

.. _prepare-train-dataset-py:

``prepare_train_dataset.py``
-----------------------------

`[Source] <https://github.com/georgysavva/mc-multiplayer-data/tree/release/postprocess/prepare_train_dataset.py>`_

Validates and consolidates aligned camera videos and action JSONs into a single final dataset directory for training. It filters for episodes where both Alpha and Bravo have consistent video/action pairs and enforces one‑to‑one alignment between frames and actions.

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
   * - ``--bot1-name NAME``
     - ``Alpha``
     - Name used to identify the first bot in file paths.
   * - ``--bot2-name NAME``
     - ``Bravo``
     - Name used to identify the second bot in file paths.

Output layout
~~~~~~~~~~~~~

All validated per‑episode files (videos and JSONs for both players) are copied into ``<destination-dir>/`` with timestamp prefixes stripped and an optional prefix applied. Only episodes where frame counts match action counts for both bots are included.

.. _split-train-test-py:

``split_train_test.py``
-----------------------

`[Source] <https://github.com/georgysavva/mc-multiplayer-data/tree/release/postprocess/split_train_test.py>`_

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

`[Source] <https://github.com/georgysavva/mc-multiplayer-data/tree/release/postprocess/prepare_eval_datasets.py>`_

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

`[Source] <https://github.com/georgysavva/mc-multiplayer-data/tree/release/postprocess/annotate_video_batch.py>`_

Batch annotates aligned camera videos with overlaid action information and vertically concatenates Alpha/Bravo views into a single debug video per episode. It can run on a single videos directory or over multiple subdirectories and supports parallel processing.

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
     - Maximum number of video pairs to process (stratified across instances).

Output layout
~~~~~~~~~~~~~

Writes combined debug videos (Alpha on top, Bravo on bottom) under an ``annotated/`` subdirectory (or the directory specified via ``--output-dir``).

Docker Orchestration
--------------------

This section documents the Python tools that generate and orchestrate the Docker Compose instances used by :ref:`run.sh <run-sh>`/:ref:`run_evals.sh <run-evals-sh>`.

.. _generate-compose-py:

``generate_compose.py``
-----------------------

`[Source] <https://github.com/georgysavva/mc-multiplayer-data/tree/release/generate_compose.py>`_

Generates multiple Docker Compose files, each describing a full ``SolarisEngine``(Minecraft server, controller bots, camera bots, spectators, and helper containers) for a single instance. It supports mixed flat/normal worlds, GPU‑backed camera rendering, and a wide range of episode customization options.

Usage
~~~~~

.. code-block:: bash

   python generate_compose.py --data-dir DATA_DIR --output_dir OUTPUT_DIR \
       --camera_output_alpha_base ALPHA_OUT --camera_output_bravo_base BRAVO_OUT [OPTIONS]

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
   * - ``--camera_output_alpha_base DIR``
     - (required)
     - Absolute base directory for per‑instance Camera Alpha outputs.
   * - ``--camera_output_bravo_base DIR``
     - (required)
     - Absolute base directory for per‑instance Camera Bravo outputs.
   * - ``--camera_data_alpha_base DIR``
     - project default
     - Base directory for Camera Alpha home/data (defaults under ``camera/data_alpha``).
   * - ``--camera_data_bravo_base DIR``
     - project default
     - Base directory for Camera Bravo home/data (defaults under ``camera/data_bravo``).
   * - ``--num_episodes N``
     - ``5``
     - Number of episodes to run per instance.
   * - ``--episode_start_id N``
     - ``0``
     - Starting episode ID.
   * - ``--bootstrap_wait_time SEC``
     - ``60``
     - Time for servers/plugins to bootstrap before controllers start.
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

`[Source] <https://github.com/georgysavva/mc-multiplayer-data/tree/release/orchestrate.py>`_

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

Behavior summary
~~~~~~~~~~~~~~~~

- ``start`` — starts all compose instances in parallel, waits for controller completion, captures per‑service logs, then shuts everything down.
- ``stop`` — stops all running instances and tears down volumes.
- ``status`` — reports how many instances have running containers.
- ``logs`` — tails saved per‑service logs (or falls back to ``docker compose logs`` if none are saved yet).
- ``postprocess`` — runs camera alignment over all episodes under a given ``--output-dir`` using the postprocessing pipeline.
