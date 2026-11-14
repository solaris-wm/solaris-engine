const Vec3 = require("vec3").Vec3;

const { GoalNear } = require("../utils/bot-factory");
const {
  lookAtBot,
  sleep,
  initializePathfinder,
  stopPathfinder,
  land_pos,
} = require("../primitives/movement");
const { BaseEpisode } = require("./base-episode");

// Constants for orbit behavior
const NUM_CHECKPOINTS = 8; // Number of checkpoints around the circle
const CHECKPOINT_REACH_DISTANCE = 1.5; // How close to get to checkpoint (blocks)
const CHECKPOINT_TIMEOUT_MS = 5000; // Maximum time to reach each checkpoint (5 seconds)
const EYE_CONTACT_DURATION_MS = 1000; // How long to look at partner at each checkpoint
const CAMERA_SPEED_DEGREES_PER_SEC = 90; // Camera rotation speed

/**
 * Calculate checkpoint positions around a circle
 * @param {Vec3} center - Center point of the circle
 * @param {number} radius - Radius of the circle
 * @param {number} numCheckpoints - Number of checkpoints to generate
 * @param {number} startAngle - Starting angle in radians (for bot's initial position)
 * @returns {Array<Vec3>} Array of checkpoint positions
 */
function calculateOrbitCheckpoints(
  center,
  radius,
  numCheckpoints,
  startAngle = 0,
) {
  const checkpoints = [];
  const angleStep = (2 * Math.PI) / numCheckpoints;

  for (let i = 0; i < numCheckpoints; i++) {
    const angle = startAngle + i * angleStep;
    const x = center.x + radius * Math.cos(angle);
    const z = center.z + radius * Math.sin(angle);
    checkpoints.push(new Vec3(x, center.y, z));
  }

  return checkpoints;
}

/**
 * Execute orbit by traveling to checkpoints in sequence
 * @param {*} bot - Mineflayer bot instance
 * @param {string} otherBotName - Name of the other bot
 * @param {Array<Vec3>} checkpoints - Array of checkpoint positions
 * @param {Object} rcon - RCON connection for chunk loading
 */
