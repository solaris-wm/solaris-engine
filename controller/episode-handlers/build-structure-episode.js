// build-structure-episode.js - Collaborative building episode
const { Vec3 } = require("vec3");

const { buildPhase, rotateLocalToWorld, splitWorkByXAxis } = require("../primitives/building");
const { ensureBotHasEnough, unequipHand } = require("../primitives/items");
const { initializePathfinder, sleep, stopPathfinder } = require("../primitives/movement");
const { pickRandom } = require("../utils/coordination");
const { BaseEpisode } = require("./base-episode");

// Constants for building behavior
const ALL_STRUCTURE_TYPES = ["wall", "tower", "platform"];
const INITIAL_EYE_CONTACT_MS = 1500; // Initial look duration
const BUILD_BLOCK_TYPES = ["stone", "cobblestone", "oak_planks", "bricks"];
const BLOCK_PLACE_DELAY_MS = 300; // Delay between placing blocks
const ORIENTATION = 0; // Only 0° supported for now

/**
 * Generate blueprint for a wall structure (5 blocks wide × 2 blocks tall)
 * @param {Object} options - Configuration options
 * @param {string} options.blockType - Block type to use
 * @returns {Array<Object>} Array of {x, y, z, block, phase, placementOrder}
 */
function makeWallBlueprint(options = {}) {
  const { blockType = "stone" } = options;
  const blueprint = [];

  const width = 5;
  const height = 2;

  // Build bottom-up, left-to-right
  let order = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      blueprint.push({
        x,
        y,
        z: 0,
        block: blockType,
        phase: "wall",
        placementOrder: order++,
        data: null,
      });
    }
  }

  return blueprint;
}

/**
 * Generate blueprint for a tower structure (single column, 2 blocks tall)
 * @param {Object} options - Configuration options
 * @param {string} options.blockType - Block type to use
 * @returns {Array<Object>} Array of {x, y, z, block, phase, placementOrder}
 */
function makeTowerBlueprint(options = {}) {
  const { blockType = "stone" } = options;
  const blueprint = [];

  const height = 2;

  // Build bottom-up
  for (let y = 0; y < height; y++) {
    blueprint.push({
      x: 0,
      y,
      z: 0,
      block: blockType,
      phase: "tower",
      placementOrder: y,
      data: null,
    });
  }

  return blueprint;
}

/**
 * Generate blueprint for a platform structure (4×4 grid)
 * @param {Object} options - Configuration options
 * @param {string} options.blockType - Block type to use
 * @returns {Array<Object>} Array of {x, y, z, block, phase, placementOrder}
 */
function makePlatformBlueprint(options = {}) {
  const { blockType = "stone" } = options;
  const blueprint = [];

  const width = 4;
  const depth = 4;

  // Build edge-to-center spiral (same as house floor)
  let order = 0;
  let minX = 0,
    maxX = width - 1;
  let minZ = 0,
    maxZ = depth - 1;

  while (minX <= maxX && minZ <= maxZ) {
    // Top edge (left to right)
    for (let x = minX; x <= maxX; x++) {
      blueprint.push({
        x,
        y: 0,
        z: minZ,
        block: blockType,
        phase: "platform",
        placementOrder: order++,
        data: null,
      });
    }
    minZ++;

    // Right edge (top to bottom)
    for (let z = minZ; z <= maxZ; z++) {
      blueprint.push({
        x: maxX,
        y: 0,
        z,
        block: blockType,
        phase: "platform",
        placementOrder: order++,
        data: null,
      });
    }
    maxX--;

    // Bottom edge (right to left)
    if (minZ <= maxZ) {
      for (let x = maxX; x >= minX; x--) {
        blueprint.push({
          x,
          y: 0,
          z: maxZ,
          block: blockType,
          phase: "platform",
          placementOrder: order++,
          data: null,
        });
      }
      maxZ--;
    }

    // Left edge (bottom to top)
    if (minX <= maxX) {
      for (let z = maxZ; z >= minZ; z--) {
        blueprint.push({
          x: minX,
          y: 0,
          z,
          block: blockType,
          phase: "platform",
          placementOrder: order++,
          data: null,
        });
      }
      minX++;
    }
  }

  return blueprint;
}

/**
 * Get the phase function for building episodes
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} rcon - RCON connection
 * @param {Function} sharedBotRng - Shared random number generator
 * @param {*} coordinator - Bot coordinator instance
 * @param {number} iterationID - Iteration ID
 * @param {number} episodeNum - Episode number
 * @param {Object} episodeInstance - Episode instance
 * @param {Object} args - Configuration arguments
 * @param {string} structureType - Type of structure ('wall', 'tower', 'platform')
 * @param {Object} phaseDataOur - Phase data for this bot (contains position)
 * @returns {Function} Phase function
 */
function getOnBuildPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  iterationID,
  episodeNum,
  episodeInstance,
  args,
  structureType = "wall",
  phaseDataOur,
) {
  return async function onBuildPhase(phaseDataOther) {
    coordinator.sendToOtherBot(
      `buildPhase_${iterationID}`,
      phaseDataOur,
      episodeNum,
      `buildPhase_${iterationID} beginning`,
    );

    console.log(`[${bot.username}] 🚀 Starting BUILD phase ${iterationID}`);

    // STEP 1: Bots spawn (already done by teleport phase)
    console.log(`[${bot.username}] ✅ STEP 1: Bot spawned`);

    // STEP 2: Initial eye contact
    console.log(
      `[${bot.username}] 👀 STEP 2: Making eye contact with ${args.other_bot_name}...`,
    );
    try {
      const otherEntity = bot.players[args.other_bot_name]?.entity;
      if (otherEntity) {
        const targetPos = otherEntity.position.offset(0, otherEntity.height, 0);
        await bot.lookAt(targetPos, false);
        await sleep(INITIAL_EYE_CONTACT_MS);
      }
    } catch (lookError) {
      console.log(
        `[${bot.username}] ⚠️ Could not look at other bot: ${lookError.message}`,
      );
    }

    // STEP 3: Determine world origin for structure (midpoint between bots)
    console.log(
      `[${bot.username}] 📐 STEP 3: Planning structure ${structureType}...`,
    );

    // Reconstruct Vec3 from received position data
    const botPos = new Vec3(
      phaseDataOur.position.x,
      phaseDataOur.position.y,
      phaseDataOur.position.z,
    ).floored();
    const otherBotPos = new Vec3(
      phaseDataOther.position.x,
      phaseDataOther.position.y,
      phaseDataOther.position.z,
    ).floored();

    // For wall and tower: each bot builds at their own position
    // For platform: build at midpoint (collaborative)
    let worldOrigin;
    if (structureType === "wall" || structureType === "tower") {
      // Each bot builds their own structure at their spawn location
      worldOrigin = botPos.clone();
      console.log(
        `[${bot.username}] 🏗️ Building individual ${structureType} at bot position: (${worldOrigin.x}, ${worldOrigin.y}, ${worldOrigin.z})`,
      );
    } else {
      // Platform: build at midpoint between bots (collaborative)
      // Use the higher Y level between bots to ensure consistent elevation
      const maxBotY = Math.max(botPos.y, otherBotPos.y);
      worldOrigin = new Vec3(
        Math.floor((botPos.x + otherBotPos.x) / 2),
        Math.floor(maxBotY), // Use higher Y level for consistency (lower bot will pathfind up)
        Math.floor((botPos.z + otherBotPos.z) / 2),
      );
      console.log(
        `[${bot.username}] 🏗️ Platform origin (midpoint at higher Y): (${worldOrigin.x}, ${worldOrigin.y}, ${worldOrigin.z}) [maxY: ${maxBotY}]`,
      );
    }

    // STEP 4: Generate blueprint and convert to world coordinates
    console.log(`[${bot.username}] 📋 STEP 4: Generating blueprint...`);

    // Pick block type using shared RNG
    const blockType =
      BUILD_BLOCK_TYPES[Math.floor(sharedBotRng() * BUILD_BLOCK_TYPES.length)];
    console.log(`[${bot.username}] 📦 Block type: ${blockType}`);

    let blueprint;
    if (structureType === "wall") {
      blueprint = makeWallBlueprint({ blockType });
    } else if (structureType === "tower") {
      blueprint = makeTowerBlueprint({ blockType });
    } else if (structureType === "platform") {
      blueprint = makePlatformBlueprint({ blockType });
    }

    // Convert all local coords to world coords
    const worldTargets = blueprint.map((target) => ({
      ...target,
      worldPos: rotateLocalToWorld(target, worldOrigin, ORIENTATION),
    }));

    console.log(`[${bot.username}]    Total blocks: ${worldTargets.length}`);

    // STEP 5: Assign work (split only for platform, full structure for wall/tower)
    console.log(`[${bot.username}] 🔀 STEP 5: Assigning work...`);

    let myTargets;

    if (structureType === "platform") {
      // Platform: Split work between bots
      const { alphaTargets, bravoTargets } = splitWorkByXAxis(
        worldTargets,
        args.bot_name,
        args.other_bot_name,
      );

      // Determine which half based on proximity to structure origin
      const botIsOnWestSide = botPos.x < worldOrigin.x;
      const otherBotIsOnWestSide = otherBotPos.x < worldOrigin.x;

      // If conflict (both bots on same side), use bot identity as tie-breaker
      if (botIsOnWestSide === otherBotIsOnWestSide) {
        // Tie! Use alphabetical order: Alpha gets west, Bravo gets east
        const isAlphaBot = bot.username < args.other_bot_name;
        myTargets = isAlphaBot ? alphaTargets : bravoTargets;
        console.log(
          `[${bot.username}] ⚠️ Both bots on ${botIsOnWestSide ? "WEST" : "EAST"} side - using tie-breaker (${isAlphaBot ? "WEST" : "EAST"} half)`,
        );
      } else {
        // No conflict - use proximity-based assignment
        myTargets = botIsOnWestSide ? alphaTargets : bravoTargets;
        console.log(
          `[${bot.username}] ✅ Using proximity-based assignment (${botIsOnWestSide ? "WEST" : "EAST"} half)`,
        );
      }

      console.log(
        `[${bot.username}] 📍 Spawn position: (${botPos.x}, ${botPos.z}), Platform origin: (${worldOrigin.x}, ${worldOrigin.z})`,
      );
      console.log(
        `[${bot.username}] 🏗️ Assigned ${myTargets.length}/${worldTargets.length} blocks (collaborative build)`,
      );
    } else {
      // Wall/Tower: Each bot builds their own complete structure
      myTargets = worldTargets;
      console.log(
        `[${bot.username}] ✅ Building complete ${structureType} independently`,
      );
      console.log(
        `[${bot.username}] 📍 Structure position: (${worldOrigin.x}, ${worldOrigin.y}, ${worldOrigin.z})`,
      );
      console.log(
        `[${bot.username}] 🏗️ Assigned ${myTargets.length} blocks (individual build)`,
      );
    }

    // STEP 6: Initialize pathfinder for building
    console.log(`[${bot.username}] 🚶 STEP 6: Initializing pathfinder...`);
    initializePathfinder(bot, {
      allowSprinting: false,
      allowParkour: true,
      canDig: false,
      allowEntityDetection: true,
    });

    // STEP 7: Build the structure
    console.log(`[${bot.username}] 🏗️ STEP 7: Building structure...`);

    let buildResult;
    try {
      buildResult = await buildPhase(bot, myTargets, {
        args: args,
        delayMs: BLOCK_PLACE_DELAY_MS,
        shouldAbort: () => bot._episodeStopping,
      });

      if (buildResult.aborted) {
        console.log(`[${bot.username}] 🛑 Build aborted due to stop request`);
        stopPathfinder(bot);
        return;
      }

      // Check for catastrophic failure (more than 50% failed)
      if (buildResult.failed > myTargets.length * 0.5) {
        console.log(
          `[${bot.username}] ❌ Build failed significantly: ${buildResult.failed}/${myTargets.length} blocks failed`,
        );
        throw new Error(
          `Build failed: ${buildResult.failed}/${myTargets.length} blocks failed`,
        );
      }

      console.log(`[${bot.username}] ✅ Build complete!`);
    } catch (buildError) {
      console.error(
        `[${bot.username}] ❌ Building failed: ${buildError.message}`,
      );

      // Stop pathfinder immediately
      if (bot.pathfinder) {
        bot.pathfinder.setGoal(null);
      }
      stopPathfinder(bot);

      // Re-throw the error so episode system handles it properly
      throw buildError;
    }

    // STEP 8: Stop pathfinder
    stopPathfinder(bot);

    if (bot._episodeStopping) {
      console.log(
        `[${bot.username}] 🛑 Stop phase already in progress, skipping final eye contact`,
      );
      return;
    }

    // STEP 9: Final eye contact
    console.log(`[${bot.username}] 👀 STEP 9: Final eye contact...`);
    try {
      const otherEntity = bot.players[args.other_bot_name]?.entity;
      if (otherEntity) {
        const targetPos = otherEntity.position.offset(0, otherEntity.height, 0);
        await bot.lookAt(targetPos, false);
        await sleep(INITIAL_EYE_CONTACT_MS);
      }
    } catch (lookError) {
      console.log(
        `[${bot.username}] ⚠️ Could not look at other bot: ${lookError.message}`,
      );
    }

    console.log(`[${bot.username}] ✅ BUILD phase complete!`);

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
      phaseDataOur,
      episodeNum,
      `buildPhase_${iterationID} end`,
    );

    return buildResult;
  };
}

