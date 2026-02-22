System Overview
===============

This repository contains a multiplayer data collection framework for Minecraft. It uses programmed bots based on `Mineflayer <https://github.com/PrismarineJS/mineflayer>`_ 
that engage in diverse, collaborative, multiplayer scenarios. The data it collects is the official Minecraft graphics (observations) for every player, 
annotated with their corresponding actions.

Data Collection Workflow
------------------------

The sole entry point to the data collection workflow is the :ref:`run.sh <run-sh>`/:ref:`run_evals.sh <run-evals-sh>` scripts that generate the training and eval datasets. 
They generate Docker Compose files tying together the system components: Controller Bot, Camera Bot, Minecraft Server Plugin, Spectator Bot, 
execute the docker compose instances in isolation in parallel, 
and run the postprocessing scripts on the host to produce the final datasets.

Controller
----------

The Controller Bot is a JavaScript program built on top of Mineflayer. It connects to the Minecraft Server and drives the behavior of the player. 
To ensure collaboration, it communicates with the controller instances of other players connected to the same server. It features a set of high-level, 
reusable game play primitives and a modular system of various episode types focusing on different aspects of the game. See :doc:`controller` for more details.

The controller is responsible for action recording of the playing bot. It saves them to disk as json files. Below is the list of all actions it records:

.. list-table::
   :header-rows: 1
   :widths: 18 10 72

   * - Action key
     - Type
     - Description
   * - forward
     - bool
     - Player moved forward (W).
   * - back
     - bool
     - Player moved backward (S).
   * - left
     - bool
     - Player strafed left (A).
   * - right
     - bool
     - Player strafed right (D).
   * - jump
     - bool
     - Player jumped.
   * - sprint
     - bool
     - Player sprinted.
   * - sneak
     - bool
     - Player sneaked.
   * - camera
     - vec2
     - Player changed the camera orientation by a look delta (yaw, pitch).
   * - attack
     - bool
     - Player attacked.
   * - use
     - bool
     - Player used / interacted with the environment.
   * - mount
     - bool
     - Player mounted an entity/vehicle.
   * - dismount
     - bool
     - Player dismounted.
   * - place_block
     - bool
     - Player placed a block using the currently selected item.
   * - place_entity
     - bool
     - Player placed an entity item.
   * - mine
     - bool
     - Player mined / broke the targeted block.
   * - hotbar.1
     - bool
     - Player selected hotbar slot 1.
   * - hotbar.2
     - bool
     - Player selected hotbar slot 2.
   * - hotbar.3
     - bool
     - Player selected hotbar slot 3.
   * - hotbar.4
     - bool
     - Player selected hotbar slot 4.
   * - hotbar.5
     - bool
     - Player selected hotbar slot 5.
   * - hotbar.6
     - bool
     - Player selected hotbar slot 6.
   * - hotbar.7
     - bool
     - Player selected hotbar slot 7.
   * - hotbar.8
     - bool
     - Player selected hotbar slot 8.
   * - hotbar.9
     - bool
     - Player selected hotbar slot 9.


Camera
------

The Camera Bot is the official Minecraft Java Client that runs headless. It connects to the server and pairs up with the corresponding Controller Bot of that player, 
so that these two processes are logically a single player. Through the :ref:`Minecraft Server Plugin <minecraft-server-plugin>`, the camera bot, at all times, shares the first person perspective of its controller bot. 
It records the graphics using ``ffmpeg``, which ``SolarisEngine`` aligns with the actions in postprocessing to form a final episode. Both the controller and camera record at ``20`` FPS. The observations (video) produced by the camera have the dimensions of ``1280×720``.

.. _minecraft-server-plugin:

Minecraft Server Plugin
----------------------

``SolarisEngine`` works with a standard Minecraft 1.21 Paper server that it augments with a custom server-side plugin. The plugin provides controls to pair controller bots with their corresponding camera bots by continuously synchronizing their character states. It replays all actions, positions, camera movements, and GUI elements, allowing the controller complete control over the player while accurately capturing its perspective with a real Minecraft client. It keeps the camera bot invisible to all players.

Spectator Bot
-------------

The spectator bot is another Mineflayer bot (making it a total of 3 bots constituting a single logical player). It always stays in the Spectate mode and just follows its controller bot. 
It always stays in the Spectate mode and follows its controller bot. This extra bot only exists to observe both the controller and the camera at once and is used internally by the plugin to synchronize block-breaking animations.

Postprocessing
--------------

