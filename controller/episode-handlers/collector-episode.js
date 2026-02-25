const {
  Movements,
  GoalNear,
  GoalBlock,
  GoalFollow,
} = require("../utils/bot-factory");
const { placeTorch, findVisibleOres } = require("../primitives/digging");
const { ensureBotHasEnough, unequipHand } = require("../primitives/items");
const {
  stopAll,
  lookAtBot,
  sleep,
  land_pos,
  getScaffoldingBlockIds,
} = require("../primitives/movement");
const { getRandomDirection } = require("../primitives/random-movement");
const { BaseEpisode } = require("./base-episode");

// Constants for collector behavior
const MEETUP_TIMEOUT_MS = 4000; // 15 seconds to meet up
const LEADER_FOLLOWER_PROBABILITY = 3 / 3; // 100% chance of leader-follower mode
const FOLLOWER_NEAR_DISTANCE = 2; // Distance to maintain while following
const FOLLOWER_FAR_DISTANCE = 6; // Distance before resuming following
const RANDOM_MOTION_TIMEOUT_MS = 10000; // Stop task after 8 seconds
const ORE_MINING_TIMEOUT_MS = 8000; // Wait 8 seconds to mine an ore
const TASK_CHECK_INTERVAL_MS = 500; // Check task status every 500ms
const MAX_ORES_TO_MINE = 8; // Maximum ores to mine per cycle
const MAX_TORCH_DISTANCE = 2; // Maximum distance to place torch
const MAX_MINING_CYCLES = 10; // Maximum number of mining cycles before stopping

// Valuable ore types (by block name)
const VALUABLE_ORES = [
  "diamond_ore",
  "deepslate_diamond_ore",
  "emerald_ore",
  "deepslate_emerald_ore",
  "gold_ore",
  "deepslate_gold_ore",
  "iron_ore",
  "deepslate_iron_ore",
  "lapis_ore",
  "deepslate_lapis_ore",
  "redstone_ore",
  "deepslate_redstone_ore",
  "coal_ore",
  "deepslate_coal_ore",
  "copper_ore",
  "deepslate_copper_ore",
];

// ============================================================================
// SYNCHRONIZATION PRIMITIVES
// ============================================================================

/**
 * Determine if this bot should take a specific role
 * Both bots call this with same RNG, but get different results based on bot name
 * This ensures symmetric RNG consumption while enabling role assignment
 *
 * @param {*} bot - Mineflayer bot instance
 * @param {Function} sharedBotRng - Shared RNG function
 * @param {Object} args - Episode arguments
 * @returns {boolean} True if this bot should be the "primary" for this decision
 */
function isMyTurn(bot, sharedBotRng, args) {
  // Both bots consume the RNG
  const randomValue = sharedBotRng();

  // Determine role based on bot name (deterministic given same random value)
  const botNames = [bot.username, args.other_bot_name].sort();
  const myIndex = botNames.indexOf(bot.username);

  // If random < 0.5, first bot in sorted order is primary
  return randomValue < 0.5 === (myIndex === 0);
}

// ============================================================================
// PATHFINDING AND MINING UTILITIES
// ============================================================================

/**
 * Configure pathfinder movements for collector episode
 * @param {*} bot - Mineflayer bot instance
 */
function setMovementsForCollector(bot) {
  const mcData = require("minecraft-data")(bot.version);
  const customMoves = new Movements(bot, mcData);
  customMoves.allow1by1towers = true;
  customMoves.allowParkour = true;
  customMoves.allowDigging = true;
  customMoves.allowSprinting = false;
  customMoves.canPlaceOn = true;
  customMoves.blocksToAvoid.add(bot.registry.blocksByName.water.id);
  customMoves.blocksToAvoid.add(bot.registry.blocksByName.lava.id);
  customMoves.blocksToAvoid.add(bot.registry.blocksByName.bedrock.id);
  customMoves.scafoldingBlocks = getScaffoldingBlockIds(mcData);
  customMoves.infiniteLiquidDropdownDistance = true;
  customMoves.maxDropDown = 15;
  bot.pathfinder.setMovements(customMoves);
}

