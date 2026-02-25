const seedrandom = require("seedrandom");
const Vec3 = require("vec3").Vec3;

/**
 * Basic Movement Building Blocks for Mineflayer Bots
 * These functions provide consistent, deterministic movement primitives
 * that can be used across all episodes.
 */

// Import pathfinder components correctly according to official README
const { Movements } = require("../utils/bot-factory");

// ============================================================================
// SCAFFOLDING BLOCKS CONFIGURATION
// ============================================================================

/**
 * Default scaffolding block names that can be used for bridging and pillaring
 * Note: Property is 'scafoldingBlocks' (one 'f') in mineflayer-pathfinder
 */
const DEFAULT_SCAFFOLDING_BLOCK_NAMES = [
  // Basic cheap blocks
  "dirt",
  "cobblestone",
  "stone",

  // Stone variants
  "andesite",
  "diorite",
  "granite",
  "polished_andesite",
  "polished_diorite",
  "polished_granite",

  // Stone bricks & variants
  "stone_bricks",
  "cracked_stone_bricks",
  "mossy_stone_bricks",
  "chiseled_stone_bricks",

  // Deepslate / brick-like
  "cobbled_deepslate",
  "deepslate_bricks",
  "cracked_deepslate_bricks",

  // Bricks
  "bricks", // classic clay bricks
  "nether_bricks",
  "red_nether_bricks",

  // Sandstone & variants
  "sandstone",
  "cut_sandstone",
  "smooth_sandstone",
  "red_sandstone",
  "cut_red_sandstone",
  "smooth_red_sandstone",

  // Overworld wood planks
  "oak_planks",
  "spruce_planks",
  "birch_planks",
  "jungle_planks",
  "acacia_planks",
  "dark_oak_planks",
  "mangrove_planks",
  "cherry_planks",
  "bamboo_planks",

  // Nether wood planks
  "crimson_planks",
  "warped_planks",
];

/**
 * Get scaffolding block IDs from block names
 * @param {Object} mcData - minecraft-data instance for the bot's version
 * @param {Array<string>} blockNames - Optional array of block names (defaults to DEFAULT_SCAFFOLDING_BLOCK_NAMES)
 * @returns {Array<number>} Array of block item IDs
 */
function getScaffoldingBlockIds(mcData, blockNames = null) {
  const names = blockNames || DEFAULT_SCAFFOLDING_BLOCK_NAMES;

  return names
    .map((name) => mcData.itemsByName[name]?.id)
    .filter((id) => id !== undefined);
}

// ============================================================================
// BASIC CONTROL FUNCTIONS
// ============================================================================

/**
 * Stop all bot movement and actions
 * @param {*} bot - Mineflayer bot instance
 */
function stopAll(bot) {
  // Stop pathfinder if available
  if (bot.pathfinder && typeof bot.pathfinder.stop === "function") {
    bot.pathfinder.stop();
  }

  // Stop all manual controls
  for (const control of [
    "forward",
    "back",
    "left",
    "right",
    "jump",
    "sprint",
    "sneak",
  ]) {
    bot.setControlState(control, false);
  }
}

/**
 * Set multiple movement controls at once
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} controls - Object with control states {forward: true, sprint: true, etc.}
 */
function setControls(bot, controls) {
  for (const [control, state] of Object.entries(controls)) {
    bot.setControlState(control, state);
  }
}

/**
 * Enable sprint mode
 * @param {*} bot - Mineflayer bot instance
 */
function enableSprint(bot) {
  bot.setControlState("sprint", true);
}

/**
 * Disable sprint mode
 * @param {*} bot - Mineflayer bot instance
 */
function disableSprint(bot) {
  bot.setControlState("sprint", false);
}

// ============================================================================
// PATHFINDER SETUP AND CONFIGURATION
// ============================================================================

/**
 * Initialize pathfinder with optimal settings for bot movement
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} options - Pathfinder configuration options
 */
