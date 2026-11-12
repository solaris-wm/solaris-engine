const {
  initializePathfinder,
  sleep,
  stopPathfinder,
} = require("../primitives/movement");
const { GoalNear } = require("../utils/bot-factory");
const { pickRandom } = require("../utils/coordination");
const { BaseEpisode } = require("./base-episode");
const { chaseRunner } = require("./chase-episode");

const CHASE_DURATION_MS_MIN = 8000;
const CHASE_DURATION_MS_MAX = 20000;
const POSITION_UPDATE_INTERVAL_MS = 500;
const ESCAPE_DISTANCE = 100;

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

async function runFromCentroid(bot, chaserCentroid, chaseDurationMs) {
  console.log(
    `[${bot.username}] 🏃‍♂️ Escaping from chaser centroid for ${
      chaseDurationMs / 1000
    }s`,
  );

  initializePathfinder(bot, {
    allowSprinting: true,
    allowParkour: true,
    canDig: true,
    canPlaceOn: true,
    allowEntityDetection: true,
  });

  const currentPos = bot.entity.position;
  const dx = currentPos.x - chaserCentroid.x;
  const dz = currentPos.z - chaserCentroid.z;
  const horizontalDistance = Math.sqrt(dx * dx + dz * dz);

  let normalizedDx, normalizedDz;
  if (horizontalDistance > 0) {
    normalizedDx = dx / horizontalDistance;
    normalizedDz = dz / horizontalDistance;
  } else {
    normalizedDx = 0;
    normalizedDz = -1;
  }

  const escapeX = currentPos.x + normalizedDx * ESCAPE_DISTANCE;
  const escapeY = currentPos.y;
  const escapeZ = currentPos.z + normalizedDz * ESCAPE_DISTANCE;

  const startTime = Date.now();

  try {
    bot.pathfinder.setGoal(new GoalNear(escapeX, escapeY, escapeZ, 2));
    while (Date.now() - startTime < chaseDurationMs) {
      await sleep(POSITION_UPDATE_INTERVAL_MS);
    }
  } finally {
    stopPathfinder(bot);
    console.log(`[${bot.username}] ✅ Runner escape complete`);
  }
}

function getOnChasePhaseFn(
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
      `chasePhase_${iterationID}`,
      { position: bot.entity.position.clone() },
      episodeNum,
      `chasePhase_${iterationID} beginning`,
    );

    const runnerName = pickRandom(coordinator.getAllPlayerNames(), sharedBotRng);
    const isRunner = bot.username === runnerName;

    console.log(
      `[${bot.username}] 🎭 runner=${runnerName}, I am ${
        isRunner ? "🏃‍♂️ RUNNER" : "🏃 CHASER"
      }`,
    );

    const chaseDurationMs =
      CHASE_DURATION_MS_MIN +
      Math.floor(
        sharedBotRng() * (CHASE_DURATION_MS_MAX - CHASE_DURATION_MS_MIN + 1),
      );

    if (isRunner) {
      const chaserPositions = [...peerMap.values()].map((v) => v.position);
      const chaserCentroid = getCentroid(chaserPositions);
      await runFromCentroid(bot, chaserCentroid, chaseDurationMs);
    } else {
      await chaseRunner(
        bot,
        coordinator,
        runnerName,
        episodeNum,
        chaseDurationMs,
      );
    }

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
      { location: `chasePhase_${iterationID} end` },
    );
  };
}

/**
 * N-player chase. Shared RNG picks one runner; all others chase. Runner flees from the
 * centroid of chasers' positions.
 * @extends BaseEpisode
 */
class ChaseNpEpisode extends BaseEpisode {
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
      `chasePhase_${iterationID}`,
      { position: bot.entity.position.clone() },
      episodeNum,
      getOnChasePhaseFn(
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

module.exports = { ChaseNpEpisode };
