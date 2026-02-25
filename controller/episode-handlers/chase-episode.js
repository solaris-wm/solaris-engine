const { horizontalDistanceTo, initializePathfinder, lookAtBot, sleep, stopAll, stopPathfinder } = require("../primitives/movement");
const { GoalNear } = require("../utils/bot-factory");
const { decidePrimaryBot } = require("../utils/coordination");
const { BaseEpisode } = require("./base-episode");

// Constants for chase behavior
const CHASE_DURATION_MS_MIN = 5000; // 5 seconds of chase
const CHASE_DURATION_MS_MAX = 15000; // 15 seconds of chase
const POSITION_UPDATE_INTERVAL_MS = 500; // Update positions every 500ms
const MIN_CHASE_DISTANCE = 3.0; // Minimum distance to maintain chase
const ESCAPE_DISTANCE = 8.0; // Distance at which runner changes direction
const DIRECTION_CHANGE_INTERVAL = 4000; // Change direction every 4 seconds
const CAMERA_SPEED = 90; // Camera movement speed (degrees per second)

/**
 * Chaser behavior - uses pure pathfinder for intelligent AI movement
 * @param {*} bot - Mineflayer bot instance (chaser)
 * @param {*} coordinator - Bot coordinator instance
 * @param {string} otherBotName - Name of the runner bot
 * @param {number} chaseDurationMs - Duration to chase in milliseconds
 */
async function chaseRunner(
  bot,
  coordinator,
  otherBotName,
  episodeNum,
  chaseDurationMs,
) {
  console.log(
    `[${
      bot.username
    }] 🏃 Starting PURE pathfinder chase of ${otherBotName} for ${
      chaseDurationMs / 1000
    }s`,
  );

  initializePathfinder(bot, {
    allowSprinting: true,
    allowParkour: true,
    canDig: true,
    allowEntityDetection: true,
  });
  console.log(
    `[${bot.username}] ✅ Pure pathfinder movements configured for intelligent chase`,
  );

  const startTime = Date.now();
  let lastCameraUpdate = 0;
  let lastGoalUpdate = 0;

  // Set up position request handler for coordination

  try {
    while (Date.now() - startTime < chaseDurationMs) {
      // Get runner's current position
      const runnerBot = bot.players[otherBotName];
      if (runnerBot && runnerBot.entity) {
        const targetPos = runnerBot.entity.position;
        const currentPos = bot.entity.position;
        const distance = horizontalDistanceTo(currentPos, targetPos);

        console.log(
          `[${
            bot.username
          }] 🎯 CHASING: distance to ${otherBotName} = ${distance.toFixed(
            2,
          )} blocks`,
        );

        // Update camera to look at runner periodically
        const now = Date.now();
        if (now - lastCameraUpdate > 2000) {
          // Update camera every 2 seconds
          await lookAtBot(bot, otherBotName, CAMERA_SPEED);
          lastCameraUpdate = now;
        }

        // Update pathfinder goal periodically like the GPS example
        if (now - lastGoalUpdate > 1000) {
          // Update goal every second
          if (distance > MIN_CHASE_DISTANCE) {
            console.log(
              `[${bot.username}] 🤖 Setting pure pathfinder goal for intelligent chase`,
            );

            // Use GoalNear like the GPS example - this is the correct way
            const { x: playerX, y: playerY, z: playerZ } = targetPos;
            bot.pathfinder.setGoal(
              new GoalNear(playerX, playerY, playerZ, MIN_CHASE_DISTANCE),
            );
            console.log(
              `[${
                bot.username
              }] ✅ Pure pathfinder GoalNear set to (${playerX.toFixed(
                1,
              )}, ${playerY.toFixed(1)}, ${playerZ.toFixed(1)})`,
            );
          } else {
            // Too close, stop pathfinder
            bot.pathfinder.setGoal(null);
            console.log(
              `[${bot.username}] 🛑 Too close to ${otherBotName}, stopping pathfinder`,
            );
          }
          lastGoalUpdate = now;
        }
      } else {
        console.log(
          `[${bot.username}] ❌ Cannot see ${otherBotName}, stopping chase`,
        );
        bot.pathfinder.setGoal(null);
        stopAll(bot);
      }

      await sleep(POSITION_UPDATE_INTERVAL_MS);
    }
  } finally {
    bot.pathfinder.setGoal(null); // Clear pathfinder goal
    stopAll(bot);
    console.log(`[${bot.username}] ✅ Pure pathfinder chase complete`);
  }
}
/**
 * Runner behavior - picks one fixed destination and pathfinds there
 * @param {*} bot - Mineflayer bot instance (runner)
 * @param {*} coordinator - Bot coordinator instance
 * @param {string} otherBotName - Name of the chaser bot
 * @param {number} chaseDurationMs - Duration to run in milliseconds
 */