function initializePathfinder(bot, options = {}) {
  const mcData = require("minecraft-data")(bot.version);
  const movements = new Movements(bot, mcData);

  // Configure movement settings with full capabilities enabled by default
  movements.allowSprinting = options.allowSprinting !== false; // Default: true - Sprint while moving
  movements.allowParkour = options.allowParkour !== false; // Default: true - Jump gaps
  movements.canDig = options.canDig !== false; // Default: true - Break blocks to path through terrain
  movements.canPlaceOn = options.canPlaceOn !== false; // Default: true - Place blocks to bridge gaps
  movements.allowFreeMotion = options.allowFreeMotion || false; // Default: false - Flying/swimming
  movements.allowEntityDetection = options.allowEntityDetection !== false; // Default: true - Avoid entities

  // Additional pathfinder settings for robust navigation
  // Note: Property is 'scafoldingBlocks' (one 'f') in mineflayer-pathfinder - this is intentional
  movements.scafoldingBlocks =
    options.scafoldingBlocks !== undefined
      ? options.scafoldingBlocks
      : getScaffoldingBlockIds(mcData); // Default: comprehensive building blocks list
  movements.maxDropDown = options.maxDropDown || 15; // Max blocks to drop down
  movements.infiniteLiquidDropdownDistance =
    options.infiniteLiquidDropdownDistance !== false; // Can drop any distance into water

  // Set pathfinder movements
  bot.pathfinder.setMovements(movements);

  console.log(
    `[${bot.username}] Pathfinder initialized with full capabilities:`,
    {
      sprint: movements.allowSprinting,
      parkour: movements.allowParkour,
      dig: movements.canDig,
      placeBlocks: movements.canPlaceOn,
      entityDetection: movements.allowEntityDetection,
      maxDropDown: movements.maxDropDown,
      scafoldingBlocks: movements.scafoldingBlocks.length,
    },
  );

  return movements;
}

/**
 * Stop pathfinder and clear current goal
 * @param {*} bot - Mineflayer bot instance
 */
function stopPathfinder(bot) {
  if (bot.pathfinder) {
    bot.pathfinder.stop();
  }
}

// ============================================================================
// PATHFINDER NAVIGATION HELPERS
// ============================================================================

/**
 * Go to a goal using pathfinder with a timeout.
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} goal - mineflayer-pathfinder Goal instance
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=10000] - Maximum time to attempt navigation
 * @param {boolean} [options.stopOnTimeout=true] - Stop pathfinder when timeout triggers
 * @returns {Promise<void>} Resolves when reached; rejects on timeout/error
 */