After all the controller and camera processes finish, ``SolarisEngine`` cuts the single, raw camera output of a player into episodes, 
according to the episode action json files produced by the controller. The postprocessing script :ref:`process_recordings.py <process-recordings-py>` 
uses ``ffprobe`` to extract frames corresponding to their actions based on the per-frame wallclock timestamps.

TODO: @daohanlu you can probably talk more about the new frame extraction here.

An episode always consists of ``N`` actions and ``N`` observations, with the observation at index ``t`` being a physics tick (~``50ms``) after the action at index ``t``, 
making the observation a causal consequence of applying the action.

The scripts :ref:`prepare_train_dataset.py <prepare-train-dataset-py>`, :ref:`split_train_test.py <split-train-test-py>`, and :ref:`prepare_eval_datasets.py <prepare-eval-datasets-py>` validate and transform the output of ``SolarisEngine`` 
to the final training and evaluation dataset formats `Solaris <https://github.com/solaris-wm/solaris>`_ model code expects.

The two optional scripts :ref:`detect_water_episodes_batch.py <detect-water-episodes-batch-py>` and :ref:`filter_dataset.py <filter-dataset-py>` detect episodes 
where either Alpha or Bravo is underwater by analyzing the oxygen bar HUD and excluding them from the train dataset.

The optional script :ref:`annotate_video_batch.py <annotate-video-batch-py>` stitches the videos of all players into one and overlays them with visualized actions. 
It's a helpful debug tool to see how well all bots behave in an episode and that their actions are properly aligned with the observations.


Docker
------

``SolarisEngine`` uses Docker and Docker Compose to manage its components. The controller bot, camera bot, spectator bot, and Minecraft server are separate Docker containers. 
The controller bot has the additional ``act_recorder`` Python process for writing actions to disk that runs in a separate Docker container. 
All in all, for two players, it's ``2 * 4 + 1 = 9`` long running Docker containers total. They are bundled in Docker Compose, forming an instance, which allows them to run in isolation. 
A Docker Compose instance also has two additional procedural Docker containers, ``plugin_starter`` and ``prep_data``, 
that run at startup to set up the Minecraft server and the server-side plugin.

The outer layer of Python scripts, :ref:`generate_compose.py <generate-compose-py>` and :ref:`orchestrate.py <orchestrate-py>`, generates a configurable number of such Docker Compose instances and executes them in parallel, 
enabling data collection at scale.

The camera bot has a dedicated Docker image, ``solaris-engine-camera``, configured with a Java runtime and the official Minecraft Java client running headless. 
It does its rendering on the GPU and requires the host machine to have one to ensure proper Minecraft graphic rendering FPS.

TODO: @daohanlu add more details.

The controller bot, spectator bot, and ``act_recording`` Docker containers all share the ``solaris-engine-base`` Docker image that has both Node and Python environments set up. 
The Minecraft server uses the publicly available ``itzg/minecraft-server`` Docker image.

All postprocessing happens on the host inside the conda environment created by `env.yaml <https://github.com/solaris-wm/solaris-engine/blob/dev/env.yaml>`_ file.

Third-party Dependencies
------------------------

Mineflayer
~~~~~~~~~~

The Controller uses a `forked version <https://github.com/georgysavva/mineflayer>`_ of Mineflayer with the following modifications:

- Mineflayer API exposes access to the most recently applied camera action in its physics module and its event system is extended to send events on one-off semantic actions such as attacking, using, placing, and hotbar changes.
- The bot correctly looks at the face of the block when placing a new block.
- Camera smoothing is added to all non-Pathfinder look commands.

See the full list of changes `here <https://github.com/PrismarineJS/mineflayer/compare/master...georgysavva:mineflayer:master>`_.

Mineflayer-Pathfinder
~~~~~~~~~~~~~~~~~~~~~

The Controller uses a `forked version <https://github.com/daohanlu/mineflayer-pathfinder>`_ of Mineflayer-Pathfinder plugin with the following modifications:

- Improved looking when digging.
- Extended scaffolding items.

See the full list of changes `here <https://github.com/PrismarineJS/mineflayer-pathfinder/compare/master...daohanlu:mineflayer-pathfinder:master>`_.

Mineflayer-Prismarine-Viewer
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

The Controller implements its action recording based on a `forked version <https://github.com/georgysavva/prismarine-viewer-colalab>`_ of Prismarine-Viewer. It modifies it in the following way:

- It disables any graphic recordings because it's handled by the dedicated camera process.
- It receives actions from the Mineflayer physics plugin and sends them to the separate ``act_recorder`` process over network to be saved as json files on disk.

See the full list of changes `here <https://github.com/YXHXianYu/prismarine-viewer-colalab/compare/master...georgysavva:prismarine-viewer-colalab:master>`_.