/**
 * Get next task specification with repeat tracking
 * @param {string} botUsername - Bot username for logging
 * @param {Object|null} lastTaskSpec - Last task specification (or null)
 * @param {number} taskRepeatCount - Current repeat count (0, 1, or 2)
 * @returns {Object} Object with taskSpec and newRepeatCount
 */
function getNextTaskSpec(botUsername, lastTaskSpec, taskRepeatCount) {
  let taskSpec;
  let newRepeatCount;

  // Check if we need to repeat the last task
  if (lastTaskSpec && taskRepeatCount === 1) {
    // Repeat the last task (second execution)
    taskSpec = lastTaskSpec;
    newRepeatCount = 2;
    console.log(
      `[${botUsername}] Task 2/2: ${taskSpec.type} ${taskSpec.direction.name} (repeat)`,
    );
  } else {
    // Create new random task specification (first execution)
    const taskType = Math.random() < 0.6 ? "directional" : "staircase";
    const direction = getRandomDirection();
    const distance =
      taskType === "directional"
        ? Math.floor(Math.random() * 4) + 5
        : Math.floor(Math.random() * 4) + 5;

    taskSpec = { type: taskType, direction: direction, distance: distance };
    newRepeatCount = 1;
    console.log(
      `[${botUsername}] Task 1/2: ${taskSpec.type} ${taskSpec.direction.name}`,
    );
  }

  return { taskSpec, newRepeatCount };
}

/**
 * Perform directional mining
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} direction - Direction object with offset
 * @param {number} distance - Distance to mine
 */
function performDirectionalMining(bot, direction, distance) {
  console.log(
    `[${bot.username}] Directional mining: ${direction.name}, distance ${distance}`,
  );

  const startPos = bot.entity.position;
  const targetPos = startPos.plus(direction.offset.scaled(distance));

  // Set pathfinding goal
  bot.pathfinder.setGoal(
    new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1),
  );
}

/**
 * Perform staircase mining (45 degrees down)
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} direction - Direction object with offset
 * @param {number} depth - Depth to mine
 */
function performStaircaseMining(bot, direction, depth) {
  console.log(
    `[${bot.username}] Staircase mining: ${direction.name}, depth ${depth}`,
  );

  const startPos = bot.entity.position;
  const targetY = Math.max(startPos.y - depth, 5); // Go down by depth, but not below y=5
  const horizontalDistance = depth; // Same distance horizontally as vertically
  const targetX = startPos.x + direction.offset.x * horizontalDistance;
  const targetZ = startPos.z + direction.offset.z * horizontalDistance;

  // Set pathfinding goal
  bot.pathfinder.setGoal(new GoalNear(targetX, targetY, targetZ, 1));
}

/**
 * Execute a single mining task (collect ores, then directional/staircase mining)
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} mcData - Minecraft data
 * @param {Array} oreIds - Array of ore block IDs
 * @param {Object} taskSpec - Task specification {type, direction, distance}
 * @returns {Promise} Promise that resolves when task completes
 */
async function executeMiningTask(bot, mcData, oreIds, taskSpec) {
  console.log(
    `[${bot.username}] Executing task: ${taskSpec.type} ${taskSpec.direction.name}`,
  );

  // Place torch before mining
  await placeTorch(bot, mcData, oreIds, MAX_TORCH_DISTANCE, 2400);

  // Collect visible ores
  const visibleOres = findVisibleOres(bot, oreIds);
  if (visibleOres.length > 0) {
    const maxOresToMine = Math.min(visibleOres.length, MAX_ORES_TO_MINE);
    console.log(`[${bot.username}] Collecting ${maxOresToMine} visible ores`);

    for (let i = 0; i < maxOresToMine; i++) {
      const ore = visibleOres[i];
      console.log(
        `[${bot.username}] Mining ${ore.name} at (${ore.position.x.toFixed(
          1,
        )}, ${ore.position.y.toFixed(1)}, ${ore.position.z.toFixed(1)})`,
      );

      bot.pathfinder.setGoal(
        new GoalBlock(ore.position.x, ore.position.y, ore.position.z),
      );

      // Wait for goal_reached or timeout
      await Promise.race([
        new Promise((resolve) => bot.once("goal_reached", resolve)),
        sleep(ORE_MINING_TIMEOUT_MS),
      ]);

      bot.pathfinder.setGoal(null);
    }
  }

  // Execute the main task based on specification
  if (taskSpec.type === "directional") {
    performDirectionalMining(bot, taskSpec.direction, taskSpec.distance);
  } else {
    performStaircaseMining(bot, taskSpec.direction, taskSpec.distance);
  }

  // Wait for goal_reached or timeout
  const taskStartTime = Date.now();
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (Date.now() - taskStartTime > RANDOM_MOTION_TIMEOUT_MS) {
        clearInterval(checkInterval);
        bot.pathfinder.setGoal(null);
        console.log(`[${bot.username}] Random motion timeout reached`);
        resolve();
      }
    }, TASK_CHECK_INTERVAL_MS);

    bot.once("goal_reached", () => {
      clearInterval(checkInterval);
      console.log(`[${bot.username}] Random motion goal reached`);
      resolve();
    });
  });
}