async function runFromChaser(
  bot,
  coordinator,
  otherBotName,
  episodeNum,
  chaseDurationMs,
) {
  console.log(
    `[${bot.username}] 🏃‍♂️ Starting pathfinder escape from ${otherBotName} for ${
      chaseDurationMs / 1000
    }s`,
  );

  // Initialize pathfinder with full capabilities for running - can dig/place to escape
  initializePathfinder(bot, {
    allowSprinting: true,
    allowParkour: true,
    canDig: true, // Can break blocks to escape
    canPlaceOn: true, // Can place blocks to bridge/climb
    allowEntityDetection: true,
  });

  console.log(
    `[${bot.username}] ✅ Pathfinder initialized for escape with full capabilities`,
  );

  // Get chaser's initial position to calculate escape destination
  let chaserPos = null;
  const chaserBot = bot.players[otherBotName];
  if (chaserBot && chaserBot.entity) {
    chaserPos = chaserBot.entity.position;
  } else {
    // Fallback to bot's current position if chaser not visible
    chaserPos = bot.entity.position;
    console.log(
      `[${bot.username}] ⚠️ Cannot see ${otherBotName}, using own position as reference`,
    );
  }

  // Calculate deterministic escape destination: Alpha runs directly away from Bravo
  const currentPos = bot.entity.position; // A (Alpha's position)

  // Use Bravo's position as B, or fallback to current position
  const chaseOrCurrentPos = chaserPos || currentPos;

  // Compute direction d = normalize(A - B) to get direction away from Bravo
  const dx = currentPos.x - chaseOrCurrentPos.x; // A.x - B.x
  const dz = currentPos.z - chaseOrCurrentPos.z; // A.z - B.z (horizontal only, ignore Y)

  // Calculate horizontal distance for normalization
  const horizontalDistance = Math.sqrt(dx * dx + dz * dz);

  // Normalize direction vector (handle case where bots are at same position)
  let normalizedDx, normalizedDz;
  if (horizontalDistance > 0) {
    normalizedDx = dx / horizontalDistance;
    normalizedDz = dz / horizontalDistance;
  } else {
    // If bots are at same position, default to North direction
    normalizedDx = 0;
    normalizedDz = -1;
    console.log(
      `[${bot.username}] ⚠️ Bots at same position, defaulting to North direction`,
    );
  }

  // Calculate escape destination: C = A + 100 * d
  const escapeDistance = 100;
  const escapeX = currentPos.x + normalizedDx * escapeDistance;
  const escapeY = currentPos.y; // Keep same Y level
  const escapeZ = currentPos.z + normalizedDz * escapeDistance;

  console.log(
    `[${
      bot.username
    }] 🎯 Deterministic escape: Running directly away from ${otherBotName} to (${escapeX.toFixed(
      1,
    )}, ${escapeY.toFixed(1)}, ${escapeZ.toFixed(
      1,
    )}) - ${escapeDistance} blocks away`,
  );

  const startTime = Date.now();

  try {
    // Set the single escape goal using GoalNear
    bot.pathfinder.setGoal(new GoalNear(escapeX, escapeY, escapeZ, 2));
    console.log(
      `[${bot.username}] ✅ Single escape GoalNear set - will pathfind here for entire chase duration`,
    );

    while (Date.now() - startTime < chaseDurationMs) {
      // Just sleep and let pathfinder do its work
      await sleep(POSITION_UPDATE_INTERVAL_MS);
    }
  } finally {
    // Clean up pathfinder
    stopPathfinder(bot);
    console.log(`[${bot.username}] ✅ Pathfinder escape complete`);
  }
}

/**
 * Get chase phase handler function
 * @param {*} bot - Mineflayer bot instance
 * @param {Function} sharedBotRng - Shared random number generator
 * @param {*} coordinator - Bot coordinator instance
 * @param {number} iterationID - Iteration ID
 * @param {string} otherBotName - Other bot name
 * @param {number} episodeNum - Episode number
 * @param {Object} episodeInstance - Episode instance
 * @param {Object} args - Configuration arguments
 * @returns {Function} Chase phase handler
 */
function getOnChasePhaseFn(
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
      `chasePhase_${iterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      `chasePhase_${iterationID} beginning`,
    );

    console.log(
      `[${bot.username}] 🎬 Starting pathfinder-enhanced chase phase ${iterationID}`,
    );

    const isChaser = decidePrimaryBot(bot, sharedBotRng, args);

    console.log(
      `[${bot.username}] 🎭 I am the ${isChaser ? "🏃 CHASER" : "🏃‍♂️ RUNNER"}`,
    );

    const chaseDurationMs =
      CHASE_DURATION_MS_MIN +
      Math.floor(
        sharedBotRng() * (CHASE_DURATION_MS_MAX - CHASE_DURATION_MS_MIN + 1),
      );
    // Execute appropriate behavior using pathfinder-enhanced functions
    if (isChaser) {
      await chaseRunner(
        bot,
        coordinator,
        otherBotName,
        episodeNum,
        chaseDurationMs,
      );
    } else {
      await runFromChaser(
        bot,
        coordinator,
        otherBotName,
        episodeNum,
        chaseDurationMs,
      );
    }

    // Transition to stop phase
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
      `chasePhase_${iterationID} end`,
    );
  };
}

/**
 * Episode where one bot chases the other using pathfinder; roles (chaser/runner) are decided
 * by shared RNG. Chase duration is random within a range.
 * @extends BaseEpisode
 */
class ChaseEpisode extends BaseEpisode {
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
      `chasePhase_${iterationID}`,
      episodeNum,
      getOnChasePhaseFn(
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
      `chasePhase_${iterationID}`,
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

module.exports = { ChaseEpisode };
