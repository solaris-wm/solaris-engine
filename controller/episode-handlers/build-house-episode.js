// build-house-episode.js - Collaborative 5x5 house building episode
const { Vec3 } = require("vec3");

const {
  sleep,
  initializePathfinder,
  stopPathfinder,
} = require("../primitives/movement");
const {
  makeHouseBlueprint5x5,
  rotateLocalToWorld,
  splitWorkByXAxis,
  buildPhase,
  admireHouse,
  calculateMaterialCounts,
} = require("../primitives/building");
const { BaseEpisode } = require("./base-episode");
const { ensureBotHasEnough } = require("../primitives/items");

// Constants for house building behavior
const INITIAL_EYE_CONTACT_MS = 1500; // Initial look duration
const FINAL_EYE_CONTACT_MS = 2000; // Final admiration duration
const BLOCK_PLACE_DELAY_MS = 200; // Delay between placing blocks
const ORIENTATION = 0; // Only 0° supported for now (south-facing door)

// Material set (cobblestone house)
const MATERIALS = {
  floor: "cobblestone",
  walls: "oak_planks",
  door: "oak_door",
  windows: "glass_pane",
  roof: "oak_log",
};

/**
 * Get the setup phase function for house building episodes
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} rcon - RCON connection
 * @param {Function} sharedBotRng - Shared random number generator
 * @param {*} coordinator - Bot coordinator instance
 * @param {number} iterationID - Iteration ID
 * @param {number} episodeNum - Episode number
 * @param {Object} episodeInstance - Episode instance
 * @param {Object} args - Configuration arguments
 * @returns {Function} Setup phase function
 */
function getOnBuildHouseSetupPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  iterationID,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (phaseDataOther) => {
    coordinator.sendToOtherBot(
      `buildHouseSetupPhase_${iterationID}`,
      { position: bot.entity.position.clone() },
      episodeNum,
      `buildHouseSetupPhase_${iterationID} beginning`,
    );

    // Capture our position for the build phase
    const buildPhaseDataOur = {
      position: bot.entity.position.clone(),
    };

    // Transition to build phase
    coordinator.onceEvent(
      `buildHousePhase_${iterationID}`,
      episodeNum,
      getOnBuildHousePhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        iterationID,
        episodeNum,
        episodeInstance,
        args,
        buildPhaseDataOur,
      ),
    );
    coordinator.sendToOtherBot(
      `buildHousePhase_${iterationID}`,
      buildPhaseDataOur,
      episodeNum,
      `buildHouseSetupPhase_${iterationID} end`,
    );
  };
}

/**
 * Get the build phase function for house building episodes
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} rcon - RCON connection
 * @param {Function} sharedBotRng - Shared random number generator
 * @param {*} coordinator - Bot coordinator instance
 * @param {number} iterationID - Iteration ID
 * @param {number} episodeNum - Episode number
 * @param {Object} episodeInstance - Episode instance
 * @param {Object} args - Configuration arguments
 * @param {Object} phaseDataOur - Phase data with captured position
 * @returns {Function} Phase function
 */
function getOnBuildHousePhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  iterationID,
  episodeNum,
  episodeInstance,
  args,
  phaseDataOur,
) {
  return async function onBuildHousePhase(phaseDataOther) {
    coordinator.sendToOtherBot(
      `buildHousePhase_${iterationID}`,
      phaseDataOur,
      episodeNum,
      `buildHousePhase_${iterationID} beginning`,
    );

    console.log(
      `[${bot.username}] 🏠 Starting BUILD HOUSE phase ${iterationID}`,
    );

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

    // STEP 3: Determine world origin for house (midpoint between bots)
    console.log(`[${bot.username}] 📐 STEP 3: Planning house location...`);

    // Reconstruct Vec3 from received position data (positions are serialized when sent between bots)
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

    // Use the higher Y level between bots to ensure consistent elevation
    const maxBotY = Math.max(botPos.y, otherBotPos.y);
    const worldOrigin = new Vec3(
      Math.floor((botPos.x + otherBotPos.x) / 2),
      Math.floor(maxBotY), // Use higher Y level for consistency
      Math.floor((botPos.z + otherBotPos.z) / 2),
    );

    console.log(
      `[${bot.username}] 🏗️ House origin: (${worldOrigin.x}, ${worldOrigin.y}, ${worldOrigin.z})`,
    );

    // STEP 4: Generate blueprint and convert to world coordinates
    console.log(`[${bot.username}] 📋 STEP 4: Generating blueprint...`);
    const blueprint = makeHouseBlueprint5x5({
      materials: episodeInstance.materials,
    });

    // Convert all local coords to world coords
    const worldTargets = blueprint.map((target) => ({
      ...target,
      worldPos: rotateLocalToWorld(target, worldOrigin, ORIENTATION),
    }));

    console.log(`[${bot.username}]    Total blocks: ${worldTargets.length}`);

    // STEP 5: Initialize pathfinder for building
    console.log(`[${bot.username}] 🚶 STEP 5: Initializing pathfinder...`);
    initializePathfinder(bot, {
      allowSprinting: false,
      allowParkour: true,
      canDig: true,
      allowEntityDetection: true,
    });

    // STEP 6: Build in phases (floor → walls → windows → roof)
    console.log(`[${bot.username}] 🏗️ STEP 6: Building house in phases...`);
    const phases = ["floor", "walls", "roof"]; // windows are not placed for better performance
    let phaseAborted = false;

    try {
      for (const phaseName of phases) {
        if (bot._episodeStopping) {
          phaseAborted = true;
          console.log(
            `[${bot.username}] 🛑 Stop requested before ${phaseName} phase, aborting build loop`,
          );
          break;
        }

        console.log(
          `[${bot.username}] ═══════════════════════════════════════`,
        );
        console.log(
          `[${bot.username}] 🔨 Building phase: ${phaseName.toUpperCase()}`,
        );
        console.log(
          `[${bot.username}] 🕐 Phase start time: ${new Date().toISOString()}`,
        );

        // Get all targets for this phase
        const phaseTargets = worldTargets.filter((t) => t.phase === phaseName);

        // Split work between bots using X-axis split
        const { alphaTargets, bravoTargets } = splitWorkByXAxis(
          phaseTargets,
          args.bot_name,
          args.other_bot_name,
        );

        // Determine which half based on proximity to house origin
        const botIsOnWestSide = botPos.x < worldOrigin.x;
        const otherBotIsOnWestSide = otherBotPos.x < worldOrigin.x;

        // If conflict (both bots on same side), use bot identity as tie-breaker
        let myTargets;
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
          `[${bot.username}] 📍 Spawn position: (${botPos.x}, ${botPos.z}), House origin: (${worldOrigin.x}, ${worldOrigin.z})`,
        );
        console.log(
          `[${bot.username}] 🏗️ Assigned ${myTargets.length}/${phaseTargets.length} blocks`,
        );

        // Build this bot's assigned blocks
        if (myTargets.length > 0) {
          console.log(
            `[${bot.username}] 🏗️ Starting to build my ${myTargets.length} blocks...`,
          );
          const result = await buildPhase(bot, myTargets, {
            args: args,
            delayMs: BLOCK_PLACE_DELAY_MS,
            shouldAbort: () => bot._episodeStopping,
          });
          console.log(`[${bot.username}] ✅ Finished building my blocks`);

          if (result.aborted) {
            phaseAborted = true;
            console.log(
              `[${bot.username}] 🛑 ${phaseName} phase aborted due to stop request`,
            );
            break;
          }

          // Check for catastrophic failure (more than 50% failed)
          if (result.failed > myTargets.length * 0.5) {
            console.log(
              `[${bot.username}] ❌ Phase ${phaseName} failed significantly: ${result.failed}/${myTargets.length} blocks failed`,
            );
            throw new Error(
              `Phase ${phaseName} failed: ${result.failed}/${myTargets.length} blocks failed`,
            );
          }
        } else {
          console.log(
            `[${bot.username}] ⏭️ No blocks assigned to me in this phase, skipping...`,
          );
        }

        // Wait for other bot to finish this phase
        console.log(
          `[${bot.username}]    Waiting for ${args.other_bot_name}...`,
        );
        await sleep(1000); // Give other bot time to catch up
        console.log(
          `[${bot.username}] ✅ Phase ${phaseName} complete at ${new Date().toISOString()}`,
        );
      }

      if (!phaseAborted) {
        console.log(`[${bot.username}] ✅ All phases complete!`);
      }
    } catch (buildError) {
      console.error(
        `[${bot.username}] ❌ Building failed: ${buildError.message}`,
      );

      // Stop pathfinder immediately using setGoal(null)
      if (bot.pathfinder) {
        bot.pathfinder.setGoal(null);
      }

      // Re-throw the error so episode system handles it properly
      throw buildError;
    }

    // STEP 7: Stop pathfinder
    stopPathfinder(bot);

    if (bot._episodeStopping) {
      console.log(
        `[${bot.username}] 🛑 Stop phase already in progress, skipping admiration/stop transition`,
      );
      return;
    }

    // STEP 8: Exit through door and admire the house
    console.log(`[${bot.username}] 🚪 STEP 8: Exiting and admiring house...`);

    // Re-initialize pathfinder for admiration movement
    initializePathfinder(bot, {
      allowSprinting: false,
      allowParkour: true,
      canDig: true,
      canPlaceOn: true, // Disable scaffolding - let bots jump down from roof
      allowEntityDetection: true,
    });

    const doorWorldPos = rotateLocalToWorld(
      { x: 2, y: 1, z: 0 },
      worldOrigin,
      ORIENTATION,
    );

    // STEP 9: Exit house and admire from 15 blocks away
    await admireHouse(bot, doorWorldPos, ORIENTATION, { backOff: 15 });

    stopPathfinder(bot);

    console.log(`[${bot.username}] ✅ BUILD HOUSE phase complete!`);
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
      `buildHousePhase_${iterationID} end`,
    );
  };
}

