const { equipSword, giveRandomSword } = require("../primitives/fighting");
const { unequipHand } = require("../primitives/items");
const { lookAtBot, sleep } = require("../primitives/movement");
const { BaseEpisode } = require("./base-episode");

// Constants for PVP behavior
const PVP_DURATION_MS_MIN = 10000; // 5 seconds of combat
const PVP_DURATION_MS_MAX = 15000; // 15 seconds of combat
const ATTACK_COOLDOWN_MS = 500; // 0.5s between attacks
const MELEE_RANGE = 3; // Attack range in blocks
const APPROACH_DISTANCE = 2; // Pathfinder target distance
const COMBAT_LOOP_INTERVAL_MS = 100; // Combat loop update rate
const MIN_SPAWN_DISTANCE = 8; // Minimum distance between bots at spawn
const MAX_SPAWN_DISTANCE = 15; // Maximum distance between bots at spawn
const INITIAL_EYE_CONTACT_MS = 500; // Initial look duration

/**
 * Main PVP combat loop using mineflayer-pvp plugin
 * @param {*} bot - Mineflayer bot instance
 * @param {string} targetBotName - Name of target bot
 * @param {number} durationMs - Combat duration in milliseconds
 */
async function pvpCombatLoop(bot, targetBotName, durationMs) {
  console.log(
    `[${bot.username}] ⚔️ Starting PVP combat loop (using pvp plugin) for ${durationMs / 1000}s`,
  );

  const startTime = Date.now();
  let totalAttacks = 0;
  let lastHealthLog = Date.now();

  // Track attacks using the playerHurt event
  const attackListener = (attacker, victim) => {
    if (attacker === bot.entity && victim.username === targetBotName) {
      totalAttacks++;
      console.log(
        `[${bot.username}] ⚔️ Attack #${totalAttacks} on ${targetBotName}`,
      );
    }
  };
  bot.on("playerHurt", attackListener);

  try {
    // Get target entity
    const targetEntity = bot.nearestEntity((entity) => {
      return entity.type === "player" && entity.username === targetBotName;
    });

    if (!targetEntity) {
      console.log(`[${bot.username}] ❌ Cannot find target ${targetBotName}`);
      return;
    }

    console.log(`[${bot.username}] 🎯 Target acquired: ${targetBotName}`);
    console.log(`[${bot.username}] 🤖 Starting pvp plugin attack...`);

    // Start PVP plugin attack - it handles pathfinding, following, and attacking
    bot.pvp.attack(targetEntity);

    // Monitor combat for the specified duration
    while (Date.now() - startTime < durationMs) {
      // Log health periodically
      if (Date.now() - lastHealthLog > 3000) {
        const distance = targetEntity.position
          ? bot.entity.position.distanceTo(targetEntity.position)
          : -1;
        console.log(
          `[${bot.username}] ❤️ Health: ${bot.health}/20 | Distance: ${distance.toFixed(2)} blocks`,
        );
        lastHealthLog = Date.now();
      }

      // Check if bot died (but continue episode)
      if (bot.health <= 0) {
        console.log(`[${bot.username}] 💀 Died in combat (continuing episode)`);
      }

      // Check if target is still valid
      if (!targetEntity.isValid) {
        console.log(`[${bot.username}] ⚠️ Target entity no longer valid`);
        break;
      }

      await sleep(COMBAT_LOOP_INTERVAL_MS);
    }
  } finally {
    // Stop PVP plugin
    bot.pvp.stop();
    console.log(`[${bot.username}] 🛑 Stopped pvp plugin`);

    // Remove attack listener
    bot.removeListener("playerHurt", attackListener);

    // Log combat statistics
    const duration = Date.now() - startTime;
    console.log(`[${bot.username}] 🏁 Combat complete! Stats:`);
    console.log(
      `[${bot.username}]    Duration: ${(duration / 1000).toFixed(1)}s`,
    );
    console.log(`[${bot.username}]    Total attacks detected: ${totalAttacks}`);
    console.log(`[${bot.username}]    Final health: ${bot.health}/20`);
    if (totalAttacks > 0) {
      console.log(
        `[${bot.username}]    Attacks per second: ${(
          totalAttacks /
          (duration / 1000)
        ).toFixed(2)}`,
      );
    }
  }
}

/**
 * Get PVP phase handler function
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} rcon - RCON connection
 * @param {Function} sharedBotRng - Shared random number generator
 * @param {*} coordinator - Bot coordinator instance
 * @param {number} iterationID - Iteration ID
 * @param {number} episodeNum - Episode number
 * @param {Object} episodeInstance - Episode instance
 * @param {Object} args - Configuration arguments
 * @returns {Function} PVP phase handler
 */
function getOnPvpPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  iterationID,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (otherBotPosition) => {
    const startTime = Date.now();
    console.log(
      `[${bot.username}] ⚔️ PVP EPISODE STARTING - Episode ${episodeNum}, Iteration ${iterationID}`,
    );
    console.log(
      `[${bot.username}] 🕐 Episode start time: ${new Date(
        startTime,
      ).toISOString()}`,
    );

    coordinator.sendToOtherBot(
      `pvpPhase_${iterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      `pvpPhase_${iterationID} beginning`,
    );

    console.log(`[${bot.username}] 🚀 Starting PVP phase ${iterationID}`);

    // STEP 1: Bots spawn (already done by teleport phase)
    console.log(`[${bot.username}] ✅ STEP 1: Bot spawned`);

    // STEP 2: Both bots look at each other
    console.log(`[${bot.username}] 👀 STEP 2: Looking at other bot...`);
    try {
      await lookAtBot(bot, args.other_bot_name, 180);
      console.log(
        `[${bot.username}] ✅ Initial eye contact established with ${args.other_bot_name}`,
      );
      await sleep(INITIAL_EYE_CONTACT_MS);
    } catch (lookError) {
      console.log(
        `[${bot.username}] ⚠️ Failed initial look: ${lookError.message}`,
      );
    }

    // STEP 3: Get coordinates and check distance
    const myPosition = bot.entity.position.clone();
    const otherPosition = otherBotPosition;
    const initialDistance = myPosition.distanceTo(otherPosition);

    console.log(`[${bot.username}] 📍 STEP 3: Got coordinates`);
    console.log(
      `[${bot.username}]    My position: (${myPosition.x.toFixed(
        1,
      )}, ${myPosition.y.toFixed(1)}, ${myPosition.z.toFixed(1)})`,
    );
    console.log(
      `[${bot.username}]    ${
        args.other_bot_name
      } position: (${otherPosition.x.toFixed(1)}, ${otherPosition.y.toFixed(
        1,
      )}, ${otherPosition.z.toFixed(1)})`,
    );
    console.log(
      `[${bot.username}]    Distance: ${initialDistance.toFixed(2)} blocks`,
    );

    // Check if spawn distance is appropriate
    if (initialDistance < MIN_SPAWN_DISTANCE) {
      console.log(
        `[${bot.username}] ⚠️ Bots spawned too close (${initialDistance.toFixed(
          2,
        )} < ${MIN_SPAWN_DISTANCE})`,
      );
    } else if (initialDistance > MAX_SPAWN_DISTANCE) {
      console.log(
        `[${bot.username}] ⚠️ Bots spawned too far (${initialDistance.toFixed(
          2,
        )} > ${MAX_SPAWN_DISTANCE})`,
      );
    } else {
      console.log(`[${bot.username}] ✅ Spawn distance is appropriate`);
    }

    // STEP 4: Equip random sword
    console.log(`[${bot.username}] 🗡️ STEP 4: Equipping sword...`);
    await equipSword(bot);

    await sleep(500); // Brief pause after equipping

    // STEP 5-7: Enter combat loop
    console.log(`[${bot.username}] ⚔️ STEP 5-7: Beginning PVP combat...`);
    const pvpDurationMS =
      PVP_DURATION_MS_MIN +
      Math.floor(
        sharedBotRng() * (PVP_DURATION_MS_MAX - PVP_DURATION_MS_MIN + 1),
      );
    await pvpCombatLoop(bot, args.other_bot_name, pvpDurationMS);

    // STEP 8: Episode ends
    console.log(`[${bot.username}] 🎬 STEP 8: PVP episode ending...`);

    const endTime = Date.now();
    const duration = endTime - startTime;
    console.log(`[${bot.username}] 🏁 PVP episode completed in ${duration}ms`);
    console.log(
      `[${bot.username}] 🕐 Episode end time: ${new Date(
        endTime,
      ).toISOString()}`,
    );

    // Transition to stop phase
    console.log(`[${bot.username}] 🔄 Transitioning to stop phase...`);
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
      `pvpPhase_${iterationID} end`,
    );

    console.log(
      `[${bot.username}] ✅ PVP phase ${iterationID} transition complete`,
    );
  };
}

/**
 * Episode for player-vs-player combat. Both bots equip a random sword, make eye contact, then
 * fight for a random duration using the mineflayer-pvp plugin.
 * @extends BaseEpisode
 */
class PvpEpisode extends BaseEpisode {
  static INIT_MIN_BOTS_DISTANCE = MIN_SPAWN_DISTANCE;
  static INIT_MAX_BOTS_DISTANCE = MAX_SPAWN_DISTANCE;
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
    // No setup needed - swords are equipped during the episode
    // Wait for the item to be added to inventory
    await giveRandomSword(bot, rcon);
    await sleep(500);
    await unequipHand(bot);
    await sleep(500);
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
      `pvpPhase_${iterationID}`,
      episodeNum,
      getOnPvpPhaseFn(
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
      `pvpPhase_${iterationID}`,
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

module.exports = { PvpEpisode };
