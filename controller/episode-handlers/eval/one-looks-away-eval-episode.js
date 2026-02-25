const {
  lookAtSmooth,
  lookSmooth,
  sneak,
} = require("../../primitives/movement");
const { BaseEpisode } = require("../base-episode");

const CAMERA_SPEED_DEGREES_PER_SEC = 30;
const ITERATIONS_NUM_PER_EPISODE = 1;
const MIN_LOOK_AWAY_DURATION_SEC = 1.0;
const MAX_LOOK_AWAY_DURATION_SEC = 1.0;
const EPISODE_MIN_TICKS = 300;

function getOnOneLooksAwayPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  iterationID,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (otherBotPosition) => {
    coordinator.sendToOtherBot(
      `oneLooksAwayPhase_${iterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      `oneLooksAwayPhase_${iterationID} beginning`,
    );

    // Deterministic mode selection based on episode number
    const walkingModes = [
      "lower_name_looks_away",
      "bigger_name_looks_away",
    ];
    const selectedMode = walkingModes[episodeNum % 2];

    console.log(
      `[iter ${iterationID}] [${bot.username}] starting look away phase - mode: ${selectedMode}`,
    );

    // Determine if this bot should look away based on the selected mode
    let shouldThisBotLookAway = false;
    let botsChosen = [];

    switch (selectedMode) {
      case "lower_name_looks_away":
        shouldThisBotLookAway = bot.username < args.other_bot_name;
        botsChosen = [
          bot.username < args.other_bot_name
            ? bot.username
            : args.other_bot_name,
        ];
        break;
      case "bigger_name_looks_away":
        shouldThisBotLookAway = bot.username > args.other_bot_name;
        botsChosen = [
          bot.username > args.other_bot_name
            ? bot.username
            : args.other_bot_name,
        ];
        break;
      case "both_look_away":
        shouldThisBotLookAway = true;
        botsChosen = [bot.username, args.other_bot_name].sort();
        break;
    }

    // Look at the other bot smoothly at the start of the phase
    await lookAtSmooth(bot, otherBotPosition, CAMERA_SPEED_DEGREES_PER_SEC, {
      randomized: false,
      useEasing: false,
    });
    // pick (the same) look away direction randomly. -1 means left, 1 means right.
    const lookAwayDirection = sharedBotRng() < 0.5 ? -1 : 1;
    // pick a look away offset randomly between 90 +/- 22.5 degrees.
    const lookAwayOffsetDeg =
      90 * lookAwayDirection + sharedBotRng() * 45 - 22.5;
    const freezeTicks = 20;

    episodeInstance._evalMetadata = {
      bots_chosen: botsChosen,
      mode: selectedMode,
      camera_speed_degrees_per_sec: CAMERA_SPEED_DEGREES_PER_SEC,
      look_away_offset_deg: lookAwayOffsetDeg,
      look_away_direction: lookAwayDirection,
      freeze_ticks: freezeTicks,
    };

    console.log(
      `[iter ${iterationID}] [${bot.username}] will ${
        shouldThisBotLookAway ? "look away" : "keep looking"
      } during this phase`,
    );

    // Either look away or stay looking based on the mode
    if (shouldThisBotLookAway) {
      // sneak to signal evaluation start
      await sneak(bot);
      // Record tick number
      const startTick = bot.time.age;

      // Save bot's original pitch and yaw
      const originalYaw = bot.entity.yaw;
      const originalPitch = bot.entity.pitch;
      const newYaw =
        originalYaw + Math.PI + (lookAwayOffsetDeg * Math.PI) / 180;

      console.log(
        `[iter ${iterationID}] [${bot.username}] looking away (offset: ${lookAwayOffsetDeg.toFixed(1)}°)`,
      );
      await lookSmooth(
        bot,
        newYaw,
        originalPitch,
        CAMERA_SPEED_DEGREES_PER_SEC,
        { randomized: false, useEasing: false },
      );
      await bot.waitForTicks(freezeTicks);

      // Look back at the other bot
      console.log(
        `[iter ${iterationID}] [${bot.username}] looking back at other bot`,
      );
      await lookSmooth(
        bot,
        originalYaw,
        originalPitch,
        CAMERA_SPEED_DEGREES_PER_SEC,
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
    } else {
      // Do nothing
    }

    if (iterationID == ITERATIONS_NUM_PER_EPISODE - 1) {
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
        `lookAwayPhase_${iterationID} end`,
      );
      return;
    }
    const nextIterationID = iterationID + 1;
    coordinator.onceEvent(
      `oneLooksAwayPhase_${nextIterationID}`,
      episodeNum,
      getOnOneLooksAwayPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        nextIterationID,
        episodeNum,
        episodeInstance,
        args,
      ),
    );
    coordinator.sendToOtherBot(
      `oneLooksAwayPhase_${nextIterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      `oneLooksAwayPhase_${iterationID} end`,
    );
  };
}

/**
 * Eval episode where one bot (lower or bigger name, by episode number) looks away by a random
 * offset after initial eye contact; used to evaluate look-away behavior.
 * @extends BaseEpisode
 */
class OneLooksAwayEvalEpisode extends BaseEpisode {
  static WORKS_IN_NON_FLAT_WORLD = true;
  static INIT_MIN_BOTS_DISTANCE = 10; // Override: bots spawn 10-12 blocks apart
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
      `oneLooksAwayPhase_${iterationID}`,
      episodeNum,
      getOnOneLooksAwayPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        iterationID,
        episodeNum,
        this,
        args,
      ),
    );
    coordinator.sendToOtherBot(
      `oneLooksAwayPhase_${iterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      "teleportPhase end",
    );
  }
}

module.exports = { OneLooksAwayEvalEpisode };
