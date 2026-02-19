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

The Controller Bot is a JavaScript program build on top of Mineflayer. It connects to the Minecraft Server, and drives the behavior of the player. 
To ensure collaboration, it communicates with the Controller instances of other players connected to the same server. It features a set of high-level, 
reusable game play primitives and a modular system of various episode types focusing on different aspects of the game. See :doc:`controller` for more details.

Camera
------

The Camera Bot is the official Minecraft Java Client that runs headless. It connects to the server and pairs up with the corresponding Controller Bot of that player, 
so that these two processes are logically a single player. Through the server-side plugin, the camera bot, at all times, shares the first person perspective of its controller bot. 
It records the graphics using ``ffmpeg``, which ``SolarisEngine`` aligns with the actions in postprocessing to form a final episode.

Minecraft Server Plugin
----------------------

``SolarisEngine`` works with a standard Minecraft 1.21 Paper server that it augments with a custom server-side plugin: Episode Manager Plugin. 
It loads on server start and, after the bots of all players have been connected, it continuously synchronizes the character states of the controller bots to their corresponding camera bots. 
It replays all actions, positions, camera movements, and GUI elements. It keeps the camera bot invisible to all players.

TODO: @twmeehan elaborate on this part.

Spectator Bot
-------------

The spectator bot is another Mineflayer bot (making it a total of 3 bots constituting a single logic player). It always stays in Spectate mode and just follows its controller bot. 
It doesn't produce any observations nor actions. 
It's an auxiliary bot that the Camera bot and the Episode Manger Plugin need for proper game state synchronization between the controller and the camera 
(specifically block breaking animation).

Postprocessing
--------------

After all the controller and camera processes finish, ``SolarisEngine`` cuts the single, raw camera output of a player into episodes, 
according to the episode action json files produced by the controller. The postprocessing script :ref:`process_recordings.py <process-recordings-py>` 
uses ``ffprobe`` to extract frames corresponding to their actions based on the per-frame wallclock timestamps.

TODO: @daohanlu you can probably talk more about the new frame extraction here.

An episode always consists of ``N`` actions and ``N`` observations, with the observation at index ``t`` being a physics tick (~``50ms``) after the action at index ``t``, 
making the observation a causal consequence of applying the action.

The scripts :ref:`prepare_train_dataset.py <prepare-train-dataset-py>`, :ref:`split_train_test.py <split-train-test-py>`, and :ref:`prepare_eval_datasets.py <prepare-eval-datasets-py>` validate and transform the output of ``SolarisEngine`` 
to the final training and evaluation dataset formats Solaris model code expects.

The optional script :ref:`annotate_video_batch.py <annotate-video-batch-py>` stitches the videos of all players into one and overlays them with visualized actions.
 It's a helpful debug tool to see how well all bots behave in an episode and that their actions are properly aligned with the observations.

TODO: Document filter water episodes

Docker
------

``SolarisEngine`` uses Docker and Docker Compose to manage its components. The controller bot, camera bot, spectator bot, and Minecraft server are separate Docker containers. 
The controller bot has the additional ``act_recorder`` Python process for writing actions to disk that runs in a separate Docker container. 
All in all, for two players, it's ``2 * 4 + 1 = 9`` long running Docker containers total. They are bundled in Docker Compose, forming a instance, which allows them to run in isolation. 
A Docker Compose instance also has two additional procedural Docker containers, ``plugin_starter`` and ``prep_data``, 
that run at startup to set up the Minecraft server and the server-side plugin.

The outer layer of Python scripts, :ref:`generate_compose.py <generate-compose-py>` and :ref:`orchestrate.py <orchestrate-py>`, generates a configurable number of such Docker Compose instances and executes them in parallel, 
enabling data collection at scale.

The camera bot has a dedicated Docker image, ``solaris-engine-camera``, configured with a Java runtime and the official Minecraft Java client running headless. 
It does its rendering on GPU and requires the host machine to have one to ensure proper Minecraft graphic rendering FPS.

TODO: @daohanlu add more details.

The controller bot, spectator bot, and ``act_recording`` all share the ``solaris-engine-base`` Docker image that has both Node and Python environments set up. 
The Minecraft server uses the publicly available ``itzg/minecraft-server`` Docker image.

All postprocessing after all Docker Compose instances finish happens on the host inside the conda environment created by `env.yaml <https://github.com/georgysavva/mc-multiplayer-data/tree/release/env.yaml>`_ file.
