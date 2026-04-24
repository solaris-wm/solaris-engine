const { lookAtSmooth } = require("../primitives/movement");
const { run } = require("../primitives/random-movement");
const { BaseEpisode } = require("./base-episode");

const CAMERA_SPEED_DEGREES_PER_SEC = 60;

const ITERATIONS_NUM_PER_EPISODE = 3;
const MIN_RUN_ACTIONS = 2;
const MAX_RUN_ACTIONS = 4;

function getCentroid(positions) {
  const totals = positions.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }),
    { x: 0, y: 0, z: 0 },
  );
  return {
    x: totals.x / positions.length,
    y: totals.y / positions.length,
    z: totals.z / positions.length,
  };
}

function getOnWalkLookPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  iterationID,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (peerMap) => {
    coordinator.broadcastToPeers(
      `walkLookPhase_${iterationID}`,
      { position: bot.entity.position.clone() },
      episodeNum,
      `walkLookPhase_${iterationID} beginning`,
    );
    const actionCount =
      MIN_RUN_ACTIONS +
      Math.floor(sharedBotRng() * (MAX_RUN_ACTIONS - MIN_RUN_ACTIONS + 1));

    const walkingModes = [
      "all_walk",
      "lowest_name_walks",
      "highest_name_walks",
    ];
    const selectedMode =
      walkingModes[Math.floor(sharedBotRng() * walkingModes.length)];

    console.log(
      `[iter ${iterationID}] [${bot.username}] starting walk phase with ${actionCount} actions - mode: ${selectedMode}`,
    );

    const sortedNames = coordinator.getAllPlayerNames().slice().sort();
    let shouldThisBotWalk = false;
    switch (selectedMode) {
      case "all_walk":
        shouldThisBotWalk = true;
        break;
      case "lowest_name_walks":
        shouldThisBotWalk = bot.username === sortedNames[0];
        break;
      case "highest_name_walks":
        shouldThisBotWalk = bot.username === sortedNames[sortedNames.length - 1];
        break;
    }

    console.log(
      `[iter ${iterationID}] [${bot.username}] will ${
        shouldThisBotWalk ? "walk" : "sleep"
      } during this phase`,
    );

    const peerPositions = [...peerMap.values()].map((v) => v.position);
    const peerCentroid = getCentroid(peerPositions);
    await lookAtSmooth(bot, peerCentroid, CAMERA_SPEED_DEGREES_PER_SEC);

    if (shouldThisBotWalk) {
      await run(bot, actionCount, /*lookAway*/ false, args);
    } else {
      console.log(
        `[iter ${iterationID}] [${bot.username}] not walking this phase`,
      );
    }

    if (iterationID == ITERATIONS_NUM_PER_EPISODE - 1) {
      coordinator.exchangeWithPeers(
        "stopPhase",
        { position: bot.entity.position.clone() },
        episodeNum,
        episodeInstance.getOnStopPhaseFn(
          bot,
          rcon,
          sharedBotRng,
          coordinator,
          episodeNum,
          args,
        ),
        { location: `walkLookPhase_${iterationID} end` },
      );
      return;
    }
    const nextIterationID = iterationID + 1;
    coordinator.exchangeWithPeers(
      `walkLookPhase_${nextIterationID}`,
      { position: bot.entity.position.clone() },
      episodeNum,
      getOnWalkLookPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        nextIterationID,
        episodeNum,
        episodeInstance,
        args,
      ),
      { location: `walkLookPhase_${iterationID} end` },
    );
  };
}

/**
 * N-player walk-and-look episode. Iterations pick one of three modes via shared RNG:
 * all bots walk, only the lowest-sorted name walks, or only the highest-sorted name walks.
 * Non-walking bots look at the peer centroid.
 * @extends BaseEpisode
 */
class WalkLookNpEpisode extends BaseEpisode {
  static WORKS_IN_NON_FLAT_WORLD = true;
  static SUPPORTS_N_PLAYER = true;

  async entryPoint(
    bot,
    rcon,
    sharedBotRng,
    coordinator,
    iterationID,
    episodeNum,
    args,
  ) {
    coordinator.exchangeWithPeers(
      `walkLookPhase_${iterationID}`,
      { position: bot.entity.position.clone() },
      episodeNum,
      getOnWalkLookPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        iterationID,
        episodeNum,
        this,
        args,
      ),
      { location: "teleportPhase end" },
    );
  }

  async tearDownEpisode(
    bot,
    rcon,
    sharedBotRng,
    coordinator,
    episodeNum,
    args,
  ) {
    // optional teardown
  }
}

module.exports = { WalkLookNpEpisode };