/**
 * Mine as leader - performs mining tasks with repetition tracking
 * @param {*} bot - Mineflayer bot instance
 * @param {*} coordinator - Bot coordinator
 * @param {Object} mcData - Minecraft data
 * @param {Array} oreIds - Array of ore block IDs
 * @param {number} episodeNum - Episode number
 * @param {number} iterationID - Iteration ID
 * @returns {Promise} Promise that resolves when mining completes
 */
async function mineAsLeader(
  bot,
  coordinator,
  mcData,
  oreIds,
  episodeNum,
  iterationID,
) {
  console.log(`[${bot.username}] Starting leader mining mode`);

  // Initialize pathfinder
  setMovementsForCollector(bot);

  let lastTaskSpec = null;
  let taskRepeatCount = 0;

  while (taskRepeatCount < 2) {
    // Get next task specification
    const { taskSpec, newRepeatCount } = getNextTaskSpec(
      bot.username,
      lastTaskSpec,
      taskRepeatCount,
    );
    lastTaskSpec = taskSpec;
    taskRepeatCount = newRepeatCount;

    // Execute the mining task
    await executeMiningTask(bot, mcData, oreIds, taskSpec);

    // Small tick wait between tasks
    await bot.waitForTicks(10);
  }

  console.log(`[${bot.username}] Leader mining complete - 2 repetitions done`);
  bot.pathfinder.setGoal(null);
}

/**
 * Follow leader and place torches
 * @param {*} bot - Mineflayer bot instance (follower)
 * @param {string} leaderName - Name of the leader bot
 * @param {Object} mcData - Minecraft data
 * @param {Array} oreIds - Array of ore block IDs
 * @param {Function} isLeaderDone - Function that returns true when leader is done
 * @returns {Promise} Promise that resolves when following completes
 */
async function followAndPlaceTorches(
  bot,
  leaderName,
  mcData,
  oreIds,
  isLeaderDone,
) {
  console.log(
    `[${bot.username}] Starting follower mode - following ${leaderName}`,
  );

  setMovementsForCollector(bot);

  let lastTorchPlaceTime = Date.now();
  const startTick = bot.time.age;
  const MIN_TORCH_INTERVAL = 5000; // Place torch at most every 5 seconds
  const FOLLOWER_TIMEOUT_TICKS = 20 * (64 + 10); // Stop follower after 77s, 64s for leader to mine Ores and 10s for to do motion mining

  // Continuous following with dynamic torch placement
  // Continue until leader signals completion
  const leaderBot = bot.players[leaderName];
  // dynamic goal to follow leader
  bot.pathfinder.setGoal(
    new GoalFollow(leaderBot.entity, FOLLOWER_NEAR_DISTANCE),
    true,
  );
  while (!isLeaderDone()) {
    // Place torch periodically while following
    const now = Date.now();
    if (!isLeaderDone() && now - lastTorchPlaceTime > MIN_TORCH_INTERVAL) {
      // Stop to place torch, for up to 2.4 seconds or until leader is done
      bot.pathfinder.setGoal(null);
      await placeTorch(bot, mcData, oreIds, 2400, () => isLeaderDone());
      lastTorchPlaceTime = now;
      await bot.lookAt(
        leaderBot.entity.position.offset(0, leaderBot.entity.height, 0),
      );
      bot.pathfinder.setGoal(
        new GoalFollow(leaderBot.entity, FOLLOWER_NEAR_DISTANCE),
        true,
      );
      // Check if leader finished while placing torch
      if (isLeaderDone()) {
        break;
      }
      if (bot.time.age - startTick > FOLLOWER_TIMEOUT_TICKS) {
        console.log(
          `[${bot.username}] Follower mining timed out after ${FOLLOWER_TIMEOUT_TICKS} ticks`,
        );
        break;
      }
    }
    // Small tick wait to prevent busy loop
    await bot.waitForTicks(5);
  }

  console.log(
    `[${bot.username}] Leader finished mining, follower mode complete`,
  );
  bot.pathfinder.setGoal(null);
}