async function gotoWithTimeout(bot, goal, options = {}) {
  const { timeoutMs = 10000, stopOnTimeout = true } = options;

  if (!bot.pathfinder || typeof bot.pathfinder.goto !== "function") {
    throw new Error("Pathfinder plugin not loaded on bot");
  }

  let timeoutId;
  const gotoPromise = bot.pathfinder.goto(goal);
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      if (stopOnTimeout && bot.pathfinder) {
        bot.pathfinder.setGoal(null);
      }
      reject(new Error(`goto timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([gotoPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ============================================================================
// DIRECTIONAL MOVEMENT FUNCTIONS
// ============================================================================

/**
 * Move in a specific direction
 * @param {*} bot - Mineflayer bot instance
 * @param {string} direction - Direction to move ("forward", "back", "left", "right")
 * @param {boolean} sprint - Whether to sprint while moving
 */
function moveDirection(bot, direction, sprint = false) {
  stopAll(bot);
  bot.setControlState(direction, true);
  if (sprint) {
    bot.setControlState("sprint", true);
  }
}

/**
 * Move toward a target position using directional controls
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} targetPosition - Target position to move toward
 * @param {boolean} sprint - Whether to sprint while moving
 * @param {number} threshold - Distance threshold to consider "reached" (default: 0.5)
 * @returns {string} The primary direction being moved
 */
function moveToward(bot, targetPosition, sprint = false, threshold = 0.5) {
  const currentPos = bot.entity.position;
  const dx = targetPosition.x - currentPos.x;
  const dz = targetPosition.z - currentPos.z;
  const distance = Math.sqrt(dx * dx + dz * dz);

  // If we're close enough, stop moving
  if (distance <= threshold) {
    stopAll(bot);
    return "stopped";
  }

  // Clear all movement first
  stopAll(bot);

  // Determine primary movement direction
  let primaryDirection;
  if (Math.abs(dz) > Math.abs(dx)) {
    // Primarily north/south movement
    if (dz < 0) {
      bot.setControlState("forward", true); // Move north (negative Z)
      primaryDirection = "forward";
    } else {
      bot.setControlState("back", true); // Move south (positive Z)
      primaryDirection = "back";
    }
  } else {
    // Primarily east/west movement
    if (dx > 0) {
      bot.setControlState("right", true); // Move east (positive X)
      primaryDirection = "right";
    } else {
      bot.setControlState("left", true); // Move west (negative X)
      primaryDirection = "left";
    }
  }

  // Enable sprinting if requested
  if (sprint) {
    bot.setControlState("sprint", true);
  }

  return primaryDirection;
}

/**
 * Move away from a position (opposite direction)
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} avoidPosition - Position to move away from
 * @param {boolean} sprint - Whether to sprint while moving
 * @returns {string} The primary direction being moved
 */
function moveAway(bot, avoidPosition, sprint = false) {
  const currentPos = bot.entity.position;
  const dx = currentPos.x - avoidPosition.x; // Reversed for moving away
  const dz = currentPos.z - avoidPosition.z; // Reversed for moving away

  // Create a target position that's away from the avoid position
  const escapeTarget = new Vec3(
    currentPos.x + (dx > 0 ? 5 : -5), // Move 5 blocks in escape direction
    currentPos.y,
    currentPos.z + (dz > 0 ? 5 : -5),
  );

  return moveToward(bot, escapeTarget, sprint);
}

// ============================================================================
// RANDOM SAMPLING UTILITIES
// ============================================================================

/**
 * Generate a log-normal random variable with given mu and sigma.
 * @param {number} mu - Mean of the underlying normal distribution
 * @param {number} sigma - Standard deviation of the underlying normal distribution
 * @returns {number} A log-normal random sample
 */
function sampleLognormal(mu, sigma) {
  // Generate Standard Normal Z ~ N(0, 1) using Box-Muller transform
  let u1 = 0,
    u2 = 0;
  // Math.random() is [0, 1), but we need (0, 1) to avoid Math.log(0) = -Infinity
  while (u1 === 0) u1 = Math.random();
  u2 = Math.random();

  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  const normalSample = mu + z * sigma;
  return Math.exp(normalSample);
}

/**
 * Generates a scaling factor with Expected Value = 1.0.
 * @param {number} volatility - The sigma parameter controlling variance (e.g., 0.5 or 0.8)
 * @returns {number} A scaling factor R where E[R] = 1
 */
function getMeanPreservingScalingFactor(volatility) {
  if (volatility <= 0) {
    return 1;
  }
  const mu = (-volatility * volatility) / 2;
  return sampleLognormal(mu, volatility);
}

// ============================================================================
// CAMERA AND LOOKING FUNCTIONS
// ============================================================================

/**
 * Default options for look functions
 */
const DEFAULT_LOOK_OPTIONS = {
  useEasing: true,
  randomized: true,
  volatility: 0.35,
};

/**
 * Smoothly rotate bot camera to look at target position
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} targetPosition - Position to look at
 * @param {number} degreesPerSecond - Rotation speed in degrees per second
 * @param {Object} [options] - Look options (see lookSmooth for details)
 */
async function lookAtSmooth(
  bot,
  targetPosition,
  degreesPerSecond = 90,
  options = {},
) {
  const botPosition = bot.entity.position;

  // Calculate the vector from bot to target
  const dx = targetPosition.x - botPosition.x;
  const dy = targetPosition.y - botPosition.y;
  const dz = targetPosition.z - botPosition.z;

  // Calculate target yaw (horizontal rotation)
  const targetYaw = Math.atan2(-dx, -dz); // Minecraft coordinate system

  // Calculate target pitch (vertical rotation)
  const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
  const targetPitch = Math.atan2(dy, horizontalDistance); // Negative for Minecraft pitch

  await lookSmooth(bot, targetYaw, targetPitch, degreesPerSecond, options);
}

/**
 * Smoothly rotate bot camera to specified yaw and pitch
 * @param {*} bot - Mineflayer bot instance
 * @param {number} targetYaw - Target yaw angle in radians
 * @param {number} targetPitch - Target pitch angle in radians
 * @param {number} degreesPerSecond - Base rotation speed in degrees per second
 * @param {Object} [options] - Look options
 * @param {boolean} [options.useEasing=true] - Whether to use easing for the rotation
 * @param {boolean} [options.randomized=true] - Whether to use log-normal speed randomization
 * @param {number} [options.volatility=0.35] - Sigma parameter for log-normal speed randomization
 *   To view how log-normal scaling works, see: https://www.desmos.com/calculator/wazayi56xf
 */
async function lookSmooth(
  bot,
  targetYaw,
  targetPitch,
  degreesPerSecond,
  options = {},
) {
  const { useEasing, randomized, volatility } = {
    ...DEFAULT_LOOK_OPTIONS,
    ...options,
  };

  let actualSpeed = degreesPerSecond;

  if (randomized && volatility > 0) {
    const multiplier = getMeanPreservingScalingFactor(volatility);
    actualSpeed = degreesPerSecond * multiplier;

    // Clip to at least 0.4x the original speed and at most 171 degrees per second, as specified (in rads/sec) by
    // https://github.com/PrismarineJS/prismarine-physics/blob/37d8d0b612de347b2e132e270642fec108d4f2ec/index.js#L63
    const minSpeed = degreesPerSecond * 0.4;
    const maxSpeed = 171;
    actualSpeed = Math.max(minSpeed, Math.min(maxSpeed, actualSpeed));
  }

  await bot.look(
    targetYaw,
    targetPitch,
    false,
    actualSpeed,
    actualSpeed,
    useEasing,
  );
}

/**
 * Look at another bot by name
 * @param {*} bot - Mineflayer bot instance
 * @param {string} targetBotName - Name of the bot to look at
 * @param {number} degreesPerSecond - Rotation speed in degrees per second
 * @param {Object} [options] - Look options (see lookSmooth for details)
 */
async function lookAtBot(
  bot,
  targetBotName,
  degreesPerSecond = 90,
  options = {},
) {
  const targetBot = bot.players[targetBotName];
  if (targetBot && targetBot.entity) {
    await lookAtSmooth(
      bot,
      targetBot.entity.position,
      degreesPerSecond,
      options,
    );
  } else {
    console.log(
      `[${bot.username}] Cannot find bot ${targetBotName} to look at`,
    );
  }
}

/**
 * Look in a specific direction (yaw only)
 * @param {*} bot - Mineflayer bot instance
 * @param {number} yawRadians - Yaw angle in radians
 * @param {number} pitchRadians - Pitch angle in radians (default: 0)
 */
function lookDirection(bot, yawRadians, pitchRadians = 0) {
  bot.look(yawRadians, pitchRadians, false);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const Y_IN_AIR = 128;
/**
 * Find suitable landing position at given coordinates
 * @param {*} bot - Mineflayer bot instance
 * @param {number} x - X coordinate
 * @param {number} z - Z coordinate
 * @returns {Vec3|null} Landing position or null if not found
 */
function land_pos(bot, x, z) {
  const pos = new Vec3(x, Y_IN_AIR, z);
  let block = bot.blockAt(pos);

  if (block === null) {
    // unloaded chunk
    return null;
  }
  let dy = 0;
  while (block.type !== bot.registry.blocksByName.air.id) {
    dy++;
    block = bot.blockAt(pos.offset(0, dy, 0));
    if (block.type === bot.registry.blocksByName.air.id) {
      return pos.offset(0, dy - 1, 0);
    }
  }
  while (block.type === bot.registry.blocksByName.air.id) {
    dy--;
    block = bot.blockAt(pos.offset(0, dy, 0));
    if (block.type !== bot.registry.blocksByName.air.id) {
      return pos.offset(0, dy, 0);
    }
  }
}

/**
 * Sleep for a specified duration
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Promise that resolves after the specified time
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate distance between two positions
 * @param {Vec3} pos1 - First position
 * @param {Vec3} pos2 - Second position
 * @returns {number} Distance between positions
 */
function distanceTo(pos1, pos2) {
  const dx = pos2.x - pos1.x;
  const dy = pos2.y - pos1.y;
  const dz = pos2.z - pos1.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Calculate 2D horizontal distance between two positions (ignoring Y)
 * @param {Vec3} pos1 - First position
 * @param {Vec3} pos2 - Second position
 * @returns {number} Horizontal distance between positions
 */
function horizontalDistanceTo(pos1, pos2) {
  const dx = pos2.x - pos1.x;
  const dz = pos2.z - pos1.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Get the direction vector from one position to another
 * @param {Vec3} fromPos - Starting position
 * @param {Vec3} toPos - Target position
 * @returns {Object} Normalized direction vector {x, z, distance}
 */
function getDirectionTo(fromPos, toPos) {
  const dx = toPos.x - fromPos.x;
  const dz = toPos.z - fromPos.z;
  const distance = Math.sqrt(dx * dx + dz * dz);

  if (distance === 0) {
    return { x: 0, z: 0, distance: 0 };
  }

  return {
    x: dx / distance,
    z: dz / distance,
    distance: distance,
  };
}

/**
 * Check if bot is close to a target position
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} targetPosition - Target position to check
 * @param {number} threshold - Distance threshold (default: 1.0)
 * @returns {boolean} True if bot is within threshold distance
 */
function isNearPosition(bot, targetPosition, threshold = 1.0) {
  return horizontalDistanceTo(bot.entity.position, targetPosition) <= threshold;
}

/**
 * Check if bot is close to another bot
 * @param {*} bot - Mineflayer bot instance
 * @param {string} targetBotName - Name of the target bot
 * @param {number} threshold - Distance threshold (default: 1.0)
 * @returns {boolean} True if bots are within threshold distance
 */
function isNearBot(bot, targetBotName, threshold = 1.0) {
  const targetBot = bot.players[targetBotName];
  if (targetBot && targetBot.entity) {
    return (
      horizontalDistanceTo(bot.entity.position, targetBot.entity.position) <=
      threshold
    );
  }
  return false;
}
/**
 * Make bot jump for specified duration
 * @param {*} bot - Mineflayer bot instance
 * @param {number} durationMs - Duration in milliseconds
 */
async function jump(bot, durationMs) {
  console.log(
    `[${bot.username}] Jumping for ${(durationMs / 1000).toFixed(1)}s`,
  );
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    bot.setControlState("jump", true);
    await sleep(250);
    bot.setControlState("jump", false);
    await sleep(250);
  }
}

/**
 * Make bot sneak for specified number of ticks (default: 5 ticks)
 * @param {*} bot - Mineflayer bot instance
 * @param {number} durationTicks - Number of ticks to sneak (default: 5)
 * @param {number} idleTicks - Number of ticks to idle for after releasing sneak (default: 5)
 */
async function sneak(bot, durationTicks = 5, idleTicks = 25) {
  console.log(
    `[${bot.username}] Sneaking for ${(durationTicks + idleTicks) / 20}s`,
  );
  bot.setControlState("sneak", true);
  await bot.waitForTicks(durationTicks);
  bot.setControlState("sneak", false);
  await bot.waitForTicks(idleTicks);
}

/**
 * Direct teleport to specific points from a list.
 * Used for episodes that require precise positioning (e.g. TurnToLookEpisode).
 * @param {*} bot - Mineflayer bot instance
 * @param {*} rcon - RCON connection instance
 * @param {string} otherBotName - Name of the other bot
 * @param {number} episodeNum - Episode number
 * @param {Array<Array<number>>} points - List of [x, y, z] coordinates
 */
async function directTeleport(bot, rcon, otherBotName, episodeNum, points) {
  console.log(
    `[${bot.username}] Using custom teleport logic for episode ${episodeNum}`,
  );

  // Use a deterministic RNG separate from sharedBotRng to avoid desyncing the main RNG
  const tpRng = seedrandom(`${episodeNum}_tp`);

  const point = points[episodeNum % points.length];
  const [cx, cy, cz] = point;

  // Determine axis offset: > 0.5 means X axis offset, else Z axis offset
  const useXAxis = tpRng() > 0.5;
  const offset = 2; // 2 blocks each way = 4 blocks apart

  let bot1Pos, bot2Pos;
  if (useXAxis) {
    bot1Pos = { x: cx - offset, y: cy, z: cz };
    bot2Pos = { x: cx + offset, y: cy, z: cz };
  } else {
    bot1Pos = { x: cx, y: cy, z: cz - offset };
    bot2Pos = { x: cx, y: cy, z: cz + offset };
  }

  // Assign positions to bots deterministically based on name sorting
  const botName1 = bot.username;
  const botName2 = otherBotName;

  let myTarget, otherTarget;
  if (botName1 < botName2) {
    myTarget = bot1Pos;
    otherTarget = bot2Pos;
  } else {
    myTarget = bot2Pos;
    otherTarget = bot1Pos;
  }

  console.log(
    `[${bot.username}] TPing ${botName1} to (${myTarget.x}, ${myTarget.y}, ${myTarget.z}) and ${botName2} to (${otherTarget.x}, ${otherTarget.y}, ${otherTarget.z})`,
  );

  try {
    await rcon.send(`tp ${botName1} ${myTarget.x} ${myTarget.y} ${myTarget.z}`);
    await rcon.send(
      `tp ${botName2} ${otherTarget.x} ${otherTarget.y} ${otherTarget.z}`,
    );
  } catch (err) {
    console.error(`[${bot.username}] directTeleport failed:`, err);
  }

  // Wait a bit for chunks to load and bots to settle
  await sleep(2000);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Basic controls
  stopAll,
  setControls,
  enableSprint,
  disableSprint,

  // Pathfinder setup and configuration
  initializePathfinder,
  stopPathfinder,
  gotoWithTimeout,

  // Directional movement
  moveDirection,
  moveToward,
  moveAway,

  // Camera and looking
  lookAtSmooth,
  lookSmooth,
  lookAtBot,
  lookDirection,

  // Utilities
  sleep,
  distanceTo,
  horizontalDistanceTo,
  getDirectionTo,
  isNearPosition,
  isNearBot,
  land_pos,
  jump,
  sneak,
  directTeleport,
  Y_IN_AIR,
  getScaffoldingBlockIds,
  DEFAULT_SCAFFOLDING_BLOCK_NAMES,
};
