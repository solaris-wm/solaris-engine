// New episode functions for straight-line movement while facing other bot

const Vec3 = require("vec3").Vec3;

const { getDirectionTo, gotoWithTimeout, horizontalDistanceTo, initializePathfinder, land_pos, lookAtSmooth, stopAll } = require("../primitives/movement");
const { GoalNear } = require("../utils/bot-factory");
const { BaseEpisode } = require("./base-episode");

// Constants for the new episode
const DISTANCE_PAST_TARGET_MIN = 4; // Distance to walk in straight line
const DISTANCE_PAST_TARGET_MAX = 8; // Distance to walk in straight line
const LOOK_UPDATE_INTERVAL = 50; // How often to update look direction (ms)
const CAMERA_SPEED_DEGREES_PER_SEC = 180; // Same as main file

/**
 * Walk straight while looking at other bot with offset to avoid collision
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} otherBotPosition - Position of the other bot
 * @param {number} walkDistancePastTarget - Distance to walk
 * @param {number} walkTimeoutSec - Timeout for walking in seconds
 */
async function walkStraightWhileLooking(
  bot,
  otherBotPosition,
  walkDistancePastTarget,
  walkTimeoutSec,
) {
  console.log(
    `[${bot.username}] Starting straight walk past other bot by ${walkDistancePastTarget} blocks`,
  );

  const startPos = bot.entity.position.clone();
  const walkTimeoutMs = walkTimeoutSec * 1000;

  // Direction from us to the other bot (normalized)
  const direction = getDirectionTo(startPos, otherBotPosition);

  // Compute an XZ point that is walkDistancePastTarget beyond the other bot
  const pastTargetX = otherBotPosition.x + direction.x * walkDistancePastTarget;
  const pastTargetZ = otherBotPosition.z + direction.z * walkDistancePastTarget;

  // Resolve an appropriate Y at that XZ using land_pos
  let landingPos = land_pos(
    bot,
    Math.round(pastTargetX),
    Math.round(pastTargetZ),
  );
  if (!landingPos) {
    // Fallback: if chunk not loaded, aim near the other bot's Y
    landingPos = new Vec3(
      Math.round(pastTargetX),
      Math.round(otherBotPosition.y),
      Math.round(pastTargetZ),
    );
  }

  console.log(
    `[${bot.username}] Targeting past point (${landingPos.x}, ${landingPos.y}, ${landingPos.z})`,
  );

  // Randomize sprint usage via pathfinder movements
  const allowSprinting = Math.random() < 0.5;
  initializePathfinder(bot, {
    allowSprinting,
    allowParkour: true,
    canDig: true,
    allowEntityDetection: true,
  });

  // Navigate with a small radius around the landing position
  const goal = new GoalNear(landingPos.x, landingPos.y + 1, landingPos.z, 1);

  try {
    await gotoWithTimeout(bot, goal, {
      timeoutMs: walkTimeoutMs,
      stopOnTimeout: true,
    });

    // After arriving, look at the other bot smoothly
    await lookAtSmooth(bot, otherBotPosition, CAMERA_SPEED_DEGREES_PER_SEC);

    const finalDistance = horizontalDistanceTo(startPos, bot.entity.position);
    console.log(
      `[${
        bot.username
      }] Completed straight walk past target. Walked ~${finalDistance.toFixed(
        2,
      )} blocks`,
    );
  } finally {
    stopAll(bot);
    console.log(`[${bot.username}] Straight walk complete`);
  }
}

/**
 * Get straight line walk phase handler function
 * @param {*} bot - Mineflayer bot instance
 * @param {Function} sharedBotRng - Shared random number generator
 * @param {*} coordinator - Bot coordinator instance
 * @param {number} iterationID - Iteration ID
 * @param {string} otherBotName - Other bot name
 * @param {number} episodeNum - Episode number
 * @param {Object} episodeInstance - Episode instance
 * @param {Object} args - Configuration arguments
 * @returns {Function} Straight line walk phase handler
 */
function getOnStraightLineWalkPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  iterationID,
  otherBotName,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (otherBotPosition) => {
    coordinator.sendToOtherBot(
      `straightLineWalkPhase_${iterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      `straightLineWalkPhase_${iterationID} beginning`,
    );

    console.log(
      `[${bot.username}] Starting straight line walk phase ${iterationID}`,
    );

    // Determine walking modes and randomly pick one using sharedBotRng
    const walkingModes = [
      "lower_name_walks_straight",
      "bigger_name_walks_straight",
    ];
    const selectedMode =
      walkingModes[Math.floor(sharedBotRng() * walkingModes.length)];

    console.log(`[${bot.username}] Straight walk mode: ${selectedMode}`);

    // Determine if this bot should walk based on the selected mode
    let shouldThisBotWalk = false;

    switch (selectedMode) {
      case "lower_name_walks_straight":
        shouldThisBotWalk = bot.username < otherBotName;
        break;
      case "bigger_name_walks_straight":
        shouldThisBotWalk = bot.username > otherBotName;
        break;
    }

    console.log(
      `[${bot.username}] Will ${
        shouldThisBotWalk ? "walk straight" : "stay and look"
      } during this phase`,
    );

    if (shouldThisBotWalk) {
      // Execute straight line walking using building blocks
      const walkDistancePastTarget =
        DISTANCE_PAST_TARGET_MIN +
        Math.floor(
          Math.random() *
            (DISTANCE_PAST_TARGET_MAX - DISTANCE_PAST_TARGET_MIN + 1),
        );
      await walkStraightWhileLooking(
        bot,
        otherBotPosition,
        walkDistancePastTarget,
        /* timeout */ 20,
      );
    } else {
      // Bot doesn't walk, just looks at the other bot
      console.log(
        `[${bot.username}] Staying in place and looking at other bot`,
      );
      await lookAtSmooth(bot, otherBotPosition, CAMERA_SPEED_DEGREES_PER_SEC);
    }

    // Assuming 3 iterations like the original
    coordinator.onceEvent(
      "stopPhase",
      episodeNum,
      episodeInstance.getOnStopPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        otherBotName,
        episodeNum,
        args,
      ),
    );
    coordinator.sendToOtherBot(
      "stopPhase",
      bot.entity.position.clone(),
      episodeNum,
      `straightLineWalkPhase_${iterationID} end`,
    );
  };
}

/**
 * Episode where one bot walks in a straight line past the other (or both stay); who walks
 * is determined by shared RNG (lower/bigger name). The walker pathfinds past the other bot.
 * @extends BaseEpisode
 */
class StraightLineEpisode extends BaseEpisode {
  static WORKS_IN_NON_FLAT_WORLD = true;
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
      `straightLineWalkPhase_${iterationID}`,
      episodeNum,
      getOnStraightLineWalkPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        iterationID,
        args.other_bot_name,
        episodeNum,
        this,
        args,
      ),
    );
    coordinator.sendToOtherBot(
      `straightLineWalkPhase_${iterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      "teleportPhase end",
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

module.exports = { StraightLineEpisode };
