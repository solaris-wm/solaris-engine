// mine-episode.js - Simplified mining episode using pathfinder with mining enabled
const { Vec3 } = require("vec3");

const { ensureItemInHand } = require("../primitives/items");
const { placeTorchOnFloor, digWithTimeout } = require("../primitives/digging");
const { unequipHand } = require("../primitives/items");
const {
  getScaffoldingBlockIds,
  gotoWithTimeout,
  sleep,
} = require("../primitives/movement");
const { BaseEpisode } = require("./base-episode");

// Constants for mining behavior
const INITIAL_EYE_CONTACT_MS = 1500; // Initial look duration
const FINAL_EYE_CONTACT_MS = 1500; // Final look duration
const TOOL_TYPE = "diamond_pickaxe"; // Tool for mining
const PATHFIND_TIMEOUT_MS = 60000; // 60 second timeout for pathfinding with mining
const UNDERGROUND_DEPTH = 1; // How many blocks to dig down before horizontal mining
const TORCH_TYPE = "torch"; // Torch item
const TORCH_PLACEMENT_INTERVAL = 999; // Place torches every 999 blocks (effectively disabled for short episodes)
const LOOK_DELAY_MS = 500; // Delay after looking to make camera movement visible
const FALL_DELAY_MS = 800; // Delay to wait for falling after digging down
const TORCH_EQUIP_DELAY_MS = 500; // Delay after equipping torch
const TORCH_LOOK_DELAY_MS = 800; // Delay after looking at floor for torch placement
const TORCH_PLACE_DELAY_MS = 1200; // Delay after placing torch to make it visible

/**
 * Dig straight down to get underground before starting horizontal mining
 * @param {*} bot - Mineflayer bot instance
 * @param {number} depth - Number of blocks to dig down
 * @returns {Promise<boolean>} True if successfully dug down
 */
async function digDownToUnderground(bot, depth = UNDERGROUND_DEPTH) {
  console.log(
    `[${bot.username}] ⬇️ Digging down ${depth} blocks to start underground mining...`,
  );

  const startPos = bot.entity.position.clone();
  const startY = Math.floor(startPos.y);

  for (let i = 0; i < depth; i++) {
    const currentPos = bot.entity.position.clone();
    const blockBelowPos = new Vec3(
      Math.floor(currentPos.x),
      Math.floor(currentPos.y) - 1,
      Math.floor(currentPos.z),
    );

    const block = bot.blockAt(blockBelowPos);

    // Check if block exists and is not air
    if (!block) {
      console.log(
        `[${bot.username}] ⚠️ Block below not loaded, stopping dig down`,
      );
      break;
    }

    if (block.name === "air" || block.name === "cave_air") {
      console.log(`[${bot.username}] 🕳️ Air below (cave detected), falling...`);
      await sleep(500);
      continue;
    }

    // Check for dangerous blocks
    if (block.name.includes("lava")) {
      console.log(
        `[${bot.username}] 🛑 Lava detected below! Stopping dig down at depth ${i}`,
      );
      break;
    }

    console.log(
      `[${bot.username}] ⛏️ Digging down: ${block.name} at ${blockBelowPos} (${i + 1}/${depth})`,
    );

    try {
      // Look down (negative pitch looks down in Minecraft)
      await bot.look(bot.entity.yaw, -1.57, false); // -1.57 radians = 90 degrees down, smooth camera
      await sleep(LOOK_DELAY_MS);

      // Dig the block
      await digWithTimeout(bot, block);
      console.log(`[${bot.username}] ✅ Dug block ${i + 1}/${depth}`);

      // Wait to fall down
      await sleep(FALL_DELAY_MS);
    } catch (error) {
      console.log(`[${bot.username}] ❌ Failed to dig down: ${error.message}`);
      break;
    }
  }

  const endPos = bot.entity.position.clone();
  const actualDepth = startY - Math.floor(endPos.y);

  console.log(`[${bot.username}] ✅ Finished digging down`);
  console.log(`[${bot.username}]    Start Y: ${startY}`);
  console.log(`[${bot.username}]    Current Y: ${Math.floor(endPos.y)}`);
  console.log(`[${bot.username}]    Actual depth: ${actualDepth} blocks`);

  return actualDepth > 0;
}

