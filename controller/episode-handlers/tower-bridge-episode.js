// tower-bridge-episode.js - Episode where bots build towers then bridge towards each other
const { Vec3 } = require("vec3");

const { buildBridge, buildTowerUnderneath } = require("../primitives/building");
const { ensureBotHasEnough, unequipHand } = require("../primitives/items");
const { initializePathfinder, sleep, stopPathfinder } = require("../primitives/movement");
const { BaseEpisode } = require("./base-episode");

// Constants for tower-bridge behavior
const INITIAL_EYE_CONTACT_MS = 1500; // Initial look duration
const FINAL_EYE_CONTACT_MS = 1500; // Final look duration
const TOWER_HEIGHT = 8; // Fixed tower height
const TOWER_BLOCK_TYPE = "oak_planks"; // Block type for towers
const BRIDGE_BLOCK_TYPE = "oak_planks"; // Block type for bridge
const BRIDGE_TIMEOUT_MS = 60000; // 60 seconds max for bridge building
const BRIDGE_GOAL_DISTANCE = 1.0; // How close to get to midpoint (blocks) - prevents bot overlap

/**
 * Get the phase function for tower-bridge episodes
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
function getOnTowerBridgePhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  iterationID,
  episodeNum,
  episodeInstance,
  args,
) {
  return async function onTowerBridgePhase(otherBotPosition) {
    coordinator.sendToOtherBot(
      `towerBridgePhase_${iterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      `towerBridgePhase_${iterationID} beginning`,
    );

    console.log(
      `[${bot.username}] 🚀 Starting TOWER-BRIDGE phase ${iterationID}`,
    );
    console.log(
      `[${bot.username}] 🎬 TOWER-BRIDGE EPISODE - Episode ${episodeNum}, Iteration ${iterationID}`,
    );

    // Initialize pathfinder with full capabilities for optimal movement
    console.log(
      `[${bot.username}] 🧭 Initializing pathfinder with full capabilities...`,
    );
    initializePathfinder(bot, {
      allowSprinting: false, // No sprinting to maintain control during building
      allowParkour: true, // Allow jumping gaps
      canDig: true, // Can break blocks if needed
      canPlaceOn: true, // Can place blocks to bridge gaps
      allowEntityDetection: true, // Avoid other entities
    });

    // STEP 1: Bots spawn (already done by teleport phase)
    console.log(`[${bot.username}] ✅ STEP 1: Bot spawned`);

    // STEP 2: Initial eye contact
    console.log(
      `[${bot.username}] 👀 STEP 2: Making eye contact with ${args.other_bot_name}...`,
    );
    let actualOtherBotPosition = null;
    try {
      const otherEntity = bot.players[args.other_bot_name]?.entity;
      if (otherEntity) {
        actualOtherBotPosition = otherEntity.position.clone();
        const targetPos = otherEntity.position.offset(0, otherEntity.height, 0);
        await bot.lookAt(targetPos, false);
        await sleep(INITIAL_EYE_CONTACT_MS);
      } else {
        console.log(
          `[${bot.username}] ⚠️ Could not find other bot entity, using passed position`,
        );
        actualOtherBotPosition = otherBotPosition.clone();
      }
    } catch (lookError) {
      console.log(
        `[${bot.username}] ⚠️ Could not look at other bot: ${lookError.message}`,
      );
      actualOtherBotPosition = otherBotPosition.clone();
    }

    console.log(
      `[${bot.username}] 🚶 STEP 3: Moving backward SKIPPED MANUALLY...`,
    );

    // STEP 4: Build tower underneath (8 blocks high)
    console.log(
      `[${bot.username}] 🗼 STEP 4: Building ${TOWER_HEIGHT}-block tower...`,
    );
    const towerResult = await buildTowerUnderneath(bot, TOWER_HEIGHT, args, {
      blockType: TOWER_BLOCK_TYPE,
      enableRetry: true, // tower-bridge uses robust version with retry logic
      breakOnFailure: false, // continues despite failures
    });

    if (towerResult.failed > 2) {
      console.log(
        `[${bot.username}] ⚠️ Tower build failed significantly, aborting episode...`,
      );
      throw new Error("Tower build failed significantly, aborting episode...");
    }

    if (towerResult.failed > 0 || towerResult.heightGained < TOWER_HEIGHT - 1) {
      console.log(
        `[${bot.username}] ⚠️ Tower build incomplete, but continuing...`,
      );
    }

    // Wait a moment for both bots to finish their towers
    await sleep(1500);

    // STEP 5: Enable sneaking to prevent falling off tower
    console.log(
      `[${bot.username}] 🐢 STEP 5: Enabling sneak mode (crouch) to prevent falling...`,
    );
    bot.setControlState("sneak", true);
    await sleep(500);
    console.log(
      `[${bot.username}] ✅ Sneak mode enabled - safe to build bridge!`,
    );

    // STEP 6: Look at each other from top of towers
    console.log(
      `[${bot.username}] 👀 STEP 6: Looking at other bot from tower top...`,
    );
    try {
      const otherEntity2 = bot.players[args.other_bot_name]?.entity;
      if (otherEntity2) {
        actualOtherBotPosition = otherEntity2.position.clone();
        const targetPos = otherEntity2.position.offset(
          0,
          otherEntity2.height,
          0,
        );
        await bot.lookAt(targetPos, false);
        await sleep(INITIAL_EYE_CONTACT_MS);
      }
    } catch (lookError) {
      console.log(
        `[${bot.username}] ⚠️ Could not look at other bot: ${lookError.message}`,
      );
    }

    // STEP 7: Calculate midpoint at new height
    console.log(
      `[${bot.username}] 📐 STEP 7: Calculating midpoint at tower height...`,
    );
    const myPos = bot.entity.position.clone();

    // Try to get updated other bot position
    const otherEntity3 = bot.players[args.other_bot_name]?.entity;
    if (otherEntity3) {
      actualOtherBotPosition = otherEntity3.position.clone();
    }

    const midpoint = new Vec3(
      Math.floor((myPos.x + actualOtherBotPosition.x) / 2),
      Math.floor(myPos.y), // Same Y level (top of tower)
      Math.floor((myPos.z + actualOtherBotPosition.z) / 2),
    );

    console.log(
      `[${bot.username}] 📍 My position: ${myPos.x.toFixed(
        2,
      )}, ${myPos.y.toFixed(2)}, ${myPos.z.toFixed(2)}`,
    );
    console.log(
      `[${
        bot.username
      }] 📍 Other bot position: ${actualOtherBotPosition.x.toFixed(
        2,
      )}, ${actualOtherBotPosition.y.toFixed(
        2,
      )}, ${actualOtherBotPosition.z.toFixed(2)}`,
    );
    console.log(
      `[${bot.username}] 🎯 Midpoint (original): ${midpoint.x}, ${midpoint.y}, ${midpoint.z}`,
    );

    // Snap to shared cardinal line based on which axis has more distance
    // This ensures BOTH bots target the same point
    const totalDx = Math.abs(actualOtherBotPosition.x - myPos.x);
    const totalDz = Math.abs(actualOtherBotPosition.z - myPos.z);

    let targetPoint;
    if (totalDx > totalDz) {
      // Bots are farther apart in X direction, so build along X-axis
      // Both bots use the SAME Z coordinate (the midpoint Z)
      targetPoint = new Vec3(
        midpoint.x,
        midpoint.y,
        Math.floor((myPos.z + actualOtherBotPosition.z) / 2),
      );
      console.log(
        `[${bot.username}] 🧭 Building along X-axis (East/West) - shared Z at ${targetPoint.z}`,
      );
    } else {
      // Bots are farther apart in Z direction, so build along Z-axis
      // Both bots use the SAME X coordinate (the midpoint X)
      targetPoint = new Vec3(
        Math.floor((myPos.x + actualOtherBotPosition.x) / 2),
        midpoint.y,
        midpoint.z,
      );
      console.log(
        `[${bot.username}] 🧭 Building along Z-axis (North/South) - shared X at ${targetPoint.x}`,
      );
    }

    console.log(
      `[${bot.username}] 🎯 Target point (shared cardinal): ${targetPoint.x}, ${targetPoint.y}, ${targetPoint.z}`,
    );

    // STEP 8: Build bridge towards midpoint
    console.log(
      `[${bot.username}] 🌉 STEP 8: Building bridge towards midpoint...`,
    );
    const bridgeResult = await buildBridge(
      bot,
      targetPoint,
      BRIDGE_BLOCK_TYPE,
      BRIDGE_GOAL_DISTANCE,
      BRIDGE_TIMEOUT_MS,
      args,
    );

    console.log(
      `[${bot.username}] ✅ Bridge building complete! Placed ${bridgeResult.blocksPlaced} blocks`,
    );

    // Disable sneaking after bridge is complete
    console.log(`[${bot.username}] 🚶 Disabling sneak mode...`);
    bot.setControlState("sneak", false);
    await sleep(300);

    // STEP 9: Final eye contact
    console.log(`[${bot.username}] 👀 STEP 9: Final eye contact...`);
    try {
      const otherEntity4 = bot.players[args.other_bot_name]?.entity;
      if (otherEntity4) {
        const targetPos = otherEntity4.position.offset(
          0,
          otherEntity4.height,
          0,
        );
        await bot.lookAt(targetPos, false);
        await sleep(FINAL_EYE_CONTACT_MS);
      }
    } catch (lookError) {
      console.log(
        `[${bot.username}] ⚠️ Could not look at other bot: ${lookError.message}`,
      );
    }

    console.log(`[${bot.username}] ✅ TOWER-BRIDGE phase complete!`);
    console.log(
      `[${bot.username}] 📊 Final stats: Tower ${towerResult.heightGained} blocks, Bridge ${bridgeResult.blocksPlaced} blocks`,
    );

    // Clean up pathfinder
    console.log(`[${bot.username}] 🧹 Stopping pathfinder...`);
    stopPathfinder(bot);

    // STEP 10: Transition to stop phase (end episode)
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
      `towerBridgePhase_${iterationID} end`,
    );

    return { towerResult, bridgeResult };
  };
}

/**
 * Episode where both bots build a tower, then bridge toward the midpoint between them.
 * Sneak is used on the tower to avoid falling; bridge target is on a shared cardinal axis.
 * @extends BaseEpisode
 */
class TowerBridgeEpisode extends BaseEpisode {
  static INIT_MIN_BOTS_DISTANCE = 12;
  static INIT_MAX_BOTS_DISTANCE = 20;
  static WORKS_IN_NON_FLAT_WORLD = true;

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
    await ensureBotHasEnough(bot, rcon, BRIDGE_BLOCK_TYPE, 64);
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
      `towerBridgePhase_${iterationID}`,
      episodeNum,
      getOnTowerBridgePhaseFn(
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
      `towerBridgePhase_${iterationID}`,
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
  ) {}
}

module.exports = { TowerBridgeEpisode };
