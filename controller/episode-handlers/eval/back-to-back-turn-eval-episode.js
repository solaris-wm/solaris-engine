const {
  lookAtSmooth,
  sneak,
} = require("../../primitives/movement");
const { BaseEpisode } = require("../base-episode");

const EPISODE_MIN_TICKS = 300;
const MIN_TURN_SPEED = 20;
const MAX_TURN_SPEED = 40;
const MIN_OFFSET = Math.PI / 3; // 60° — keeps other bot out of FOV (54° half-FOV + 6° margin)

function getOnBackToBackTurnPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (peerMap) => {
    const peerName = coordinator.getSinglePeerName();
    const otherBotPosition = peerMap.values().next().value.position;
    coordinator.broadcastToPeers(
      "backToBackTurnPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      "backToBackTurnPhase beginning",
    );

    // Generate per-bot turn speeds from shared RNG (deterministic order)
    const speedAlpha =
      MIN_TURN_SPEED + sharedBotRng() * (MAX_TURN_SPEED - MIN_TURN_SPEED);
    const speedBravo =
      MIN_TURN_SPEED + sharedBotRng() * (MAX_TURN_SPEED - MIN_TURN_SPEED);

    const isAlpha = bot.username < peerName;
    const mySpeed = isAlpha ? speedAlpha : speedBravo;

    // Compute actual turn angle from current yaw to the other bot
    const dx = otherBotPosition.x - bot.entity.position.x;
    const dz = otherBotPosition.z - bot.entity.position.z;
    const targetYaw = Math.atan2(-dx, -dz);
    let turnAngle = targetYaw - bot.entity.yaw;
    turnAngle = ((turnAngle + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    const turnDegrees = Math.abs(turnAngle) * (180 / Math.PI);

    episodeInstance._evalMetadata = {
      yaw_alpha_start: episodeInstance._yawAlpha,
      yaw_bravo_start: episodeInstance._yawBravo,
      camera_speed_alpha: speedAlpha,
      camera_speed_bravo: speedBravo,
      turn_degrees: Math.round(turnDegrees * 10) / 10,
    };

    console.log(
      `[${bot.username}] Back-to-back turn: turning ${turnDegrees.toFixed(1)}° at ${mySpeed.toFixed(1)}°/sec`,
    );

    // Sneak to signal evaluation start
    await sneak(bot);
    const startTick = bot.time.age;

    // Turn to face the other bot (no epsilon needed — randomized angles won't be exactly 180°)
    await lookAtSmooth(bot, otherBotPosition, mySpeed, {
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
      { location: "backToBackTurnPhase end" },
    );
  };
}

/**
 * Eval episode where bots start facing random directions away from each other (at least 60° off
 * the toward-other-bot axis) and turn to face each other at different speeds; used to evaluate
 * turning prediction with varied starting orientations and asymmetric rotation.
 * @extends BaseEpisode
 */
class BackToBackTurnEvalEpisode extends BaseEpisode {
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
    // Direction toward the other bot (Minecraft yaw convention)
    const dxToOther = otherBotPosition.x - botPosition.x;
    const dzToOther = otherBotPosition.z - botPosition.z;
    const towardOther = Math.atan2(-dxToOther, -dzToOther);

    // Sample two random offsets from the valid arc [MIN_OFFSET, 2π - MIN_OFFSET].
    // This keeps the other bot at least 60° outside each bot's FOV.
    const offset1 =
      MIN_OFFSET + sharedBotRng() * (2 * Math.PI - 2 * MIN_OFFSET);
    const offset2 =
      MIN_OFFSET + sharedBotRng() * (2 * Math.PI - 2 * MIN_OFFSET);

    // Assign offsets deterministically by name sorting
    const isAlpha = bot.username < peerName;
    const myOffset = isAlpha ? offset1 : offset2;

    // Compute randomized yaw for this bot, wrapped to [-π, π]
    let myYaw = towardOther + myOffset;
    myYaw = ((myYaw + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;

    // Compute the other bot's yaw (its towardOther is reversed by π)
    const otherOffset = isAlpha ? offset2 : offset1;
    let otherYaw = towardOther + Math.PI + otherOffset;
    otherYaw = ((otherYaw + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;

    // Store yaw values on instance for the phase handler to set metadata
    this._yawAlpha = isAlpha ? myYaw : otherYaw;
    this._yawBravo = isAlpha ? otherYaw : myYaw;

    // Compute fake target 10 blocks in the assigned yaw direction.
    // Minecraft: yaw = atan2(-dx, -dz), so dx = -sin(yaw), dz = -cos(yaw)
    const dx = -Math.sin(myYaw);
    const dz = -Math.cos(myYaw);
    const fakeTarget = botPosition.offset(dx * 10, 0, dz * 10);

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
      "backToBackTurnPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      getOnBackToBackTurnPhaseFn(
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

module.exports = { BackToBackTurnEvalEpisode };