/**
 * Mine independently (both bots mine separately)
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} mcData - Minecraft data
 * @param {Array} oreIds - Array of ore block IDs
 * @returns {Promise} Promise that resolves when mining completes
 */
async function independentMining(bot, mcData, oreIds) {
  console.log(`[${bot.username}] Starting independent mining mode`);

  // Initialize pathfinder
  setMovementsForCollector(bot);

  let lastTaskSpec = null;
  let taskRepeatCount = 0;

  while (taskRepeatCount < 2) {
    // Get next task specification
    const { taskSpec, newRepeatCount } = getNextTaskSpec(
      bot.username,
      lastTaskSpec,
      taskRepeatCount,
    );
    lastTaskSpec = taskSpec;
    taskRepeatCount = newRepeatCount;

    // Execute the mining task
    await executeMiningTask(bot, mcData, oreIds, taskSpec);

    // Small tick wait between tasks
    await bot.waitForTicks(10);
  }

  console.log(
    `[${bot.username}] Independent mining complete - 2 repetitions done`,
  );
  bot.pathfinder.setGoal(null);
}

/**
 * Mining phase - both bots mine for ores
 * This is completely symmetric - both bots execute the same code and consume RNG equally
 * The mode (leader-follower vs independent) is decided using shared RNG
 *
 * @param {*} bot - Mineflayer bot instance
 * @param {*} coordinator - Bot coordinator
 * @param {Function} sharedBotRng - Shared RNG function
 * @param {string} otherBotName - Name of the other bot
 * @param {number} episodeNum - Episode number
 * @param {number} cycle - Current cycle number
 * @param {Object} args - Episode arguments
 */
async function miningPhase(
  bot,
  coordinator,
  sharedBotRng,
  otherBotName,
  episodeNum,
  cycle,
  args,
) {
  console.log(`[${bot.username}] MINING PHASE`);

  // Get minecraft data and ore IDs
  const mcData = require("minecraft-data")(bot.version);
  const oreIds = VALUABLE_ORES.map(
    (oreName) => mcData.blocksByName[oreName]?.id,
  ).filter((id) => id !== undefined);

  // SYMMETRIC RNG CONSUMPTION: Both bots decide mode together
  const isLeaderFollowerMode = sharedBotRng() < LEADER_FOLLOWER_PROBABILITY;
  console.log(
    `[${bot.username}] Mode: ${
      isLeaderFollowerMode ? "LEADER-FOLLOWER" : "INDEPENDENT"
    }`,
  );

  if (isLeaderFollowerMode) {
    // SYMMETRIC RNG CONSUMPTION: Both bots determine roles together
    // but get different results based on bot name
    const isLeader = isMyTurn(bot, sharedBotRng, args);
    console.log(`[${bot.username}] Role: ${isLeader ? "LEADER" : "FOLLOWER"}`);

    if (isLeader) {
      // Mine as leader
      const startTick = bot.time.age;
      await mineAsLeader(bot, coordinator, mcData, oreIds, episodeNum, cycle);

      // Wait a bit before sending "done" to follower to ensure listener is set up
      if (bot.time.age - startTick < 40) {
        console.log(
          `[${bot.username}] Leader mining took less than 40 ticks, waiting for remaining ticks`,
        );
        await bot.waitForTicks(40 - (bot.time.age - startTick));
      }
      // Signal completion to follower
      coordinator.sendToOtherBot(
        `done_${cycle}`,
        bot.entity.position.clone(),
        episodeNum,
        "leader_done",
      );
    } else {
      // Set up listener for leader done signal
      let leaderDone = false;
      coordinator.onceEvent(`done_${cycle}`, episodeNum, () => {
        console.log(`[${bot.username}] Leader signaled completion`);
        leaderDone = true;
      });

      // Follow and place torches
      await followAndPlaceTorches(
        bot,
        otherBotName,
        mcData,
        oreIds,
        () => leaderDone,
      );
    }
  } else {
    // Independent mining mode
    await independentMining(bot, mcData, oreIds);
  }

  console.log(`[${bot.username}] Mining phase complete`);
}

