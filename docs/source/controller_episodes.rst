Episode Types
=============


.. _training-episode-types:

Training
--------

Below are the 14 base training episode types plus three N-player variants. Most base episodes were authored when the engine was strictly 2-player and assume two participants ("one bot does X, the other observes"); they still run with ``--num-players 2``. The three episode types whose name ends in ``Np`` (``chaseNp``, ``walkLookNp``, ``buildTowerNp``) are explicit N-player generalisations of their base counterparts and accept any ``--num-players`` value.

:js:class:`straightLineWalk <episode-handlers.straight-line-episode.StraightLineEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: One bot runs towards and past the other bot, then spins to look at it.
- **Notable parameters**:

  - Walk past the target by 4–8 blocks.
  - Pathfinding timeout: 20s.

:js:class:`chase <episode-handlers.chase-episode.ChaseEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: One bot runs away in a zig-zag pattern, and the other bot pursues it.
- **Player count**: 2 only. See ``chaseNp`` for the N-player variant.
- **Notable parameters**:

  - Chase duration: 5–15s.
  - Runner sets a single deterministic escape goal ~100 blocks away (directly away
    from the chaser's initial position).
  - Chaser updates GoalNear roughly once per second and keeps the runner in view
    periodically.

:js:class:`chaseNp <episode-handlers.chase-np-episode.ChaseNpEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: N-player generalisation of ``chase``. One bot is the runner; the remaining ``N-1`` bots all chase it. Same escape geometry as ``chase``; each chaser updates its own GoalNear independently.
- **Player count**: any ``N >= 2``.

:js:class:`orbit <episode-handlers.orbit-episode.OrbitEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Bots move in a circular trajectory around a shared center, visiting checkpoints on the circle. At each checkpoint, they stop and look at each other.
- **Notable parameters**:

  - Checkpoints: 8.
  - Reach distance: 1.5 blocks, per-checkpoint timeout 5s.
  - Eye contact at each checkpoint: 1s.

:js:class:`walkLook <episode-handlers.walk-look-episode.WalkLookEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: The episode consists of iterations where one or both bots move in a random direction with just WASD actions in front of each other.
- **Player count**: 2 only. See ``walkLookNp`` for the N-player variant.
- **Notable parameters**:

  - Iterations per episode: 3.
  - Random-walk actions per iteration: 2–4.

:js:class:`walkLookNp <episode-handlers.walk-look-np-episode.WalkLookNpEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: N-player generalisation of ``walkLook``. Same iteration structure: each iteration randomly picks a subset of bots to move with WASD while the others observe.
- **Player count**: any ``N >= 2``.
- **Notable parameters**: same as ``walkLook``.

:js:class:`walkLookAway <episode-handlers.walk-look-away-episode.WalkLookAwayEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: The episode consists of iterations where one bot moves in a random direction, looks away, and looks back at the other bot. The other observes.
- **Notable parameters**:

  - Iterations per episode: 3.
  - Actions per iteration: 1.

:js:class:`pvp <episode-handlers.pvp-episode.PvpEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Bots fight each other in melee combat with swords.
- **Setup**: Bots are provisioned with a random sword before the episode starts.
- **Notable parameters**:

  - Spawn distance constraints: 8–15 blocks.
  - Combat duration: 10–15s.

:js:class:`pve <episode-handlers.pve-episode.PveEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Bots defend two random positions on the ground, facing each other against spawning mobs.
- **Setup**:

  - Temporarily sets server difficulty to ``easy`` during setup to make mobs attack players; resets back to ``peaceful`` in teardown.
  - Provides a random sword.

- **Notable parameters**:

  - Spawn distance constraints: 15–25 blocks.
  - Number of mobs per episode: 2–5.

:js:class:`buildStructure <episode-handlers.build-structure-episode.BuildStructureEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Each bot builds a wall or tower in front of the other, or bots build a platform together at midpoint.
- **Setup**: Gives blocks for building.
- **Notable parameters**:

  - Spawn distance constraints: 8–15 blocks.
  - Block types sampled with shared RNG from: ``stone``, ``cobblestone``, ``oak_planks``,
    ``bricks``.
  - Placement delay: 300ms per block.

:js:class:`buildTower <episode-handlers.build-tower-episode.BuildTowerEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Both bots build a tall 1-block tower by jumping and placing blocks underneath themselves.
- **Player count**: 2 only. See ``buildTowerNp`` for the N-player variant.
- **Setup**: Gives blocks for building.
- **Notable parameters**:

  - Spawn distance constraints: 8–15 blocks.
  - Tower height: 8–12 blocks.
  - Block type: ``oak_planks``.

:js:class:`buildTowerNp <episode-handlers.build-tower-np-episode.BuildTowerNpEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: N-player generalisation of ``buildTower``. All ``N`` bots simultaneously jump-and-place towers; eye-contact aim is computed against the centroid of the other bots' eye positions so the gaze still looks intentional.
- **Player count**: any ``N >= 2``.
- **Notable parameters**: same as ``buildTower``.

:js:class:`mine <episode-handlers.mine-episode.MineEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Agent bots dig 1 block underground and mine their way towards each other.
- **Setup**: Gives torches and a ``diamond_pickaxe``.
- **Notable parameters**:

  - Initial dig-down depth: 1 block.
  - Pathfinder-with-mining timeout: 60s.

:js:class:`towerBridge <episode-handlers.tower-bridge-episode.TowerBridgeEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Bots build a 1-block tower by jumping, then build a bridge connecting the two towers, and meet.
- **Setup**: Gives blocks for building.
- **Notable parameters**:

  - Spawn distance constraints: 12–20 blocks.
  - Tower height: 8 blocks.
  - Bridge build timeout: 60s.
  - Block type: ``oak_planks``.

:js:class:`buildHouse <episode-handlers.build-house-episode.BuildHouseEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Collaborative 5×5 house build at the midpoint between bots, then both
  bots exit and "admire" the house.
- **Setup**: Gives building materials.
- **Notable parameters**:

  - Spawn distance constraints: 10–20 blocks.
  - Placement delay: 200ms per block.


:js:class:`collector <episode-handlers.collector-episode.CollectorEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: One bot mines underground searching for ores, the other bot follows, placing torches.
- **Setup**: Gives torches.
- **Notable parameters**:
  - Mining cycles: up to 10.
  - Provisions torches: 128.

:js:class:`placeAndMine <episode-handlers.place-and-mine-episode.PlaceAndMineEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Episode consists of rounds. In every round, bots stand facing each other. One bot places blocks, and the other one destroys them.
- **Notable parameters**:

  - Spawn distance constraints: 4–8 blocks.
  - Rounds per episode: 7–10.
  - Block types include: ``stone``, ``oak_planks``, ``bricks``, ``dirt``,
    ``smooth_sandstone``.

.. _eval-episode-types:

Eval
----

Below are the 13 eval episode types and what they do. The first 7 are collected by :ref:`run_evals.sh <run-evals-sh>`; the newer pose-evaluation types (``divergentLookEval``, ``backToBackTurnEval``, ``blindTurnEval``, ``parallelTurnEval``, ``wallWalkEval``, ``wallOcclusionEval``) are collected by :ref:`run_new_evals.sh <run-new-evals-sh>`.

:js:class:`structureEval <episode-handlers.eval.structure-eval-episode.StructureEvalEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: One bot, builder, builds a small structure at its spawn location. The other bot, observer, watches.
- **Notable parameters**:

  - Structure types: ``wall_2x2``, ``wall_4x1``, ``tower_2x1``.
  - Block type: stone only.
  - Spawn distance: 6 blocks.
  - Minimum episode ticks: 300.

:js:class:`translationEval <episode-handlers.eval.translation-eval-episode.TranslationEvalEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: One bot runs left/right/forward/backward using WASD keys, the other bot stays.
- **Notable parameters**:

  - Spawn distance: 10–12 blocks.
  - Walk: 1 action per iteration.
  - Movement: 6–9 blocks.
  - Minimum episode ticks: 300.

:js:class:`bothLookAwayEval <episode-handlers.eval.both-look-away-eval-episode.BothLookAwayEvalEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Both bots look at each other, then both look away by the same random
  direction/offset so that they disappear from view of each other.
- **Notable parameters**:

  - Spawn distance: 10–12 blocks.
  - Look-away duration: 1s.
  - Look-away offset: 90° ± 22.5° (left or right).
  - Iterations per episode: 1.
  - Minimum episode ticks: 300.

:js:class:`oneLooksAwayEval <episode-handlers.eval.one-looks-away-eval-episode.OneLooksAwayEvalEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: One bot looks away by a random offset after initial eye contact so that the other bot disappears from view. The other keeps looking.
- **Notable parameters**:

  - Spawn distance: 10–12 blocks.
  - Look-away duration: 1s.
  - Look-away offset: 90° ± 22.5°.
  - Minimum episode ticks: 300.

:js:class:`rotationEval <episode-handlers.eval.rotation-eval-episode.RotationEvalEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: One bot rotates yaw by a fixed angle while the other stays.
- **Notable parameters**:

  - Spawn distance: 10–12 blocks.
  - Rotation angles: +40°, -40°, 180°.
  - Camera speed: 30°/s.
  - Minimum episode ticks: 300.

:js:class:`turnToLookEval <episode-handlers.eval.turn-to-look-eval-episode.TurnToLookEvalEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Bots spawn close to each other (1 block away), facing each other. They both look sideways in the same direction, 90° left or right.
- **Notable parameters**:

  - Camera speed: 30°/s for initial look, 90°/s for turn.
  - Minimum episode ticks: 300.

:js:class:`turnToLookOppositeEval <episode-handlers.eval.turn-to-look-opposite-eval-episode.TurnToLookOppositeEvalEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Bots spawn close to each other (1 block away), facing each other. They both look sideways in the opposite direction, 90° left or right.
- **Notable parameters**:

  - Camera speed: 30°/s for initial look, 90°/s for turn.
  - Minimum episode ticks: 300.


:js:class:`divergentLookEval <episode-handlers.eval.divergent-look-eval-episode.DivergentLookEvalEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Both bots face random divergent directions (no eye contact) and hold completely still for the whole episode; evaluates pose awareness for gaze-direction prediction. Runs in a normal (non-flat) world, restricted to sparse open biomes (deserts, snowy biomes, savannas, …) via ``ACCEPTED_BIOMES``.
- **Notable parameters**:

  - Spawn distance: 10–12 blocks.
  - Minimum episode ticks: 300.

:js:class:`backToBackTurnEval <episode-handlers.eval.back-to-back-turn-eval-episode.BackToBackTurnEvalEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Both bots start facing random directions at least 60° off the toward-each-other axis (keeping the other bot out of the 54° half-FOV plus margin), then turn to face each other, each at its own random speed.
- **Notable parameters**:

  - Spawn distance: 10–12 blocks.
  - Turn speed: 20–40°/s, sampled independently per bot.
  - Starting yaw offset: sampled from [60°, 300°] off the facing axis.
  - Minimum episode ticks: 300.

:js:class:`blindTurnEval <episode-handlers.eval.blind-turn-eval-episode.BlindTurnEvalEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: One bot (the “blind” bot) starts facing 90° sideways and slowly turns to face the watcher; the watcher keeps looking at it. Evaluates single-bot turning prediction.
- **Notable parameters**:

  - Spawn distance: 10–12 blocks.
  - Camera speed: 30°/s.
  - Minimum episode ticks: 300.

:js:class:`parallelTurnEval <episode-handlers.eval.parallel-turn-eval-episode.ParallelTurnEvalEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Both bots start facing the same world direction (parallel gazes) and turn 90° to face each other. Evaluates symmetric turning prediction.
- **Notable parameters**:

  - Spawn distance: 10–12 blocks.
  - Camera speed: 30°/s.
  - Minimum episode ticks: 300.

:js:class:`wallWalkEval <episode-handlers.eval.wall-walk-eval-episode.WallWalkEvalEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: A wall spawns between the bots. One bot (walker) navigates around the wall via waypoints to the other side while the other bot (observer) stands still. Name tags are hidden for the duration, so the wall genuinely occludes the walker from the observer's view.
- **Notable parameters**:

  - Wall size: 9×3 blocks.
  - Camera speed: 30°/s.
  - Waypoint timeout: 8 s.
  - Minimum episode ticks: 300.

:js:class:`wallOcclusionEval <episode-handlers.eval.wall-occlusion-eval-episode.WallOcclusionEvalEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Same wall/walker/observer setup as ``wallWalkEval``, but both starting gazes are rotated 60° off the wall-perpendicular in the same rotational sense, yielding antiparallel gazes on a single axis. Name tags are deliberately kept visible, so the observer sees the walker's tag through the wall — the intended “occluded presence” signal.
- **Notable parameters**:

  - Wall size: 9×3 blocks.
  - Gaze offset: 60° off the wall-perpendicular.
  - Observer antiparallel hold: 80 ticks.
  - Camera speed: 30°/s.
  - Minimum episode ticks: 300.

.. _adding-new-episode-type:

Adding a new episode type
-------------------------

To add a new episode type:

1. **Create the handler module** in ``controller/episode-handlers/`` (or
   ``controller/episode-handlers/eval/`` for eval episodes). The module must export a
   class that extends :js:class:`episode-handlers.base-episode.BaseEpisode`.

2. **Register the episode in** ``controller/episodes-loop.js``:

   - Add an entry to ``episodeClassMap`` mapping the episode type string (e.g. ``myNewEpisode``) to your class.
   - For eval episodes only: add your class to the ``evalEpisodeClasses`` array.
   - To include it in the default set when ``EPISODE_TYPES`` is unset, add the type string to ``defaultEpisodeTypes``.

3. **Add a typical length** in ``controller/utils/episode-weights.js``: add your
   episode type key and a typical duration in seconds to ``episodeTypicalLengths``.
   This is used for weighted sampling (shorter episodes are sampled more often). If
   the type is missing, ``selectWeightedEpisodeType()`` will throw.

4. **Declare eligibility via class statics** (all optional):

   - ``WORKS_IN_NON_FLAT_WORLD = true`` — allows the episode to be scheduled in normal
     (non-flat) worlds; by default episodes only run in flatland worlds.
   - ``ACCEPTED_BIOMES = [...]`` — in normal worlds, restricts the episode to the listed
     biomes; the teleport step re-rolls locations until an accepted biome is found.
   - ``SUPPORTS_N_PLAYER = true`` — marks the episode as safe for more than 2 players;
     with ``--num-players > 2`` only episode types carrying this flag are scheduled.