/**
 * Mine towards a target position using pathfinder with mining enabled and torch placement
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} targetPos - Target position to mine towards
 * @returns {Promise<Object>} Mining statistics
 */
async function mineTowardsTargetWithTorchPlacement(bot, targetPos) {
  console.log(
    `[${bot.username}] 🚇 Mining towards ${targetPos} using pathfinder with torch placement`,
  );

  const startPos = bot.entity.position.clone();
  const startTime = Date.now();
  let lastTorchPos = startPos.clone();
  let torchesPlaced = 0;
  let intervalStopped = false; // Flag to stop interval callback

  // Initialize pathfinder with mining enabled
  const mcData = require("minecraft-data")(bot.version);
  const { Movements, goals } = require("mineflayer-pathfinder");
  const { GoalNear } = goals;

  // Configure movements to allow mining
  const movements = new Movements(bot, mcData);
  movements.canDig = true;
  movements.digCost = 0.1; // Very cheap digging - strongly prefer mining over walking
  movements.placeCost = 1000; // Extremely expensive placing to prevent climbing out
  movements.blocksCost = 10; // High cost for walking - makes surface path expensive
  movements.allowParkour = false;
  movements.allowSprinting = false; // Disable sprinting to prevent jumping out
  movements.canPlaceOn = true;
  movements.allowJumping = false; // Disable jumping completely
  movements.allowEntityDetection = true; // Avoid other bots
  movements.scafoldingBlocks = getScaffoldingBlockIds(mcData);
  movements.infiniteLiquidDropdownDistance = true;
  movements.maxDropDown = 15;
  movements.dontCreateFlow = true; // Safety: don't create water/lava flow
  movements.dontMineUnderFallingBlock = true; // Safety: avoid sand/gravel

  bot.pathfinder.setMovements(movements);

  const initialDistance = startPos.distanceTo(targetPos);
  console.log(
    `[${bot.username}] 📐 Distance to target: ${initialDistance.toFixed(2)} blocks`,
  );

  // Set goal with slightly larger tolerance so bots don't walk into each other
  // Range of 1.6 blocks allows both bots to finish tunnel without occupying same space
  const goal = new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1.6);

  // Set up periodic torch placement check
  const torchCheckInterval = setInterval(async () => {
    if (intervalStopped) return; // Stop executing interval callback

    const currentPos = bot.entity.position.clone();
    const distanceSinceLastTorch = currentPos.distanceTo(lastTorchPos);

    if (distanceSinceLastTorch >= TORCH_PLACEMENT_INTERVAL) {
      console.log(
        `[${bot.username}] 📏 Traveled ${distanceSinceLastTorch.toFixed(1)} blocks since last torch`,
      );

      // Re-equip pickaxe after placing torch
      const pickaxe = bot.inventory
        .items()
        .find((item) => item.name === TOOL_TYPE);
      const currentHand = bot.heldItem;

      const placed = await placeTorchOnFloor(
        bot,
        TORCH_TYPE,
        TORCH_EQUIP_DELAY_MS,
        TORCH_LOOK_DELAY_MS,
        TORCH_PLACE_DELAY_MS,
        LOOK_DELAY_MS,
      );

      if (placed) {
        torchesPlaced++;
        lastTorchPos = currentPos.clone();
        console.log(
          `[${bot.username}] ✅ Torch placed! Total: ${torchesPlaced}`,
        );
      } else {
        // Update position even if placement failed to prevent distance from growing
        lastTorchPos = currentPos.clone();
        console.log(
          `[${bot.username}] ⚠️ Torch placement failed, will try again in ${TORCH_PLACEMENT_INTERVAL} blocks`,
        );
      }

      // Re-equip pickaxe
      if (pickaxe && (!currentHand || currentHand.name !== TOOL_TYPE)) {
        await bot.equip(pickaxe, "hand");
        await sleep(100);
      }
    }
  }, 2000); // Check every 2 seconds

  try {
    console.log(
      `[${bot.username}] 🎯 Starting pathfinder navigation with mining and torch placement...`,
    );

    // Use pathfinder to navigate to target
    await gotoWithTimeout(bot, goal, { timeoutMs: PATHFIND_TIMEOUT_MS });

    const endPos = bot.entity.position.clone();
    const distanceTraveled = startPos.distanceTo(endPos);
    const timeElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const finalDistance = endPos.distanceTo(targetPos);

    console.log(`[${bot.username}] 🏁 Mining navigation complete!`);
    console.log(
      `[${bot.username}]    Distance traveled: ${distanceTraveled.toFixed(2)} blocks`,
    );
    console.log(`[${bot.username}]    Time elapsed: ${timeElapsed}s`);
    console.log(
      `[${bot.username}]    Final distance to target: ${finalDistance.toFixed(2)} blocks`,
    );
    console.log(`[${bot.username}]    Torches placed: ${torchesPlaced} 🔦`);

    return {
      success: true,
      distanceTraveled: distanceTraveled,
      timeElapsed: parseFloat(timeElapsed),
      reachedTarget: finalDistance < 1.5,
      finalDistance: finalDistance,
      torchesPlaced: torchesPlaced,
    };
  } catch (error) {
    console.log(
      `[${bot.username}] ⚠️ Pathfinder mining failed: ${error.message}`,
    );

    const endPos = bot.entity.position.clone();
    const distanceTraveled = startPos.distanceTo(endPos);
    const finalDistance = endPos.distanceTo(targetPos);

    return {
      success: false,
      distanceTraveled: distanceTraveled,
      timeElapsed: ((Date.now() - startTime) / 1000).toFixed(1),
      reachedTarget: false,
      finalDistance: finalDistance,
      torchesPlaced: torchesPlaced,
      error: error.message,
    };
  } finally {
    // Stop torch placement interval
    clearInterval(torchCheckInterval);
    intervalStopped = true; // Set flag to stop interval callback

    // Stop pathfinder
    bot.pathfinder.setGoal(null);
  }
}

