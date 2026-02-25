// structure-eval-episode.js - Independent structure building and evaluation episode
const { GoalNear } = require("mineflayer-pathfinder").goals;
const { Vec3 } = require("vec3");

const {
  buildStructure,
  getBlockPlaceDelayTicks,
} = require("../../primitives/building");
const { ensureBotHasEnough, unequipHand } = require("../../primitives/items");
const {
  gotoWithTimeout,
  initializePathfinder,
  lookAtSmooth,
  sneak,
  stopPathfinder,
} = require("../../primitives/movement");
const { BaseEpisode } = require("../base-episode");

// Constants for building behavior
const ALL_STRUCTURE_TYPES = ["wall_2x2", "wall_4x1", "tower_2x1"];

// Dynamic timing functions based on block count
const getInitialEyeContactTicks = (blockCount) => {
  if (blockCount === 2) return 4; // tower: 1.0 seconds (20 ticks)
  if (blockCount === 4) return 4; // wall: 0.75 seconds (15 ticks) - REDUCED
  return 4; // Default: 1.0 seconds (20 ticks)
};

const getBuilderAdmireTicks = (blockCount) => {
  if (blockCount === 2) return 4; // tower: 1.0 seconds (20 ticks)
  if (blockCount === 4) return 4; // wall: 0.55 seconds (15 ticks) - REDUCED
  return 4; // Default: 1.0 seconds (20 ticks)
};

const BUILD_BLOCK_TYPES = ["stone"]; // Only stone blocks for building
const EPISODE_MIN_TICKS = 300;
const PLACEMENT_STANDOFF_BLOCKS = 1; // Stand 2 blocks away from the structure while placing
const ADJACENT_GOAL_RADIUS = 1.0; // Relaxed tolerance to avoid micro-jitter at the target point

/**
 * Generate positions for a simple wall structure
 * @param {Vec3} startPos - Starting position
 * @param {number} length - Length of wall
 * @param {number} height - Height of wall
 * @param {string} direction - 'x' or 'z' axis
 * @returns {Array<Vec3>} Array of positions
 */
function generateWallPositions(startPos, length, height, direction = "x") {
  const positions = [];
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < length; i++) {
      if (direction === "x") {
        positions.push(startPos.offset(i, y, 0));
      } else {
        positions.push(startPos.offset(0, y, i));
      }
    }
  }
  return positions;
}

/**
 * Generate positions for a tower structure
 * @param {Vec3} basePos - Base position
 * @param {number} height - Height of tower
 * @returns {Array<Vec3>} Array of positions
 */
function generateTowerPositions(basePos, height) {
  const positions = [];
  for (let y = 0; y < height; y++) {
    positions.push(basePos.offset(0, y, 0));
  }
  return positions;
}

/**
 * Generate positions for a platform structure
 * @param {Vec3} startPos - Starting corner position
 * @param {number} width - Width (X axis)
 * @param {number} depth - Depth (Z axis)
 * @returns {Array<Vec3>} Array of positions
 */
function generatePlatformPositions(startPos, width, depth) {
  const positions = [];
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < depth; z++) {
      positions.push(startPos.offset(x, 0, z));
    }
  }
  return positions;
}

/**
 * Calculate the center position of a structure for lookAtSmooth
 * @param {string} structureType - Type of structure
 * @param {Vec3} basePos - Base position of structure
 * @param {number} height - Height of structure
 * @param {number} length - Length of structure (for wall)
 * @param {number} width - Width of structure (for platform)
 * @returns {Vec3} Center position to look at
 */
function getStructureCenterForViewing(
  structureType,
  basePos,
  height,
  length = 1,
  width = 1,
) {
  // All structures are built along X axis with constant Z (Z offset = 0)
  if (structureType === "tower_2x1") {
    // Tower: single column of blocks at basePos.x
    return basePos.offset(length / 2, 0, 0);
  } else if (structureType === "wall_2x2" || structureType === "wall_4x1") {
    // Wall: blocks span from basePos.x to basePos.x + (length - 1)
    return basePos.offset(length / 2, 0, 0);
  } else if (structureType === "platform_2x2") {
    // Platform: blocks span both X and Z axes
    return basePos.offset(width / 2, 0, width / 2);
  }
  return basePos.offset(0, 0, 0);
}

// ========== Local helpers for face selection, LOS, and fast placement (episode-scoped) ==========
const CARDINALS = [
  new Vec3(1, 0, 0), // +X (east)
  new Vec3(-1, 0, 0), // -X (west)
  new Vec3(0, 0, 1), // +Z (south)
  new Vec3(0, 0, -1), // -Z (north)
  new Vec3(0, 1, 0), // +Y (up)
  new Vec3(0, -1, 0), // -Y (down)
];

