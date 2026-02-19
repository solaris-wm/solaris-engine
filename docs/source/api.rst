API reference
=============

Episodes loop
~~~~~~~~~~~~~
`[Source] <https://github.com/georgysavva/mc-multiplayer-data/tree/release/controller/episodes-loop.js>`_

.. js:autofunction:: episodes-loop.getOnSpawnFn

.. js:autofunction:: episodes-loop.isEvalEpisode

.. js:autofunction:: episodes-loop.saveEpisodeInfo

.. js:autofunction:: episodes-loop.runSingleEpisode

.. js:autofunction:: episodes-loop.notifyPeerErrorAndStop

.. js:autofunction:: episodes-loop.setupBotAndWorldOnce

.. js:autofunction:: episodes-loop.setupCameraPlayerOnce

.. js:autofunction:: episodes-loop.setupBotAndCameraForEpisode

.. js:autofunction:: episodes-loop.clearBotInventory

.. js:autofunction:: episodes-loop.getOnTeleportPhaseFn

.. js:autofunction:: episodes-loop.getOnPostTeleportPhaseFn

.. js:autofunction:: episodes-loop.getOnSetupEpisodeFn

.. js:autofunction:: episodes-loop.getOnStartRecordingFn

.. js:autofunction:: episodes-loop.teleport

.. js:autofunction:: episodes-loop.getOnPeerErrorPhaseFn


Episode classes
~~~~~~~~~~~~~~~

`[Source] <https://github.com/georgysavva/mc-multiplayer-data/tree/release/controller/episode-handlers>`_

All episode handlers extend :js:class:`episode-handlers/base-episode.BaseEpisode` and implement
:js:meth:`episode-handlers/base-episode.BaseEpisode.entryPoint` (and optionally
:js:meth:`episode-handlers/base-episode.BaseEpisode.setupEpisode` and
:js:meth:`episode-handlers/base-episode.BaseEpisode.tearDownEpisode`).

Base
^^^^

.. _api-base-episode:

.. js:autoclass:: episode-handlers/base-episode.BaseEpisode
   :members:

.. _api-training-episodes:

Training episodes
^^^^^^^^^^^^^^^^^

.. _api-episode-buildHouse:

.. js:autoclass:: episode-handlers/build-house-episode.BuildHouseEpisode
   :members:

.. _api-episode-buildStructure:

.. js:autoclass:: episode-handlers/build-structure-episode.BuildStructureEpisode
   :members:

.. _api-episode-buildTower:

.. js:autoclass:: episode-handlers/build-tower-episode.BuildTowerEpisode
   :members:

.. _api-episode-chase:

.. js:autoclass:: episode-handlers/chase-episode.ChaseEpisode
   :members:

.. _api-episode-collector:

.. js:autoclass:: episode-handlers/collector-episode.CollectorEpisode
   :members:

.. _api-episode-mine:

.. js:autoclass:: episode-handlers/mine-episode.MineEpisode
   :members:

.. _api-episode-orbit:

.. js:autoclass:: episode-handlers/orbit-episode.OrbitEpisode
   :members:

.. _api-episode-placeAndMine:

.. js:autoclass:: episode-handlers/place-and-mine-episode.PlaceAndMineEpisode
   :members:

.. _api-episode-pve:

.. js:autoclass:: episode-handlers/pve-episode.PveEpisode
   :members:

.. _api-episode-pvp:

.. js:autoclass:: episode-handlers/pvp-episode.PvpEpisode
   :members:

.. _api-episode-straightLineWalk:

.. js:autoclass:: episode-handlers/straight-line-episode.StraightLineEpisode
   :members:

.. _api-episode-towerBridge:

.. js:autoclass:: episode-handlers/tower-bridge-episode.TowerBridgeEpisode
   :members:

.. _api-episode-walkLook:

.. js:autoclass:: episode-handlers/walk-look-episode.WalkLookEpisode
   :members:

.. _api-episode-walkLookAway:

.. js:autoclass:: episode-handlers/walk-look-away-episode.WalkLookAwayEpisode
   :members:

Eval episodes
^^^^^^^^^^^^^

.. _api-episode-bothLookAwayEval:

.. js:autoclass:: episode-handlers/eval/both-look-away-eval-episode.BothLookAwayEvalEpisode
   :members:

.. _api-episode-oneLooksAwayEval:

.. js:autoclass:: episode-handlers/eval/one-looks-away-eval-episode.OneLooksAwayEvalEpisode
   :members:

.. _api-episode-rotationEval:

.. js:autoclass:: episode-handlers/eval/rotation-eval-episode.RotationEvalEpisode
   :members:

.. _api-episode-structureEval:

.. js:autoclass:: episode-handlers/eval/structure-eval-episode.StructureEvalEpisode
   :members:

.. _api-episode-translationEval:

.. js:autoclass:: episode-handlers/eval/translation-eval-episode.TranslationEvalEpisode
   :members:

.. _api-episode-turnToLookEval:

.. js:autoclass:: episode-handlers/eval/turn-to-look-eval-episode.TurnToLookEvalEpisode
   :members:

.. _api-episode-turnToLookOppositeEval:

