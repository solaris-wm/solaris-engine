const {
  lookAtSmooth,
  sleep,
  land_pos,
  horizontalDistanceTo,
  gotoWithTimeout,
  initializePathfinder,
} = require("../primitives/movement");

const { GoalNear } = require("../utils/bot-factory");
const { BaseEpisode } = require("./base-episode");
const { unequipHand } = require("../primitives/items");
const {
  giveRandomSword,
  equipSword,
  isInForwardFOV,
  FOV_DEGREES,
} = require("../primitives/fighting");

const CAMERA_SPEED_DEGREES_PER_SEC = 60;

const VIEW_DISTANCE = 16;
const LOCK_EYE_DURATION_MIN = 1000;
const LOCK_EYE_DURATION_MAX = 3000;
const MIN_MOBS = 2;
const MAX_MOBS = 5;

// Hostile mobs we allow for spawning and targeting
const HOSTILE_MOBS_SUMMON_IDS = [
  "minecraft:zombie",
  "minecraft:skeleton",
  "minecraft:spider",
  "minecraft:husk",
];
const HOSTILE_ENTITY_NAMES = new Set(
  HOSTILE_MOBS_SUMMON_IDS.map((id) => id.split(":")[1]),
);

async function spawnWithRconAround(
  bot,
  rcon,
  { mob, count, maxRadius, minRadius },
) {
  const { x, y, z } = bot.entity.position;

  const baseX = Math.floor(x),
    baseZ = Math.floor(z);
  const yaw = bot.entity.yaw;
  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  const fovRadians = (FOV_DEGREES * Math.PI) / 180;
  const cmds = [];
  for (let i = 0; i < count; i++) {
    // Pick a random direction within the forward FOV cone
    const angleOffset = (Math.random() - 0.5) * fovRadians;
    const cosA = Math.cos(angleOffset);
    const sinA = Math.sin(angleOffset);
    const dirX = forwardX * cosA - forwardZ * sinA;
    const dirZ = forwardX * sinA + forwardZ * cosA;

    // Pick a random distance biased outward
    const r = Math.sqrt(Math.random()) * (maxRadius - minRadius) + minRadius;
    const dx = Math.round(dirX * r);
    const dz = Math.round(dirZ * r);

    // Find a safe land position, falling back to flat Y if chunk is unloaded
    const posCandidate = land_pos(bot, baseX + dx, baseZ + dz);
    const spawnX = posCandidate ? posCandidate.x : baseX + dx;
    const spawnZ = posCandidate ? posCandidate.z : baseZ + dz;
    const spawnY = posCandidate ? posCandidate.y + 1 : y;

    cmds.push(`summon ${mob} ${spawnX} ${spawnY} ${spawnZ}`);
  }

  for (const cmd of cmds) {
    const res = await rcon.send(cmd);
    console.log(`[${bot.username}] Spawned mob: ${cmd} with response: ${res}`);
  }
}

/**
 * Create a filter function for hostile mobs within FOV and distance.
 * @param {any} bot - The bot instance
 * @param {number} maxDistance - Maximum distance to search (default VIEW_DISTANCE)
 * @param {boolean} checkFOV - Whether to require entity to be within forward FOV
 * @returns {function} Filter function for entities
 */
function isHostileMobFilter(
  bot,
  maxDistance = VIEW_DISTANCE,
  checkFOV = false,
) {
  return (e) => {
    if (!e || !HOSTILE_ENTITY_NAMES.has(e.name)) {
      return false;
    }

    const dist = e.position.distanceTo(bot.entity.position);
    if (dist >= maxDistance) return false;
    if (checkFOV && !isInForwardFOV(bot, e.position)) return false;
    return true;
  };
}

/**
 * Get the nearest hostile mob within the bot's FOV.
 * @param {any} bot - The bot instance
 * @param {number} maxDistance - Maximum distance to search (default VIEW_DISTANCE)
 * @returns {any} The nearest hostile mob or undefined
 */