/**
 * Get the phase function for structure eval episodes
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} rcon - RCON connection
 * @param {Function} sharedBotRng - Shared random number generator
 * @param {*} coordinator - Bot coordinator instance
 * @param {number} iterationID - Iteration ID
 * @param {number} episodeNum - Episode number
 * @param {Object} episodeInstance - Episode instance
 * @param {Object} args - Configuration arguments
 * @returns {Function} Phase function
 */
function getOnStructureEvalPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  iterationID,
  episodeNum,
  episodeInstance,
  args,
) {
  return async function onStructureEvalPhase(otherBotPosition) {
    coordinator.sendToOtherBot(
      `structureEvalPhase_${iterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      `structureEvalPhase_${iterationID} beginning`,
    );

    console.log(
      `[${bot.username}] 🚀 Starting STRUCTURE EVAL phase ${iterationID}`,
    );

    // Save initial spawn position for later return
    const initialSpawnPos = bot.entity.position.clone();
    console.log(
      `[${bot.username}] 📍 Spawn position: ${initialSpawnPos.toString()}`,
    );

    // Track start tick for minimum episode duration
    let startTick = null;

    // STEP 1: Bots spawn (already done by teleport phase)
    console.log(`[${bot.username}] ✅ STEP 1: Bot spawned`);

    // Determine role assignment using shared RNG for true 50/50 randomization
    // Both bots use the same random seed, so they agree on who is builder/observer
    const roleAssignmentModes = ["alpha_builds", "bravo_builds"];
    const selectedRoleMode =
      roleAssignmentModes[
        Math.floor(sharedBotRng() * roleAssignmentModes.length)
      ];

    // Determine if this bot is the builder based on the randomly selected mode
    let isBuilder;
    if (selectedRoleMode === "alpha_builds") {
      isBuilder = bot.username < args.other_bot_name; // Alpha (lower name) builds
    } else {
      isBuilder = bot.username >= args.other_bot_name; // Bravo (higher name) builds
    }

    const role = isBuilder ? "BUILDER" : "OBSERVER";

    console.log(
      `[${bot.username}] 🎭 Role mode: ${selectedRoleMode}, Role: ${role}`,
    );

    // Calculate builder's spawn position for structure location (both bots need this)
    // Builder uses their own spawn, observer uses the other bot's spawn position
    // Note: otherBotPosition is a plain object from coordinator, need to convert to Vec3
    const builderSpawnPos = isBuilder
      ? initialSpawnPos.floored()
      : new Vec3(
          otherBotPosition.x,
          otherBotPosition.y,
          otherBotPosition.z,
        ).floored();

    // STEP 1b-pre: Builder equips stone block in hand (before any movement or interactions)
    if (isBuilder) {
      console.log(
        `[${bot.username}] 🔧 STEP 1b-pre: Equipping stone in hand...`,
      );
      try {
        // Find stone block in inventory
        const stoneItem = bot.inventory
          .items()
          .find((item) => item.name === "stone");
        if (stoneItem) {
          await bot.equip(stoneItem, "hand");
          console.log(`[${bot.username}] ✅ Equipped stone in hand`);
        } else {
          console.log(`[${bot.username}] ⚠️ No stone found in inventory`);
        }
      } catch (equipError) {
        console.log(
          `[${bot.username}] ⚠️ Could not equip stone: ${equipError.message}`,
        );
      }
      await bot.waitForTicks(15); // Brief pause after equipping
    }

    // STEP 1b-sneak: Builder sneaks (acknowledgment gesture), Observer remains stationary
    if (isBuilder) {
      console.log(`[${bot.username}] STEP 1b-sneak: Sneaking...`);
      await sneak(bot);
      // Record tick number after sneak
      startTick = bot.time.age;
      console.log(
        `[${bot.username}] ✅ Sneak complete, startTick: ${startTick}`,
      );
    } else {
      console.log(
        `[${bot.username}] STEP 1b-sneak: Remaining stationary (observer role)`,
      );
      // Observer waits equivalent time but does nothing
      await bot.waitForTicks(15);
    }

    await bot.waitForTicks(10);

    // STEP 2: Initial eye contact (BUILDER only, observer remains stationary)
    if (isBuilder) {
      console.log(
        `[${bot.username}] 👀 STEP 2: Making eye contact with ${args.other_bot_name}...`,
      );
      try {
        const otherEntity = bot.players[args.other_bot_name]?.entity;
        if (otherEntity) {
          const targetPos = otherEntity.position.offset(
            0,
            otherEntity.height,
            0,
          );
          await bot.lookAt(targetPos);
          await bot.waitForTicks(
            getInitialEyeContactTicks(ALL_STRUCTURE_TYPES.length),
          );
        }
      } catch (lookError) {
        console.log(
          `[${bot.username}] ⚠️ Could not look at other bot: ${lookError.message}`,
        );
      }
    } else {
      console.log(
        `[${bot.username}] 🧍 STEP 2: Remaining stationary (observer role)...`,
      );
      await bot.waitForTicks(
        getInitialEyeContactTicks(ALL_STRUCTURE_TYPES.length),
      );
    }

    // STEP 3: Determine build positions based on bot role
    console.log(`[${bot.username}] 📐 STEP 3: Planning structure...`);

    // Both bots use shared RNG to select the same structure type and block type
    const structureType =
      ALL_STRUCTURE_TYPES[
        Math.floor(sharedBotRng() * ALL_STRUCTURE_TYPES.length)
      ];
    const blockType =
      BUILD_BLOCK_TYPES[Math.floor(sharedBotRng() * BUILD_BLOCK_TYPES.length)];

    console.log(
      `[${bot.username}] 🎲 Randomly selected: ${structureType} with ${blockType}`,
    );

    // Record important episode metadata (like translation-eval-episode.js)
    const builderBotName = isBuilder ? bot.username : args.other_bot_name;
    const observerBotName = isBuilder ? args.other_bot_name : bot.username;
    episodeInstance._evalMetadata = {
      structure_type: structureType,
      block_type: blockType,
      builder_bot: builderBotName,
      observer_bot: observerBotName,
      role_assignment_mode: selectedRoleMode,
    };

    const botPos = builderSpawnPos.floored();
    let positions = [];
    let structureBasePos = null;
    let structureHeight = null;
    let structureLength = null; // as seen from the front, sideways length
    let structureWidth = 1; // in other words, depth

    if (structureType === "platform_2x2") {
      // NOTE: platform 2x2 is un-used right now
      const startPos = botPos.offset(1, 0, 0);
      const width = 2;
      const depth = 2;
      structureHeight = 1;
      structureWidth = width;
      positions = generatePlatformPositions(startPos, width, depth);
      structureBasePos = startPos;
    } else if (structureType === "wall_2x2") {
      const startPos = botPos.offset(1, 0, 0);
      const length = 2;
      const height = 2;
      structureHeight = height;
      structureLength = length;
      positions = generateWallPositions(startPos, length, height, "x");
      structureBasePos = startPos;
    } else if (structureType === "wall_4x1") {
      const startPos = botPos.offset(1, 0, 0);
      const length = 4;
      const height = 1;
      structureHeight = height;
      structureLength = length;
      positions = generateWallPositions(startPos, length, height, "x");
      structureBasePos = startPos;
    } else if (structureType === "tower_2x1") {
      const startPos = botPos.offset(1, 0, 0);
      const height = 2;
      structureHeight = height;
      structureLength = 1;
      positions = generateTowerPositions(startPos, height);
      structureBasePos = startPos;
    }

    console.log(
      `[${bot.username}] 📋 ${isBuilder ? "Building" : "Observing"} ${positions.length} blocks with ${blockType}`,
    );

    // STEP 4: Build the structure (only builder builds, observer watches)
    let buildResult = { placed: 0, failed: 0 };

    if (isBuilder) {
      console.log(`[${bot.username}] 🏗️ STEP 4: Building structure...`);
      buildResult = await buildStructure(
        bot,
        positions,
        blockType,
        PLACEMENT_STANDOFF_BLOCKS,
        ADJACENT_GOAL_RADIUS,
        args,
      );
    } else {
      console.log(
        `[${bot.username}] 🧍 STEP 4: Remaining stationary (observer role)...`,
      );
      // Observer remains completely stationary - no looking, no movement
      const totalWatchTime =
        positions.length * getBlockPlaceDelayTicks(positions.length);
      await bot.waitForTicks(totalWatchTime);
      console.log(`[${bot.username}] ✅ Finished waiting (stationary)`);
    }

    // STEP 5: Both bots move to the front of the structure (axially aligned)
    // This ensures both bots view the structure from the front, not the side
    console.log(
      `[${bot.username}] 🚶 STEP 5: Moving to front of structure (axially aligned)...`,
    );
    try {
      initializePathfinder(bot, {
        allowSprinting: true,
        allowParkour: true,
        canDig: false,
        allowEntityDetection: true,
      });

      // Calculate the actual structure base position based on builder's spawn
      // Structure is always built at builderSpawnPos.offset(1, 0, 0)
      const actualStructureBasePos = builderSpawnPos.offset(1, 0, 0);

      // For walls built along X axis, "front" is along the Z axis
      // We want both bots to be axially aligned with the structure's center X
      const FRONT_DISTANCE = 6; // Stand 4 blocks in front of the structure
      const actualStructureCenterX =
        actualStructureBasePos.x + structureLength / 2;
      const frontZ = actualStructureBasePos.z - FRONT_DISTANCE; // Front is in -Z direction

      // Both bots stand side by side, axially aligned with structure center
      // Offset along X so they don't overlap
      const sideOffset = isBuilder ? 1 : -1; // Builder to the right, observer to the left
      const targetX = actualStructureCenterX + sideOffset;
      const targetZ = frontZ;

      console.log(
        `[${bot.username}] 📐 Structure center X: ${actualStructureCenterX.toFixed(1)}, moving to front position (${targetX.toFixed(1)}, ${targetZ.toFixed(1)})`,
      );

      // Move to front position (axially aligned with structure)
      const frontGoal = new GoalNear(
        targetX,
        bot.entity.position.y,
        targetZ,
        1, // Get within 1 block of the target position
      );
      await gotoWithTimeout(bot, frontGoal, { timeoutTicks: 200 });
      console.log(
        `[${bot.username}] ✅ Moved to front of structure (axially aligned)`,
      );

      // Calculate the structure center for viewing (using actualStructureCenterX)
      const viewPosition = getStructureCenterForViewing(
        structureType,
        actualStructureBasePos,
        structureHeight,
        structureLength,
        structureWidth,
      );

      // Look at the structure together
      if (viewPosition) {
        console.log(`[${bot.username}] 👁️ Looking at structure from front...`);
        await lookAtSmooth(bot, viewPosition, 90, {
          randomized: false,
          useEasing: false,
        });
        await bot.waitForTicks(getBuilderAdmireTicks(positions.length));
        console.log(
          `[${bot.username}] ✅ Admired structure from front position`,
        );
      }
    } catch (pathError) {
      console.log(
        `[${bot.username}] ⚠️ Could not move to front: ${pathError.message}`,
      );
    } finally {
      stopPathfinder(bot);
    }

    // Wait for minimum ticks if needed (builder only)
    if (startTick !== null) {
      const endTick = bot.time.age;
      const remainingTicks = EPISODE_MIN_TICKS - (endTick - startTick);
      if (remainingTicks > 0) {
        console.log(
          `[${bot.username}] waiting ${remainingTicks} more ticks to reach ${EPISODE_MIN_TICKS} total ticks`,
        );
        await bot.waitForTicks(remainingTicks);
      } else {
        console.log(
          `[${bot.username}] already passed ${EPISODE_MIN_TICKS} ticks (elapsed: ${endTick - startTick})`,
        );
      }
    } else {
      console.log(
        `[${bot.username}] startTick is null, skipping minimum ticks check`,
      );
    }

    console.log(`[${bot.username}] ✅ STRUCTURE EVAL phase complete!`);

    // Transition to stop phase
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
      `structureEvalPhase_${iterationID} end`,
    );

    return buildResult;
  };
}

/**
 * Eval episode for independent structure building: each bot builds a small structure (wall_2x2,
 * wall_4x1, or tower_2x1) at a fixed distance, with eye contact and admire phases for evaluation.
 * @extends BaseEpisode
 */
class StructureEvalEpisode extends BaseEpisode {
  static INIT_MIN_BOTS_DISTANCE = 6;
  static INIT_MAX_BOTS_DISTANCE = 6;
  static WORKS_IN_NON_FLAT_WORLD = true;

  constructor(sharedBotRng) {
    super();
  }

  async setupEpisode(
    bot,
    rcon,
    sharedBotRng,
    coordinator,
    episodeNum,
    args,
    botPosition,
    otherBotPosition,
  ) {
    for (const blockType of BUILD_BLOCK_TYPES) {
      await ensureBotHasEnough(bot, rcon, blockType, 64);
    }
    await unequipHand(bot);
    return {
      botPositionNew: botPosition,
      otherBotPositionNew: otherBotPosition,
    };
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
    coordinator.onceEvent(
      `structureEvalPhase_${iterationID}`,
      episodeNum,
      getOnStructureEvalPhaseFn(
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
      `structureEvalPhase_${iterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      "entryPoint end",
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
    // Clean up any remaining blocks from inventory
  }
}

module.exports = { StructureEvalEpisode };