/**
 * Episode for collaborative structure building (wall, tower, or platform). Structure type is
 * chosen per episode via shared RNG; wall/tower are built individually, platform is split by X-axis.
 * @extends BaseEpisode
 */
class BuildStructureEpisode extends BaseEpisode {
  static INIT_MIN_BOTS_DISTANCE = 8;
  static INIT_MAX_BOTS_DISTANCE = 15;
  static WORKS_IN_NON_FLAT_WORLD = true;

  constructor(sharedBotRng) {
    super();
    this.structureType = pickRandom(ALL_STRUCTURE_TYPES, sharedBotRng);
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
    console.log(
      `[${bot.username}] 🏗️ Setting up structure building episode...`,
    );

    // Give all block types (we'll pick one during build phase using shared RNG)
    console.log(`[${bot.username}] 📦 Giving building materials...`);
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
    const phaseDataOur = {
      position: bot.entity.position.clone(),
    };

    coordinator.onceEvent(
      `buildPhase_${iterationID}`,
      episodeNum,
      getOnBuildPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        iterationID,
        episodeNum,
        this,
        args,
        this.structureType,
        phaseDataOur,
      ),
    );
    coordinator.sendToOtherBot(
      `buildPhase_${iterationID}`,
      phaseDataOur,
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
    console.log(
      `[${bot.username}] 🧹 Cleaning up structure building episode...`,
    );
    // Clean up pathfinder if still active
    if (bot.pathfinder) {
      stopPathfinder(bot);
    }
  }
}

module.exports = { BuildStructureEpisode };