async function executeOrbitWithCheckpoints(
  bot,
  otherBotName,
  checkpoints,
  rcon,
) {
  console.log(
    `[${bot.username}] Starting orbit with ${checkpoints.length} checkpoints`,
  );

  // Initialize pathfinder with full capabilities
  initializePathfinder(bot, {
    allowSprinting: true, // Sprint for faster movement between checkpoints
    allowParkour: true,
    canDig: true,
    canPlaceOn: true,
    allowEntityDetection: true,
  });

  for (let i = 0; i < checkpoints.length; i++) {
    const checkpoint = checkpoints[i];

    // Get ground Y coordinate for checkpoint
    const groundPos = await land_pos(bot, rcon, checkpoint.x, checkpoint.z);
    const targetPos = groundPos || checkpoint;

    console.log(
      `[${bot.username}] 📍 Checkpoint ${i + 1}/${checkpoints.length}: ` +
        `(${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)})`,
    );
    console.log(
      `[${bot.username}] 📊 Current position: ` +
        `(${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`,
    );
    console.log(
      `[${bot.username}] 📏 Distance to checkpoint: ${bot.entity.position.distanceTo(targetPos).toFixed(2)} blocks`,
    );

    // Check pathfinder state before setting goal
    console.log(
      `[${bot.username}] 🔍 Pathfinder state BEFORE: isMoving=${bot.pathfinder.isMoving()}, goal=${bot.pathfinder.goal ? "SET" : "NULL"}`,
    );

    // Set pathfinder goal to checkpoint
    console.log(
      `[${bot.username}] 🚀 Starting pathfinder to checkpoint ${i + 1}`,
    );
    const goal = new GoalNear(
      targetPos.x,
      targetPos.y,
      targetPos.z,
      CHECKPOINT_REACH_DISTANCE,
    );
    bot.pathfinder.setGoal(goal);

    // Verify goal was set
    await sleep(200); // Give pathfinder time to process
    console.log(
      `[${bot.username}] 🔍 Pathfinder state AFTER: isMoving=${bot.pathfinder.isMoving()}, goal=${bot.pathfinder.goal ? "SET" : "NULL"}`,
    );

    // Wait until bot reaches checkpoint or timeout
    let reached = false;
    let timedOut = false;
    let checkCount = 0;
    const checkpointStartTime = Date.now();

    while (!reached && !timedOut) {
      const distance = bot.entity.position.distanceTo(targetPos);
      const elapsed = Date.now() - checkpointStartTime;

      // Log every 2 seconds (20 checks)
      if (checkCount % 20 === 0) {
        console.log(
          `[${bot.username}] 🔄 Moving to checkpoint ${i + 1}: distance=${distance.toFixed(2)}, ` +
            `isMoving=${bot.pathfinder.isMoving()}, pos=(${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.z.toFixed(1)}), ` +
            `elapsed=${(elapsed / 1000).toFixed(1)}s`,
        );
      }

      if (distance <= CHECKPOINT_REACH_DISTANCE) {
        reached = true;
        console.log(
          `[${bot.username}] ✅ Reached checkpoint ${i + 1} in ${(elapsed / 1000).toFixed(1)}s`,
        );
        break; // Exit immediately when reached
      } else if (elapsed > CHECKPOINT_TIMEOUT_MS) {
        timedOut = true;
        console.log(
          `[${bot.username}] ⏰ Timeout at checkpoint ${i + 1} after ${(elapsed / 1000).toFixed(1)}s ` +
            `(distance: ${distance.toFixed(2)} blocks, target: ${CHECKPOINT_REACH_DISTANCE} blocks)`,
        );
        break; // Exit immediately on timeout
      }

      checkCount++;
      await sleep(100); // Check every 100ms
    }

    // Stop movement at checkpoint (but keep pathfinder active for next checkpoint)
    console.log(
      `[${bot.username}] 🛑 Stopping movement at checkpoint ${i + 1}`,
    );
    bot.pathfinder.setGoal(null); // Clear current goal
    console.log(
      `[${bot.username}] 🔍 Goal cleared: goal=${bot.pathfinder.goal ? "STILL SET" : "NULL"}`,
    );

    // Manually stop control states (don't use stopAll which calls pathfinder.stop())
    bot.setControlState("forward", false);
    bot.setControlState("back", false);
    bot.setControlState("left", false);
    bot.setControlState("right", false);
    bot.setControlState("sprint", false);

    // Look at other bot
    console.log(`[${bot.username}] 👀 Looking at ${otherBotName}`);
    await lookAtBot(bot, otherBotName, CAMERA_SPEED_DEGREES_PER_SEC);

    // Hold eye contact
    console.log(
      `[${bot.username}] ⏸️ Holding eye contact for ${EYE_CONTACT_DURATION_MS}ms`,
    );
    await sleep(EYE_CONTACT_DURATION_MS);

    console.log(
      `[${bot.username}] ✅ Checkpoint ${i + 1} complete, continuing to next...`,
    );
  }

  // Clean up pathfinder after all checkpoints
  stopPathfinder(bot);

  console.log(
    `[${bot.username}] ✅ Orbit complete! Visited all ${checkpoints.length} checkpoints`,
  );
}

/**
 * Get orbit phase handler function
 */
