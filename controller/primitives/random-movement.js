const Vec3 = require("vec3").Vec3;

const {
  DEFAULT_CAMERA_SPEED_DEGREES_PER_SEC,
  JUMP_PROBABILITY,
  MAX_JUMP_DURATION_SEC,
  MAX_SLEEP_BETWEEN_ACTIONS_SEC,
  MAX_WALK_DISTANCE,
  MIN_JUMP_DURATION_SEC,
  MIN_SLEEP_BETWEEN_ACTIONS_SEC,
  MIN_WALK_DISTANCE,
} = require("../utils/constants");
const { choice, rand, sleep } = require("../utils/helpers");
const { jump, lookSmooth, stopAll } = require("./movement");

/**
 * Get random cardinal direction (north, south, east, west)
 * @returns {Object} Direction object with name and offset
 */
function getRandomDirection() {
  const directions = [
    { name: "north", offset: new Vec3(0, 0, -1) },
    { name: "south", offset: new Vec3(0, 0, 1) },
    { name: "east", offset: new Vec3(1, 0, 0) },
    { name: "west", offset: new Vec3(-1, 0, 0) },
  ];
  return directions[Math.floor(Math.random() * directions.length)];
}

/**
 * Perform a single randomized walk action (optionally looking away) and return.
 * @param {*} bot - Mineflayer bot instance
 * @param {number} distance - Distance to walk before returning
 * @param {boolean} lookAway - If true, rotate camera away while walking
 * @param {boolean} flipCameraInReturn - If true, flip camera and reuse same dir on return
 * @param {*} args - Episode args (expects walk_timeout)
 * @param {Object} [customConstants={}] - Optional per-episode constant overrides
 * @returns {Promise<void>}
 */
async function walk(
  bot,
  distance,
  lookAway,
  flipCameraInReturn,
  args,
  customConstants = {},
) {
  // Allow overriding constants per episode type
  const jumpProb = customConstants.JUMP_PROBABILITY ?? JUMP_PROBABILITY;

  const startPos = bot.entity.position.clone();
  const dir = choice(["forward", "back", "left", "right"]);
  const walkTimeoutMs = args.walk_timeout * 1000; // Convert to milliseconds
  // Save bot's original pitch and yaw
  const originalYaw = bot.entity.yaw;
  const originalPitch = bot.entity.pitch;
  console.log(
    `[${
      bot.username
    }] Walking ${dir} for ${distance} blocks from position (${startPos.x.toFixed(
      2,
    )}, ${startPos.y.toFixed(2)}, ${startPos.z.toFixed(2)}) with ${
      args.walk_timeout
    }s timeout lookAway: ${lookAway} flipCameraInReturn: ${flipCameraInReturn}`,
  );
  if (lookAway) {
    // Pick a random angle between -90 and +90 degrees behind the bot's current yaw
    // "Behind" means add 180 degrees (π radians), then offset by [-90, +90] degrees
    const behindOffsetDeg = Math.random() * 180 - 90; // [-90, +90]
    const behindOffsetRad = (behindOffsetDeg * Math.PI) / 180;
    const newYaw = originalYaw + Math.PI + behindOffsetRad;
    // Keep pitch the same
    await lookSmooth(
      bot,
      newYaw,
      originalPitch,
      DEFAULT_CAMERA_SPEED_DEGREES_PER_SEC,
    );
  }

  // Walk in the chosen direction until we reach the target distance
  bot.setControlState(dir, true);

  let actualDistance = 0;
  const forwardStartTime = Date.now();
  try {
    while (bot.entity.position.distanceTo(startPos) < distance) {
      // Check for timeout
      if (Date.now() - forwardStartTime > walkTimeoutMs) {
        console.log(
          `[${bot.username}] Walk timeout (${args.walk_timeout}s) reached while walking ${dir}`,
        );
        break;
      }
      await sleep(50); // Check position every 50ms
    }
    actualDistance = bot.entity.position.distanceTo(startPos);
  } finally {
    bot.setControlState(dir, false);
  }

  const reachedPos = bot.entity.position.clone();
  console.log(
    `[${bot.username}] Reached distance ${actualDistance.toFixed(
      2,
    )} blocks at position (${reachedPos.x.toFixed(2)}, ${reachedPos.y.toFixed(
      2,
    )}, ${reachedPos.z.toFixed(2)})`,
  );

  // Randomly jump before returning based on jump probability
  if (Math.random() < jumpProb) {
    const jumpDurationSec =
      MIN_JUMP_DURATION_SEC +
      Math.random() * (MAX_JUMP_DURATION_SEC - MIN_JUMP_DURATION_SEC);
    const jumpDurationMs = Math.floor(jumpDurationSec * 1000);
    console.log(
      `[${bot.username}] Jumping for ${jumpDurationSec.toFixed(
        1,
      )}s before returning`,
    );
    await jump(bot, jumpDurationMs);
  }
  let returnDir;
  if (flipCameraInReturn) {
    await lookSmooth(
      bot,
      bot.entity.yaw + Math.PI,
      bot.entity.pitch,
      DEFAULT_CAMERA_SPEED_DEGREES_PER_SEC,
    );
    console.log(`[${bot.username}] Flipped camera in return`);
    returnDir = dir;
  } else {
    // Define the reverse direction
    const reverseDir = {
      forward: "back",
      back: "forward",
      left: "right",
      right: "left",
    };
    returnDir = reverseDir[dir];
  }
  // Now return to the starting position by walking in the reverse direction
  console.log(
    `[${bot.username}] Returning to starting position by walking ${returnDir}`,
  );

  bot.setControlState(returnDir, true);

  const returnStartTime = Date.now();
  try {
    // Walk back until we're close to the starting position
    while (bot.entity.position.distanceTo(startPos) > 1.0) {
      // Check for timeout
      if (Date.now() - returnStartTime > walkTimeoutMs) {
        console.log(
          `[${bot.username}] Walk timeout (${args.walk_timeout}s) reached while returning via ${returnDir}`,
        );
        break;
      }
      await sleep(50); // Check position every 50ms
    }
  } finally {
    bot.setControlState(returnDir, false);
  }

  const finalDistance = bot.entity.position.distanceTo(startPos);
  console.log(
    `[${bot.username}] Returned to within ${finalDistance.toFixed(
      2,
    )} blocks of starting position`,
  );

  // Randomly jump after returning to start position
  if (Math.random() < jumpProb) {
    const jumpDurationSec =
      MIN_JUMP_DURATION_SEC +
      Math.random() * (MAX_JUMP_DURATION_SEC - MIN_JUMP_DURATION_SEC);
    const jumpDurationMs = Math.floor(jumpDurationSec * 1000);
    console.log(
      `[${bot.username}] Jumping for ${jumpDurationSec.toFixed(
        1,
      )}s after returning to start`,
    );
    await jump(bot, jumpDurationMs);
  }
  if (lookAway) {
    await lookSmooth(
      bot,
      originalYaw,
      originalPitch,
      DEFAULT_CAMERA_SPEED_DEGREES_PER_SEC,
    );
  }
}