/**
 * Episode for collaborative 5x5 house building. Both bots coordinate to build a shared house
 * at the midpoint between them, splitting work by X-axis.
 * @extends BaseEpisode
 */
class BuildHouseEpisode extends BaseEpisode {
  static INIT_MIN_BOTS_DISTANCE = 10;
  static INIT_MAX_BOTS_DISTANCE = 20;
  static WORKS_IN_NON_FLAT_WORLD = true; // Auto-scaffolding enabled

  constructor(sharedBotRng) {
    super();
    // Pick random material set for this episode
    this.materials = MATERIALS;
    console.log(`[BuildHouseEpisode] Selected materials:`, this.materials);
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
    console.log(`[${bot.username}] 🏠 Setting up house building episode...`);

    // Generate blueprint to calculate material needs
    const blueprint = makeHouseBlueprint5x5({
      materials: this.materials,
    });

    // Calculate material counts
    const materialCounts = calculateMaterialCounts(blueprint);

    // Add extra blocks for scaffolding (100% more = 2x total)
    // Pathfinder now uses correct block types for scaffolding, so we need more materials
    const safetyMaterials = {};
    for (const [block, count] of Object.entries(materialCounts)) {
      safetyMaterials[block] = Math.ceil(count * 2.0); // 2x for scaffolding consumption
    }

    console.log(
      `[${bot.username}] 📦 Giving building materials (2x for scaffolding):`,
      safetyMaterials,
    );

    // Use ensureBotHasEnough for each material (matches working episodes)
    for (const [blockType, count] of Object.entries(safetyMaterials)) {
      await ensureBotHasEnough(bot, rcon, blockType, count);
    }

    // Return unchanged positions since we don't move bots during setup
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
      `buildHouseSetupPhase_${iterationID}`,
      episodeNum,
      getOnBuildHouseSetupPhaseFn(
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
      `buildHouseSetupPhase_${iterationID}`,
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
    console.log(`[${bot.username}] 🧹 Cleaning up house building episode...`);
    // Clean up pathfinder if still active
    if (bot.pathfinder) {
      stopPathfinder(bot);
    }
  }
}

module.exports = {
  BuildHouseEpisode,
};