function getOnOrbitPhaseFn(
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
  return async (peerMap) => {
    const peerData = peerMap.values().next().value;
    const otherBotName = coordinator.getSinglePeerName();
    const startTime = Date.now();
    console.log(
      `[${bot.username}] 🌀 ORBIT EPISODE STARTING - Episode ${episodeNum}, Iteration ${iterationID}`,
    );

    coordinator.broadcastToPeers(
      `orbitPhase_${iterationID}`,
      phaseDataOur,
      episodeNum,
      `orbitPhase_${iterationID} beginning`,
    );

    // Step 1: Calculate shared midpoint between both bots
    const myPosition = phaseDataOur.position;
    const otherPosition = peerData.position;

    const sharedMidpoint = new Vec3(
      (myPosition.x + otherPosition.x) / 2,
      (myPosition.y + otherPosition.y) / 2,
      (myPosition.z + otherPosition.z) / 2,
    );

    console.log(
      `[${bot.username}] 📍 Shared midpoint: (${sharedMidpoint.x.toFixed(1)}, ` +
        `${sharedMidpoint.y.toFixed(1)}, ${sharedMidpoint.z.toFixed(1)})`,
    );

    // Step 2: Calculate orbit radius (half the distance between bots)
    const distanceBetweenBots = myPosition.distanceTo(otherPosition);
    const orbitRadius = distanceBetweenBots / 2;

    console.log(
      `[${bot.username}] 📏 Distance between bots: ${distanceBetweenBots.toFixed(2)} blocks`,
    );
    console.log(
      `[${bot.username}] ⭕ Orbit radius: ${orbitRadius.toFixed(2)} blocks`,
    );

    // Step 3: Calculate starting angle based on bot's current position
    const dx = myPosition.x - sharedMidpoint.x;
    const dz = myPosition.z - sharedMidpoint.z;
    const startAngle = Math.atan2(dz, dx);

    console.log(
      `[${bot.username}] 🎯 Starting angle: ${((startAngle * 180) / Math.PI).toFixed(1)}°`,
    );

    // Step 4: Generate checkpoint coordinates around the circle
    const checkpoints = calculateOrbitCheckpoints(
      sharedMidpoint,
      orbitRadius,
      NUM_CHECKPOINTS,
      startAngle,
    );

    console.log(
      `[${bot.username}] 📋 Generated ${checkpoints.length} checkpoints for orbit path`,
    );

    // Step 5 & 6: Execute orbit by traveling to checkpoints
    await executeOrbitWithCheckpoints(bot, otherBotName, checkpoints, rcon);

    // Transition to stop phase
    console.log(`[${bot.username}] Transitioning to stop phase...`);
    coordinator.exchangeWithPeers(
      "stopPhase",
      phaseDataOur,
      episodeNum,
      episodeInstance.getOnStopPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        args,
      ),
      { location: `orbitPhase_${iterationID} end` },
    );

    const duration = (Date.now() - startTime) / 1000;
    console.log(
      `[${bot.username}] Orbit phase complete in ${duration.toFixed(1)}s`,
    );
  };
}

/**
 * Episode where both bots orbit around their shared midpoint, visiting checkpoints and making
 * eye contact at each. Orbit radius is half the distance between bots.
 * @extends BaseEpisode
 */
class OrbitEpisode extends BaseEpisode {
  static WORKS_IN_NON_FLAT_WORLD = true;

  async setupEpisode(
    bot,
    rcon,
    sharedBotRng,
    coordinator,
    episodeNum,
    args,
    botPosition,
    peerPositionsMap,
  ) {
    console.log(`[${bot.username}] 🌀 Setting up orbit episode`);
    return peerPositionsMap.values().next().value;
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

    coordinator.exchangeWithPeers(
      `orbitPhase_${iterationID}`,
      phaseDataOur,
      episodeNum,
      getOnOrbitPhaseFn(
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
      { location: "teleportPhase end" },
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
    console.log(`[${bot.username}] 🧹 Cleaning up orbit episode`);
    stopPathfinder(bot);
    bot.setControlState("forward", false);
    bot.setControlState("back", false);
    bot.setControlState("left", false);
    bot.setControlState("right", false);
    bot.setControlState("sprint", false);
  }
}

module.exports = { OrbitEpisode };