/**
 * Run a sequence of randomized movement actions.
 * @param {*} bot - Mineflayer bot instance
 * @param {number} actionCount - Number of actions to execute
 * @param {boolean} lookAway - If true, include "look away" variants of actions
 * @param {*} args - Episode args (expects walk_timeout)
 * @param {Object} [customConstants={}] - Optional per-episode constant overrides
 * @returns {Promise<void>}
 */
async function run(bot, actionCount, lookAway, args, customConstants = {}) {
  // Allow overriding constants per episode type
  const minWalkDist = customConstants.MIN_WALK_DISTANCE ?? MIN_WALK_DISTANCE;
  const maxWalkDist = customConstants.MAX_WALK_DISTANCE ?? MAX_WALK_DISTANCE;

  const actions = [];
  if (lookAway) {
    actions.push(() =>
      walk(
        bot,
        rand(minWalkDist, maxWalkDist),
        lookAway,
        /*flipCameraInReturn*/ true,
        args,
        customConstants,
      ),
    );
    actions.push(() =>
      walk(
        bot,
        rand(minWalkDist, maxWalkDist),
        lookAway,
        /*flipCameraInReturn*/ false,
        args,
        customConstants,
      ),
    );
  } else {
    actions.push(() =>
      walk(
        bot,
        rand(minWalkDist, maxWalkDist),
        lookAway,
        /*flipCameraInReturn*/ false,
        args,
        customConstants,
      ),
    );
  }

  console.log(`[${bot.username}] Running ${actionCount} actions`);

  for (let i = 0; i < actionCount; i++) {
    // Sleep before each action, including the first one
    const sleepTimeSec =
      MIN_SLEEP_BETWEEN_ACTIONS_SEC +
      Math.random() *
        (MAX_SLEEP_BETWEEN_ACTIONS_SEC - MIN_SLEEP_BETWEEN_ACTIONS_SEC);
    const sleepTimeMs = Math.floor(sleepTimeSec * 1000);
    console.log(
      `[${bot.username}] Sleeping for ${sleepTimeSec.toFixed(
        2,
      )}s before action ${i + 1}`,
    );
    await sleep(sleepTimeMs);

    const action = choice(actions);
    try {
      console.log(`[${bot.username}] Executing action ${i + 1}/${actionCount}`);
      await action();
    } catch (err) {
      console.error(`[${bot.username}] Action error:`, err);
    } finally {
      stopAll(bot);
    }
  }
}

module.exports = {
  walk,
  run,
  getRandomDirection,
};
