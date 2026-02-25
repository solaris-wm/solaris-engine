const {
  lookAtSmooth,
  sneak,
  lookSmooth,
} = require("../../primitives/movement");
const { BaseEpisode } = require("../base-episode");
const THIS_CAMERA_SPEED_DEGREES_PER_SEC = 30;
const EPISODE_MIN_TICKS = 300;

function getOnRotatePhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (otherBotPosition) => {
    coordinator.sendToOtherBot(
      "rotatePhase",
      bot.entity.position.clone(),
      episodeNum,
      "rotatePhase beginning",
    );

    // Look at the other bot smoothly at the start of the phase
    await lookAtSmooth(bot, otherBotPosition, 120, {
      randomized: false,
      useEasing: false,
    });

    // Determine which bot rotates and by how much based on episodeNum % 6
    // 0: Alpha +45, 1: Alpha -45, 2: Alpha 180
    // 3: Bravo +45, 4: Bravo -45, 5: Bravo 180
    const caseNum = episodeNum % 6;
    const alphaShouldRotate = caseNum < 3;
    const bravoShouldRotate = caseNum >= 3;

    const rotationAngles = [40, -40, 180, 40, -40, 180];
    const rotationDegrees = rotationAngles[caseNum];

    const shouldThisBotRotate =
      (bot.username < args.other_bot_name && alphaShouldRotate) ||
      (bot.username > args.other_bot_name && bravoShouldRotate);

    // Determine which bot name is chosen to rotate
    const botChosen = alphaShouldRotate
      ? bot.username < args.other_bot_name
        ? bot.username
        : args.other_bot_name
      : bot.username > args.other_bot_name
        ? bot.username
        : args.other_bot_name;

    // Store eval metadata
    episodeInstance._evalMetadata = {
      bots_chosen: [botChosen],
      rotation_degrees: rotationDegrees,
      camera_speed_degrees_per_sec: THIS_CAMERA_SPEED_DEGREES_PER_SEC,
      case_num: caseNum,
    };

    console.log(
      `[${bot.username}] Episode ${episodeNum} case ${caseNum}: will ${
        shouldThisBotRotate ? `rotate ${rotationDegrees} degrees` : "stay still"
      }`,
    );

    if (shouldThisBotRotate) {
      // Sneak to signal evaluation start
      await sneak(bot);
      // Record tick number
      const startTick = bot.time.age;

      // Calculate target position for the rotation
      const originalYaw = bot.entity.yaw;
      const originalPitch = bot.entity.pitch;
      const newYaw = originalYaw + (rotationDegrees * Math.PI) / 180;

      console.log(
        `[${bot.username}] Rotating from ${((originalYaw * 180) / Math.PI).toFixed(1)}° to ${((newYaw * 180) / Math.PI).toFixed(1)}°`,
      );
      await lookSmooth(
        bot,
        newYaw,
        originalPitch,
        THIS_CAMERA_SPEED_DEGREES_PER_SEC,
        { randomized: false, useEasing: false },
      );
      // Record tick number
      const endTick = bot.time.age;
      const remainingTicks = EPISODE_MIN_TICKS - (endTick - startTick);
      if (remainingTicks > 0) {
        console.log(
          `[${bot.username}] Waiting ${remainingTicks} more ticks to reach ${EPISODE_MIN_TICKS} total ticks`,
        );
        await bot.waitForTicks(remainingTicks);
      } else {
        console.log(
          `[${bot.username}] Already passed ${EPISODE_MIN_TICKS} ticks (elapsed: ${endTick - startTick})`,
        );
      }
    }

    // Setup stop phase
    coordinator.onceEvent(
      "stopPhase",
      episodeNum,
      episodeInstance.getOnStopPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        args.other_bot_name,
        episodeNum,
        args,
      ),
    );

    coordinator.sendToOtherBot(
      "stopPhase",
      bot.entity.position.clone(),
      episodeNum,
      "rotatePhase end",
    );
  };
}

/**
 * Eval episode for rotation: one bot (alpha or bravo, by episode number) rotates yaw by a fixed
 * angle (+40°, -40°, or 180°) while the other stays; used to evaluate camera rotation.
 * @extends BaseEpisode
 */
class RotationEvalEpisode extends BaseEpisode {
  static WORKS_IN_NON_FLAT_WORLD = true;
  static INIT_MIN_BOTS_DISTANCE = 10;
  static INIT_MAX_BOTS_DISTANCE = 12;

  async entryPoint(
    bot,
    rcon,
    sharedBotRng,
    coordinator,
    iterationID,
    episodeNum,
    args,
  ) {
    coordinator.onceEvent(
      "rotatePhase",
      episodeNum,
      getOnRotatePhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        this,
        args,
      ),
    );
    coordinator.sendToOtherBot(
      "rotatePhase",
      bot.entity.position.clone(),
      episodeNum,
      "teleportPhase end",
    );
  }
}

module.exports = { RotationEvalEpisode };
