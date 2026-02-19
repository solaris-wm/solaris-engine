Episode Types
=============


.. _training-episode-types:

Training
--------

Below are the 14 training episode types and what they do.

:js:class:`straightLineWalk <episode-handlers.straight-line-episode.StraightLineEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: One bot runs towards and past the other bot, then spins to look at it.
- **Notable parameters**:

  - Walk past target by 4–8 blocks.
  - Pathfinding timeout: 20s.

:js:class:`chase <episode-handlers.chase-episode.ChaseEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: One bot runs away in a zig-zag pattern and the other bot pursues it.
- **Notable parameters**:

  - Chase duration: 5–15s.
  - Runner sets a single deterministic escape goal ~100 blocks away (directly away
    from the chaser's initial position).
  - Chaser updates GoalNear roughly once per second and keeps the runner in view
    periodically.

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
- **Notable parameters**:

  - Iterations per episode: 3.
  - Random-walk actions per iteration: 2–4.

:js:class:`walkLookAway <episode-handlers.walk-look-away-episode.WalkLookAwayEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: The episode consists of iterations where one bot moves in a random direction, looks away, looks back at the other bot. The other observes.
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
  - Provisions a random sword.

- **Notable parameters**:

  - Spawn distance constraints: 15–25 blocks.
  - Number of mobs per episode: 2–5.

:js:class:`buildStructure <episode-handlers.build-structure-episode.BuildStructureEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Each bot builds a wall or in front of each other, or build a platform together at midpoint. 
- **Setup**: Gives blocks for building.
- **Notable parameters**:

  - Spawn distance constraints: 8–15 blocks.
  - Block types sampled with shared RNG from: ``stone``, ``cobblestone``, ``oak_planks``,
    ``bricks``.
  - Placement delay: 300ms per block.

:js:class:`buildTower <episode-handlers.build-tower-episode.BuildTowerEpisode>`
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

- **What**: Both bots build a tall 1-block tower by jumping and placing blocks underneath themselves.
- **Setup**: Gives blocks for building.
- **Notable parameters**:

  - Spawn distance constraints: 8–15 blocks.
  - Tower height: 8–12 blocks.
  - Block type: ``oak_planks``.

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

Below are the 7 eval episode types and what they do.

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

.. _adding-new-episode-type:

Adding a new episode type
-------------------------

To add a new episode type:

1. **Create the handler module** in `controller/episode-handlers/ <https://github.com/georgysavva/mc-multiplayer-data/tree/release/controller/episode-handlers>`_ (or
   `controller/episode-handlers/eval/ <https://github.com/georgysavva/mc-multiplayer-data/tree/release/controller/episode-handlers/eval>`_ for eval episodes). The module must export a
   class that extends :js:class:`episode-handlers.base-episode.BaseEpisode`.

2. **Register the episode in** `controller/episodes-loop.js <https://github.com/georgysavva/mc-multiplayer-data/tree/release/controller/episodes-loop.js>`_:
   - Add an entry to ``episodeClassMap`` mapping the episode type string (e.g. ``myNewEpisode``) to your class.
   - For eval episodes only: add your class to the ``evalEpisodeClasses`` array.
   - To include it in the default set when ``EPISODE_TYPES`` is unset, add the type string to ``defaultEpisodeTypes``.

3. **Add a typical length** in `controller/utils/episode-weights.js <https://github.com/georgysavva/mc-multiplayer-data/tree/release/controller/utils/episode-weights.js>`_: add your
   episode type key and a typical duration in seconds to ``episodeTypicalLengths``.
   This is used for weighted sampling (shorter episodes are sampled more often). If
   the type is missing, ``selectWeightedEpisodeType()`` will throw.
