const {
  lookAtSmooth,
  sneak,
} = require("../../primitives/movement");
const { BaseEpisode } = require("../base-episode");

const CAMERA_SPEED_DEGREES_PER_SEC = 30;
const EPISODE_MIN_TICKS = 300;

function getOnBlindTurnPhaseFn(
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
      "blindTurnPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      "blindTurnPhase beginning",
    );

    // Read roles stored by setupEpisode (avoids RNG sequence mismatch)
    const blindBotName = episodeInstance._blindBotName;
    const watcherBotName = episodeInstance._watcherBotName;
    const isBlindBot = episodeInstance._isBlindBot;
    const sideDir = episodeInstance._sideDir;

    const me = bot.entity.position;
    const them = otherBotPosition;
    const vx = them.x - me.x;
    const vz = them.z - me.z;
    const mag = Math.sqrt(vx * vx + vz * vz) || 1;
    const nx = vx / mag;
    const nz = vz / mag;
    const sideX = -nz * sideDir;
    const sideZ = nx * sideDir;

    episodeInstance._evalMetadata = {
      blind_bot: blindBotName,
      watcher_bot: watcherBotName,
      role_assignment_mode: "sharedBotRng",
      camera_speed_degrees_per_sec: CAMERA_SPEED_DEGREES_PER_SEC,
      turn_degrees: 90,
      side_vector: { x: sideX, z: sideZ },
    };

    // Both bots sneak to signal evaluation start
    await sneak(bot);
    const startTick = bot.time.age;

    if (isBlindBot) {
      console.log(
        `[${bot.username}] Blind turn: I am the blind bot, turning 90° to face watcher`,
      );

      // Slowly turn 90° to face the watcher
      await lookAtSmooth(bot, otherBotPosition, CAMERA_SPEED_DEGREES_PER_SEC, {
        randomized: false,
        useEasing: false,
      });

    } else {
      console.log(
        `[${bot.username}] Blind turn: I am the watcher, holding still`,
      );
    }

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
      { location: "blindTurnPhase end" },
    );
  };
}

/**
 * Eval episode where one bot (the "blind" bot) starts facing 90° sideways and slowly
 * turns to face the watcher bot; used to evaluate single-bot turning prediction.
 * @extends BaseEpisode
 */
class BlindTurnEvalEpisode extends BaseEpisode {
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
    // Determine roles and store on instance so phase handler can read them
    const blindRoll = sharedBotRng();
    const sortedNames = [bot.username, peerName].sort();
    const blindBotName = blindRoll < 0.5 ? sortedNames[0] : sortedNames[1];
    const watcherBotName =
      blindBotName === bot.username ? peerName : bot.username;
    const isBlindBot = bot.username === blindBotName;
    const sideDir = sharedBotRng() < 0.5 ? 1 : -1;

    this._blindBotName = blindBotName;
    this._watcherBotName = watcherBotName;
    this._isBlindBot = isBlindBot;
    this._sideDir = sideDir;

    if (isBlindBot) {
      // Blind bot faces 90° sideways (perpendicular to connecting line)
      const dx = otherBotPosition.x - botPosition.x;
      const dz = otherBotPosition.z - botPosition.z;
      const mag = Math.sqrt(dx * dx + dz * dz) || 1;
      const nx = dx / mag;
      const nz = dz / mag;

      // Perpendicular vector
      const sideX = -nz * sideDir;
      const sideZ = nx * sideDir;

      const fakeTarget = botPosition.offset(sideX * 10, 0, sideZ * 10);
      return fakeTarget;
    } else {
      // Watcher faces the blind bot (actual other bot position)
      return otherBotPosition;
    }
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
      "blindTurnPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      getOnBlindTurnPhaseFn(
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

module.exports = { BlindTurnEvalEpisode };