/**
 * Get the phase function for mining episodes
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} rcon - RCON connection
 * @param {Function} sharedBotRng - Shared random number generator
 * @param {*} coordinator - Bot coordinator instance
 * @param {number} iterationID - Iteration ID
 * @param {number} episodeNum - Episode number
 * @param {Object} episodeInstance - Episode instance
 * @param {Object} args - Configuration arguments
 * @param {Object} phaseDataOur - Phase data for this bot (contains position)
 * @returns {Function} Phase function
 */
function getOnMinePhaseFn(
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
  return async function onMinePhase(phaseDataOther) {
    coordinator.sendToOtherBot(
      `minePhase_${iterationID}`,
      phaseDataOur,
      episodeNum,
      `minePhase_${iterationID} beginning`,
    );

    console.log(`[${bot.username}] 🚀 Starting MINE2 phase ${iterationID}`);
    console.log(
      `[${bot.username}] 🎬 MINING EPISODE 2 (Pathfinder) - Episode ${episodeNum}, Iteration ${iterationID}`,
    );

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
        actualOtherBotPosition = phaseDataOther.position.clone();
      }
    } catch (lookError) {
      console.log(
        `[${bot.username}] ⚠️ Could not look at other bot: ${lookError.message}`,
      );
      actualOtherBotPosition = phaseDataOther.position.clone();
    }

    // STEP 3: Equip mining tool
    console.log(`[${bot.username}] ⛏️ STEP 3: Equipping mining tool...`);
    try {
      await ensureItemInHand(bot, TOOL_TYPE, args);
      console.log(`[${bot.username}] ✅ Equipped ${TOOL_TYPE}`);
    } catch (toolError) {
      console.log(
        `[${bot.username}] ⚠️ Could not equip tool: ${toolError.message}`,
      );
    }

    // STEP 4: Dig down to underground
    console.log(`[${bot.username}] ⬇️ STEP 4: Digging down to underground...`);
    const dugDown = await digDownToUnderground(bot, UNDERGROUND_DEPTH);
    if (!dugDown) {
      console.log(`[${bot.username}] ⚠️ Failed to dig down, aborting episode`);
      throw new Error("Failed to dig down to underground");
    }

    // STEP 5: Calculate midpoint between bots
    console.log(`[${bot.username}] 📐 STEP 5: Calculating midpoint...`);

    // Both bots dig down by UNDERGROUND_DEPTH, so calculate underground positions deterministically
    const myUndergroundPos = new Vec3(
      phaseDataOur.position.x,
      phaseDataOur.position.y - UNDERGROUND_DEPTH,
      phaseDataOur.position.z,
    );
    const otherUndergroundPos = new Vec3(
      phaseDataOther.position.x,
      phaseDataOther.position.y - UNDERGROUND_DEPTH,
      phaseDataOther.position.z,
    );

    const midpoint = new Vec3(
      Math.floor((myUndergroundPos.x + otherUndergroundPos.x) / 2),
      Math.floor(myUndergroundPos.y), // Underground Y level
      Math.floor((myUndergroundPos.z + otherUndergroundPos.z) / 2),
    );

    console.log(
      `[${bot.username}] 📍 My underground position: ${myUndergroundPos.x.toFixed(
        2,
      )}, ${myUndergroundPos.y.toFixed(2)}, ${myUndergroundPos.z.toFixed(2)}`,
    );
    console.log(
      `[${bot.username}] 📍 Other bot underground position: ${otherUndergroundPos.x.toFixed(
        2,
      )}, ${otherUndergroundPos.y.toFixed(2)}, ${otherUndergroundPos.z.toFixed(2)}`,
    );
    console.log(
      `[${bot.username}] 🎯 Midpoint: ${midpoint.x}, ${midpoint.y}, ${midpoint.z}`,
    );

    // Adjust target to be one block below ground level for tunnel digging
    const miningTarget = midpoint.offset(0, -1, 0);

    console.log(
      `[${bot.username}] 🎯 Mining target (1 block down): ${miningTarget.x}, ${miningTarget.y}, ${miningTarget.z}`,
    );

    // STEP 6: Mine towards the midpoint using pathfinder
    console.log(
      `[${bot.username}] 🚇 STEP 6: Mining towards target using pathfinder...`,
    );
    const miningResult = await mineTowardsTargetWithTorchPlacement(
      bot,
      miningTarget,
    );

    console.log(
      `[${bot.username}] ✅ Mining complete! Result: ${JSON.stringify(miningResult)}`,
    );

    // STEP 7: Final eye contact
    console.log(`[${bot.username}] 👀 STEP 7: Final eye contact...`);
    try {
      const otherEntity2 = bot.players[args.other_bot_name]?.entity;
      if (otherEntity2) {
        const targetPos = otherEntity2.position.offset(
          0,
          otherEntity2.height,
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

    console.log(`[${bot.username}] ✅ MINE2 phase complete!`);
    console.log(
      `[${bot.username}] 📊 Final stats: ${JSON.stringify(miningResult)}`,
    );

    // STEP 8: Transition to stop phase (end episode)
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
      `minePhase_${iterationID} end`,
    );

    return miningResult;
  };
}

/**
 * Episode where both bots dig down, then mine toward a shared midpoint using pathfinder with
 * torch placement. Uses diamond pickaxe and pathfinder-based navigation.
 * @extends BaseEpisode
 */
class MineEpisode extends BaseEpisode {
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
    console.log(`[${bot.username}] 🔧 Setting up Mine Episode 2 (Pathfinder)`);

    // Give torches for illumination during mining
    console.log(`[${bot.username}] 🔦 Giving torches for mining...`);
    await rcon.send(`give ${bot.username} ${TORCH_TYPE} 64`);
    await sleep(500);
    console.log(`[${bot.username}] ✅ Gave 64 torches`);

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
      `minePhase_${iterationID}`,
      episodeNum,
      getOnMinePhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        iterationID,
        episodeNum,
        this,
        args,
        phaseDataOur,
      ),
    );
    coordinator.sendToOtherBot(
      `minePhase_${iterationID}`,
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
    console.log(`[${bot.username}] 🧹 Tearing down Mine Episode 2`);
    // Unequip pickaxe from main hand
    await unequipHand(bot);
  }
}

module.exports = { MineEpisode };