/**
 * Get the phase function for a specific cycle
 * This follows the coordinator pattern: set up listener, then send message
 *
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} rcon - RCON instance
 * @param {Function} sharedBotRng - Shared RNG function
 * @param {*} coordinator - Bot coordinator
 * @param {number} cycle - Current cycle number
 * @param {number} episodeNum - Episode number
 * @param {CollectorEpisode} episodeInstance - Episode instance
 * @param {Object} args - Episode arguments
 * @returns {Function} Phase function for this cycle
 */
function getCyclePhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  cycle,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (otherBotPosition) => {
    console.log(`[${bot.username}] ========================================`);
    console.log(`[${bot.username}] Cycle ${cycle}/${MAX_MINING_CYCLES}`);
    console.log(`[${bot.username}] ========================================`);

    // Send acknowledgment
    coordinator.sendToOtherBot(
      `cycle_${cycle}`,
      bot.entity.position.clone(),
      episodeNum,
      `cycle_${cycle} beginning`,
    );

    // Mining phase
    await miningPhase(
      bot,
      coordinator,
      sharedBotRng,
      args.other_bot_name,
      episodeNum,
      cycle,
      args,
    );

    // Set up next phase
    if (cycle < MAX_MINING_CYCLES) {
      const nextCycle = cycle + 1;
      coordinator.onceEvent(
        `cycle_${nextCycle}`,
        episodeNum,
        getCyclePhaseFn(
          bot,
          rcon,
          sharedBotRng,
          coordinator,
          nextCycle,
          episodeNum,
          episodeInstance,
          args,
        ),
      );
      coordinator.sendToOtherBot(
        `cycle_${nextCycle}`,
        bot.entity.position.clone(),
        episodeNum,
        `cycle_${cycle} end`,
      );
    } else {
      // Last cycle, set up stop phase
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
        `cycle_${cycle} end`,
      );

      console.log(`[${bot.username}] ========================================`);
      console.log(`[${bot.username}] COLLECTOR EPISODE COMPLETE`);
      console.log(
        `[${bot.username}] Completed ${MAX_MINING_CYCLES} cycles successfully`,
      );
      console.log(`[${bot.username}] ========================================`);
    }
  };
}

/**
 * Episode where both bots perform mining cycles (leader-follower or independent). Leader-follower
 * mode has one bot mine while the other follows and places torches; mode and roles use shared RNG.
 * @extends BaseEpisode
 */
class CollectorEpisode extends BaseEpisode {
  static WORKS_IN_NON_FLAT_WORLD = true;
  static INIT_MIN_BOTS_DISTANCE = 0;

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
    await ensureBotHasEnough(bot, rcon, "torch", 128);
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
    console.log(`[${bot.username}] ========================================`);
    console.log(
      `[${bot.username}] COLLECTOR EPISODE START - Episode ${episodeNum}`,
    );
    console.log(`[${bot.username}] ========================================`);

    // Set up listener for first cycle, then send message to start
    // This follows the coordinator pattern from coordinator_readme.md
    coordinator.onceEvent(
      `cycle_1`,
      episodeNum,
      getCyclePhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        1, // cycle number
        episodeNum,
        this,
        args,
      ),
    );
    coordinator.sendToOtherBot(
      `cycle_1`,
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
    console.log(`[${bot.username}] Tearing down collector episode`);
    // Stop pathfinder and clear any remaining goals
    if (bot.pathfinder) {
      bot.pathfinder.setGoal(null);
    }
    stopAll(bot);
  }
}

module.exports = { CollectorEpisode };
