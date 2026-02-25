const {
  lookAtSmooth,
  sneak,
  gotoWithTimeout,
} = require("../../primitives/movement");
const { run } = require("../../primitives/random-movement");
const { BaseEpisode } = require("../base-episode");
const { GoalXZ } = require("../../utils/bot-factory");

const CAMERA_SPEED_DEGREES_PER_SEC = 30;

const ITERATIONS_NUM_PER_EPISODE = 1;
const MIN_RUN_ACTIONS = 1;
const MAX_RUN_ACTIONS = 1;
const EPISODE_MIN_TICKS = 300;

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
  return async (otherBotPosition) => {
    coordinator.sendToOtherBot(
      `walkLookPhase_${iterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      `walkLookPhase_${iterationID} beginning`,
    );
    const actionCount =
      MIN_RUN_ACTIONS +
      Math.floor(sharedBotRng() * (MAX_RUN_ACTIONS - MIN_RUN_ACTIONS + 1));

    // Deterministic mode selection based on episode number
    // Removed the "both_bots_walk" mode because we want to evaluate the bot's ability to walk alone
    const walkingModes = ["lower_name_walks", "bigger_name_walks"];
    const selectedMode = walkingModes[episodeNum % 2];

    console.log(
      `[iter ${iterationID}] [${bot.username}] starting walk phase with ${actionCount} actions - mode: ${selectedMode}`,
    );

    // Determine if this bot should walk based on the selected mode
    let shouldThisBotWalk = false;
    let botsChosen = [];

    switch (selectedMode) {
      case "both_bots_walk":
        shouldThisBotWalk = true;
        botsChosen = [bot.username, args.other_bot_name].sort();
        break;
      case "lower_name_walks":
        shouldThisBotWalk = bot.username < args.other_bot_name;
        botsChosen = [
          bot.username < args.other_bot_name
            ? bot.username
            : args.other_bot_name,
        ];
        break;
      case "bigger_name_walks":
        shouldThisBotWalk = bot.username > args.other_bot_name;
        botsChosen = [
          bot.username > args.other_bot_name
            ? bot.username
            : args.other_bot_name,
        ];
        break;
    }

    episodeInstance._evalMetadata = {
      bots_chosen: botsChosen,
      mode: selectedMode,
      camera_speed_degrees_per_sec: CAMERA_SPEED_DEGREES_PER_SEC,
      min_run_actions: MIN_RUN_ACTIONS,
      max_run_actions: MAX_RUN_ACTIONS,
    };

    console.log(
      `[iter ${iterationID}] [${bot.username}] will ${
        shouldThisBotWalk ? "walk" : "sleep"
      } during this phase`,
    );

    // Look at the other bot smoothly at the start of the phase
    await lookAtSmooth(
      bot,
      otherBotPosition,
      CAMERA_SPEED_DEGREES_PER_SEC * 4,
      { randomized: false, useEasing: false },
    );

    // Either run() or sleep() based on the mode
    if (shouldThisBotWalk) {
      // Sneak to signal that eval should start, and which bot is walking.
      await sneak(bot);
      // Record tick number after sneak
      const startTick = bot.time.age;

      await run(
        bot,
        actionCount,
        /*lookAway*/ false,
        args,
        episodeInstance.constructor.MOVEMENT_CONSTANTS,
      );

      // Wait for minimum ticks if needed
      const endTick = bot.time.age;
      const remainingTicks = EPISODE_MIN_TICKS - (endTick - startTick);
      if (remainingTicks > 0) {
        console.log(
          `[iter ${iterationID}] [${bot.username}] waiting ${remainingTicks} more ticks to reach ${EPISODE_MIN_TICKS} total ticks`,
        );
        await bot.waitForTicks(remainingTicks);
      } else {
        console.log(
          `[iter ${iterationID}] [${bot.username}] already passed ${EPISODE_MIN_TICKS} ticks (elapsed: ${endTick - startTick})`,
        );
      }
    } else {
      // Bot doesn't run, so no sleep is needed
      console.log(
        `[iter ${iterationID}] [${bot.username}] not walking this phase`,
      );
    }

    if (iterationID == ITERATIONS_NUM_PER_EPISODE - 1) {
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
        `walkLookPhase_${iterationID} end`,
      );
      return;
    }
    const nextIterationID = iterationID + 1;
    coordinator.onceEvent(
      `walkLookPhase_${nextIterationID}`,
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
    );
    coordinator.sendToOtherBot(
      `walkLookPhase_${nextIterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      `walkLookPhase_${iterationID} end`,
    );
  };
}

/**
 * Eval episode for translation: one bot (by episode number) aligns to the other along one axis,
 * then walks using run(); used to evaluate movement/translation.
 * @extends BaseEpisode
 */
class TranslationEvalEpisode extends BaseEpisode {
  static WORKS_IN_NON_FLAT_WORLD = true;
  static INIT_MIN_BOTS_DISTANCE = 10; // Override: bots spawn 10-12 blocks apart
  static INIT_MAX_BOTS_DISTANCE = 12;

  // Custom movement constants for this episode type
  static MOVEMENT_CONSTANTS = {
    MIN_WALK_DISTANCE: 6,
    MAX_WALK_DISTANCE: 9,
    JUMP_PROBABILITY: 0.0,
  };

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
      `walkLookPhase_${iterationID}`,
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
    );
    const shouldAlignRng = sharedBotRng();
    const shouldThisBotAlign =
      bot.username < args.other_bot_name
        ? shouldAlignRng < 0.5
        : shouldAlignRng >= 0.5;
    // Make Bravo bot align to Alpha bot's location along one principal axis (shortest distance)
    if (shouldThisBotAlign) {
      const otherBotPosition =
        bot.players[args.other_bot_name]?.entity.position;
      // Align to other bot's location along one principal axis (shortest distance)
      const botPos = bot.entity.position;
      const dx = Math.abs(otherBotPosition.x - botPos.x);
      const dz = Math.abs(otherBotPosition.z - botPos.z);

      let targetX, targetZ;
      if (dx < dz) {
        // Align x axis (shorter distance)
        targetX = otherBotPosition.x;
        targetZ = botPos.z;
        console.log(
          `[iter ${iterationID}] [${bot.username}] aligning X axis to other bot`,
        );
      } else {
        // Align z axis (shorter distance)
        targetX = botPos.x;
        targetZ = otherBotPosition.z;
        console.log(
          `[iter ${iterationID}] [${bot.username}] aligning Z axis to other bot`,
        );
      }

      console.log(
        `[iter ${iterationID}] [${bot.username}] moving to align position (${targetX.toFixed(1)}, ${targetZ.toFixed(1)})`,
      );

      // Wait for alignment to complete (with timeout to avoid hanging)
      try {
        await gotoWithTimeout(bot, new GoalXZ(targetX, targetZ), {
          timeoutMs: 10000,
        });
        console.log(
          `[iter ${iterationID}] [${bot.username}] alignment complete`,
        );
      } catch (err) {
        console.log(
          `[iter ${iterationID}] [${bot.username}] alignment error: ${err?.message || err}`,
        );
      }
      await bot.waitForTicks(5);
      coordinator.sendToOtherBot(
        `walkLookPhase_${iterationID}`,
        bot.entity.position.clone(),
        episodeNum,
        "teleportPhase end",
      );
    } else {
      // For the bot not aligning, do nothing.
      // The episode will start after signaled by the other bot.
    }
  }
}

module.exports = { TranslationEvalEpisode };
