const {
  lookAtSmooth,
  sneak,
} = require("../../primitives/movement");
const { BaseEpisode } = require("../base-episode");

const CAMERA_SPEED_DEGREES_PER_SEC = 30;
const EPISODE_MIN_TICKS = 300;

function getOnParallelTurnPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (peerMap) => {
    const otherBotPosition = peerMap.values().next().value.position;
    coordinator.broadcastToPeers(
      "parallelTurnPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      "parallelTurnPhase beginning",
    );

    console.log(
      `[${bot.username}] Parallel turn: turning 90° to face other bot at ${CAMERA_SPEED_DEGREES_PER_SEC}°/sec`,
    );

    // Sneak to signal evaluation start
    await sneak(bot);
    const startTick = bot.time.age;

    // Turn 90° to face the other bot
    await lookAtSmooth(bot, otherBotPosition, CAMERA_SPEED_DEGREES_PER_SEC, {
      randomized: false,
      useEasing: false,
    });

    // Wait for minimum ticks
    const endTick = bot.time.age;
    const remaining = EPISODE_MIN_TICKS - (endTick - startTick);
    if (remaining > 0) {
      console.log(
        `[${bot.username}] Waiting ${remaining} more ticks to reach ${EPISODE_MIN_TICKS}`,
      );
      await bot.waitForTicks(remaining);
    }

    // Setup stop phase
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
      { location: "parallelTurnPhase end" },
    );
  };
}

/**
 * Eval episode where both bots start facing the same world direction (parallel) and
 * turn 90° to face each other; used to evaluate symmetric turning prediction.
 * @extends BaseEpisode
 */
class ParallelTurnEvalEpisode extends BaseEpisode {
  static WORKS_IN_NON_FLAT_WORLD = false;
  static INIT_MIN_BOTS_DISTANCE = 10;
  static INIT_MAX_BOTS_DISTANCE = 12;

  async setupEpisode(
    bot,
    rcon,
    sharedBotRng,
    coordinator,
    episodeNum,
    args,
    botPosition,
    peerPositionsMap,
  ) {
    const peerName = coordinator.getSinglePeerName();
    const otherBotPosition = peerPositionsMap.values().next().value;
    // Compute canonical connecting vector (alphabetically-first bot → second bot)
    const sortedNames = [bot.username, peerName].sort();
    const isAlpha = bot.username === sortedNames[0];

    // Canonical vector: alpha → bravo
    let canonVx, canonVz;
    if (isAlpha) {
      canonVx = otherBotPosition.x - botPosition.x;
      canonVz = otherBotPosition.z - botPosition.z;
    } else {
      canonVx = botPosition.x - otherBotPosition.x;
      canonVz = botPosition.z - otherBotPosition.z;
    }
    const mag = Math.sqrt(canonVx * canonVx + canonVz * canonVz) || 1;
    canonVx /= mag;
    canonVz /= mag;

    // Compute perpendicular: rotate canonical vector 90°
    const perpX = -canonVz;
    const perpZ = canonVx;

    // Pick which perpendicular side
    const dir = sharedBotRng() < 0.5 ? 1 : -1;

    this._evalMetadata = {
      camera_speed_degrees_per_sec: CAMERA_SPEED_DEGREES_PER_SEC,
      turn_degrees: 90,
      perpendicular_direction: dir,
      perp_vector: { x: perpX * dir, z: perpZ * dir },
    };

    // Both bots face the same world direction: perpendicular to connecting line
    const fakeTarget = botPosition.offset(
      perpX * dir * 10,
      0,
      perpZ * dir * 10,
    );

    return fakeTarget;
  }

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
      "parallelTurnPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      getOnParallelTurnPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        this,
        args,
      ),
      { location: "teleportPhase end" },
    );
  }
}

module.exports = { ParallelTurnEvalEpisode };