.. js:autoclass:: episode-handlers/eval/turn-to-look-opposite-eval-episode.TurnToLookOppositeEvalEpisode
   :members:


Primitives
~~~~~~~~~~

`[Source] <https://github.com/georgysavva/mc-multiplayer-data/tree/release/controller/primitives>`_

.. _api-building:

Building
^^^^^^^^

.. js:autofunction:: primitives/building.makeHouseBlueprint5x5

.. js:autofunction:: primitives/building.rotateLocalToWorld

.. js:autofunction:: primitives/building.splitWorkByXAxis

.. js:autofunction:: primitives/building.calculateMaterialCounts

.. js:autofunction:: primitives/building.buildPhase

.. js:autofunction:: primitives/building.buildBridge

.. js:autofunction:: primitives/building.cleanupScaffolds

.. js:autofunction:: primitives/building.admireHouse

.. js:autofunction:: primitives/building.calculateFloorPlacementOrder

.. js:autofunction:: primitives/building.getPerimeterPosition

.. js:autofunction:: primitives/building.calculateWallPlacementOrder

.. js:autofunction:: primitives/building.calculateRoofPlacementOrder

.. js:autofunction:: primitives/building.isBotCollidingWithBlock

.. js:autofunction:: primitives/building.placeAt

.. js:autofunction:: primitives/building.placeMultiple

.. js:autofunction:: primitives/building.isAirLike

.. js:autofunction:: primitives/building.inReach

.. js:autofunction:: primitives/building.findPlaceReference

.. js:autofunction:: primitives/building.ensureReachAndSight

.. js:autofunction:: primitives/building.fastPlaceBlock

.. js:autofunction:: primitives/building.buildTowerUnderneath

.. js:autofunction:: primitives/building.scoreFace

.. js:autofunction:: primitives/building.findBestPlaceReference

.. js:autofunction:: primitives/building.raycastToPosition

.. js:autofunction:: primitives/building.isBlockObstructed

.. js:autofunction:: primitives/building.canSeeFace

.. js:autofunction:: primitives/building.isPositionSafe

.. js:autofunction:: primitives/building.calculateOptimalPosition

.. js:autofunction:: primitives/building.moveToPlacementPosition

.. js:autofunction:: primitives/building.hasAdjacentSupport

.. js:autofunction:: primitives/building.sortByBuildability

.. js:autofunction:: primitives/building.prepareForPlacement

.. js:autofunction:: primitives/building.buildStructure

.. js:autofunction:: primitives/building.getBlockPlaceDelayTicks

.. _api-digging:

Digging
^^^^^^^

.. js:autofunction:: primitives/digging.digWithTimeout

.. js:autofunction:: primitives/digging.digBlock

.. js:autofunction:: primitives/digging.placeTorchOnFloor

.. js:autofunction:: primitives/digging.placeTorch

.. js:autofunction:: primitives/digging.findVisibleOres

.. js:autofunction:: primitives/digging.isBlockVisible

.. _api-fighting:

Fighting
^^^^^^^^

.. js:autofunction:: primitives/fighting.giveRandomSword

.. js:autofunction:: primitives/fighting.equipSword

.. js:autofunction:: primitives/fighting.isInForwardFOV

Items
^^^^^

.. js:autofunction:: primitives/items.unequipHand

.. js:autofunction:: primitives/items.ensureBotHasEnough

.. js:autofunction:: primitives/items.ensureItemInHand

.. _api-movement:

Movement
^^^^^^^^

.. js:autofunction:: primitives/movement.stopAll

.. js:autofunction:: primitives/movement.setControls

.. js:autofunction:: primitives/movement.enableSprint

.. js:autofunction:: primitives/movement.disableSprint

.. js:autofunction:: primitives/movement.initializePathfinder

.. js:autofunction:: primitives/movement.stopPathfinder

.. js:autofunction:: primitives/movement.gotoWithTimeout

.. js:autofunction:: primitives/movement.moveDirection

.. js:autofunction:: primitives/movement.moveToward

.. js:autofunction:: primitives/movement.moveAway

.. js:autofunction:: primitives/movement.lookAtSmooth

.. js:autofunction:: primitives/movement.lookSmooth

.. js:autofunction:: primitives/movement.lookAtBot

.. js:autofunction:: primitives/movement.lookDirection

.. js:autofunction:: primitives/movement.sleep

.. js:autofunction:: primitives/movement.distanceTo

.. js:autofunction:: primitives/movement.horizontalDistanceTo

.. js:autofunction:: primitives/movement.getDirectionTo

.. js:autofunction:: primitives/movement.isNearPosition

.. js:autofunction:: primitives/movement.isNearBot

.. js:autofunction:: primitives/movement.land_pos

.. js:autofunction:: primitives/movement.jump

.. js:autofunction:: primitives/movement.sneak

.. js:autofunction:: primitives/movement.directTeleport

.. js:autofunction:: primitives/movement.getScaffoldingBlockIds

Random-movement
^^^^^^^^^^^^^^^

.. js:autofunction:: primitives/random-movement.walk

.. js:autofunction:: primitives/random-movement.run

.. js:autofunction:: primitives/random-movement.getRandomDirection