function getNearestHostile(bot, maxDistance = VIEW_DISTANCE, checkFOV = false) {
  const mob = bot.nearestEntity(isHostileMobFilter(bot, maxDistance, checkFOV));

  if (!mob) {
    console.log(
      `[${bot.username}] No hostile mob ${
        checkFOV ? "in FOV" : ""
      } within ${maxDistance.toFixed(1)} blocks.`,
    );
    return;
  }
  const dist = bot.entity.position.distanceTo(mob.position).toFixed(1);
  const msg =
    `[${bot.username}] Nearest hostile: name=${mob.name}, type=${mob.type}, displayName=${mob.displayName} @ ${dist} blocks ` +
    `pos(${mob.position.x.toFixed(1)},${mob.position.y.toFixed(
      1,
    )},${mob.position.z.toFixed(1)})`;
  console.log(msg);
  return mob;
}

/**
 * Guard-based combat system for PvE fighting
 * @param {any} bot - The bot instance
 * @param {any} guardPosition - The position to guard
 * @param {any} otherBotGuardPosition - The other bot's guard position to look at
 * @returns {Promise} Promise that resolves when combat is complete
 */
async function guardAndFight(bot, guardPosition, otherBotGuardPosition) {
  const MELEE_RANGE = 7;

  // Ensure we're not currently pathfinding/combat from a previous step
  await bot.pvp.stop();
  bot.pathfinder.setGoal(null);
  initializePathfinder(bot, {
    allowSprinting: false,
    allowParkour: true,
    canDig: true,
    allowEntityDetection: true,
  });

  // Wait for a hostile mob to come within melee distance
  let target;
  const targetSearchStartTime = Date.now();
  const TIMEOUT_MS = 15000; // 15 seconds
  while (true) {
    await sleep(200);

    // Check for timeout
    if (Date.now() - targetSearchStartTime > TIMEOUT_MS) {
      console.log(
        `[${
          bot.username
        }] Timeout waiting for hostile mob within ${MELEE_RANGE.toFixed(
          1,
        )} blocks.`,
      );
      return; // Exit guardAndFight early
    }

    target = getNearestHostile(bot, MELEE_RANGE);
    if (!target) {
      console.log(
        `[${
          bot.username
        }] nothing to guard no hostile mob in ${MELEE_RANGE.toFixed(1)} blocks.`,
      );
      continue;
    }
    break;
  }
  console.log(`[${bot.username}] Target found: ${target.name}`);

  // Engage using mineflayer-pvp
  bot.pvp.attack(target);

  // Wait until the target is defeated (despawned/dead)
  const combatStartTime = Date.now();
  while (true) {
    await sleep(200);

    // Check for timeout
    if (Date.now() - combatStartTime > TIMEOUT_MS) {
      console.log(
        `[${bot.username}] Timeout waiting for target defeat, stopping combat.`,
      );
      await bot.pvp.stop();
      return; // Exit guardAndFight early
    }

    const still = bot.entities[target.id];
    if (!still || !still.isValid) break;
  }
  console.log(`[${bot.username}] Target defeated.`);

  // Stop combat if still active
  console.log(`[${bot.username}] Stopping combat.`);
  await bot.pvp.stop();

  const goal = new GoalNear(
    guardPosition.x,
    guardPosition.y,
    guardPosition.z,
    1,
  );
  let reached = false;
  for (let attempt = 0; attempt < 2 && !reached; attempt++) {
    try {
      await gotoWithTimeout(bot, goal, { timeoutMs: 30000 });
      reached = true;
    } catch (err) {
      const msg = String(err?.message || err || "");
      console.log(
        `[${bot.username}] goto to guard failed (attempt ${
          attempt + 1
        }): ${msg}`,
      );
      // Ignore PathStopped and retry once after clearing goal
      bot.pathfinder.setGoal(null);
      await sleep(200);
    }
  }
  // If still not at guard, just continue (avoid crashing the episode)

  // Look at the other bot's guard position for a random lock-eye interval
  await lookAtSmooth(bot, otherBotGuardPosition, CAMERA_SPEED_DEGREES_PER_SEC);
  await sleep(
    LOCK_EYE_DURATION_MIN +
      Math.random() * (LOCK_EYE_DURATION_MAX - LOCK_EYE_DURATION_MIN),
  );
}

function getOnPVEFightPhaseFn(
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
  return async (phaseDataOther) => {
    coordinator.sendToOtherBot(
      `pvePhase_fight_${iterationID}`,
      phaseDataOur,
      episodeNum,
      `pvePhase_fight_${iterationID} beginning`,
    );
    let mob = null;
    await sleep(1000);
    const distToOther = horizontalDistanceTo(
      phaseDataOur.guardPosition,
      phaseDataOther.guardPosition,
    );
    const mobDistMax = distToOther / 4;
    const mobDistMin = mobDistMax / 2;

    // Use guard-based combat: guard our position and look at other bot's position
    const ourGuardPosition = phaseDataOur.guardPosition;
    const otherGuardPosition = phaseDataOther.guardPosition;
    const numMobs =
      Math.floor(sharedBotRng() * (MAX_MOBS - MIN_MOBS + 1)) + MIN_MOBS;
    for (let mobI = 0; mobI < numMobs; mobI++) {
      await equipSword(bot);
      const mobInFov = getNearestHostile(bot, mobDistMax, true);
      if (!mobInFov) {
        const chosenMob =
          HOSTILE_MOBS_SUMMON_IDS[
            Math.floor(Math.random() * HOSTILE_MOBS_SUMMON_IDS.length)
          ];
        console.log(
          `[${bot.username}] No mob in FOV, Spawning mob ${mobI} ${chosenMob} in FOV.`,
        );
        await spawnWithRconAround(bot, rcon, {
          mob: chosenMob,
          count: 1,
          maxRadius: mobDistMax,
          minRadius: mobDistMin,
        });
      }
      console.log(
        `[${
          bot.username
        }] iteration ${iterationID} mob ${mobI} starting PvE, health=${bot.health.toFixed(
          1,
        )}/20 food=${bot.food}`,
      );

      await guardAndFight(bot, ourGuardPosition, otherGuardPosition);

      console.log(
        `[${
          bot.username
        }] iteration ${iterationID} mob ${mobI} finished PvE, health=${bot.health.toFixed(
          1,
        )}/20 food=${bot.food}`,
      );
    }
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
      `pvePhase_${iterationID} end`,
    );
  };
}
function getOnPVEPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (phaseDataOther) => {
    coordinator.sendToOtherBot(
      `pvePhase`,
      { position: bot.entity.position.clone() },
      episodeNum,
      `pvePhase beginning`,
    );

    const iterationID = 0;
    const nextPhaseDataOur = {
      guardPosition: bot.entity.position.clone(),
    };
    coordinator.onceEvent(
      `pvePhase_fight_${iterationID}`,
      episodeNum,
      getOnPVEFightPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        iterationID,
        episodeNum,
        episodeInstance,
        args,
        nextPhaseDataOur,
      ),
    );
    coordinator.sendToOtherBot(
      `pvePhase_fight_${iterationID}`,
      nextPhaseDataOur,
      episodeNum,
      `pvePhase end`,
    );
    return;
  };
}

/**
 * Episode where both bots fight hostile mobs (spawned via RCON). Each bot guards a position,
 * engages nearby hostiles with mineflayer-pvp, then returns and looks at the other bot.
 * @extends BaseEpisode
 */
class PveEpisode extends BaseEpisode {
  static INIT_MIN_BOTS_DISTANCE = 15;
  static INIT_MAX_BOTS_DISTANCE = 25;
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
    const difficultyRes = await rcon.send("difficulty easy"); // or hard
    console.log(
      `[${bot.username}] set difficulty to easy, difficultyRes=${difficultyRes}`,
    );

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
      `pvePhase`,
      episodeNum,
      getOnPVEPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        this,
        args,
      ),
    );
    coordinator.sendToOtherBot(
      `pvePhase`,
      { position: bot.entity.position.clone() },
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
    // optional teardown
    const difficultyRes = await rcon.send("difficulty peaceful"); // or hard
    console.log(
      `[${bot.username}] set difficulty to peaceful, difficultyRes=${difficultyRes}`,
    );
  }
}
module.exports = { PveEpisode };
