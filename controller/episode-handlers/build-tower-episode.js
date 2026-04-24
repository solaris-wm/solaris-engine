// build-tower-episode.js - Individual tower building episode
const { ensureBotHasEnough, unequipHand } = require("../primitives/items");

const { buildTowerUnderneath } = require("../primitives/building");
const { lookAtSmooth, sleep } = require("../primitives/movement");
const { BaseEpisode } = require("./base-episode");

// Constants for tower building behavior
const INITIAL_EYE_CONTACT_MS = 1500; // Initial look duration
const FINAL_EYE_CONTACT_MS = 1500; // Final look duration
const CAMERA_SPEED_DEGREES_PER_SEC = 60; // Gaze rotation speed
const MIN_TOWER_HEIGHT = 8; // Minimum tower height
const MAX_TOWER_HEIGHT = 12; // Maximum tower height
const TOWER_BLOCK_TYPE = "oak_planks"; // Block type for towers
// Pass peer FEET (not eye) as the look-at target: lookAtSmooth uses bot feet as the
// rotation source, so feet-to-feet and eye-to-eye produce the same pitch. Adding an
// eye-height offset would tilt the gaze upward by ~9° at ~10-block distance.
const JUMP_DURATION_MS = 50; // How long to hold jump
const PLACE_RETRY_DELAY_MS = 20; // Delay between place attempts
const MAX_PLACE_ATTEMPTS = 10; // Max attempts to place a block
const SETTLE_DELAY_MS = 200; // Delay to settle after placing

/**
 * Get the phase function for tower building episodes
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
function getOnBuildTowerPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  iterationID,
  episodeNum,
  episodeInstance,
  args,
) {
  return async function onBuildTowerPhase(peerMap) {
    const peerName = coordinator.getSinglePeerName();
    coordinator.broadcastToPeers(
      `buildTowerPhase_${iterationID}`,
      { position: bot.entity.position.clone() },
      episodeNum,
      `buildTowerPhase_${iterationID} beginning`,
    );

    console.log(
      `[${bot.username}] 🚀 Starting BUILD TOWER phase ${iterationID}`,
    );

    // STEP 1: Bots spawn (already done by teleport phase)
    console.log(`[${bot.username}] ✅ STEP 1: Bot spawned`);
    // STEP 2: Initial eye contact
    console.log(
      `[${bot.username}] 👀 STEP 2: Making eye contact with ${peerName}...`,
    );
    try {
      const otherEntity = bot.players[peerName]?.entity;
      if (otherEntity) {
        const targetPos = otherEntity.position;
        await lookAtSmooth(bot, targetPos, CAMERA_SPEED_DEGREES_PER_SEC);
        await sleep(INITIAL_EYE_CONTACT_MS);
      }
    } catch (lookError) {
      console.log(
        `[${bot.username}] ⚠️ Could not look at other bot: ${lookError.message}`,
      );
    }

    // Barrier: lookAtSmooth time varies with initial orientation — align build start.
    await coordinator.syncAllPeers(
      `buildTowerStart_${iterationID}`,
      {},
      episodeNum,
      { location: `buildTowerPhase_${iterationID} build-start barrier` },
    );

    // STEP 3: Prepare to place blocks
    console.log(`[${bot.username}] 📐 STEP 3: Preparing to build tower...`);

    // STEP 4: Determine tower height and position
    const towerHeight =
      MIN_TOWER_HEIGHT +
      Math.floor(sharedBotRng() * (MAX_TOWER_HEIGHT - MIN_TOWER_HEIGHT + 1));
    console.log(`[${bot.username}] 📏 Tower height: ${towerHeight} blocks`);

    // STEP 5: Build the tower
    console.log(
      `[${bot.username}] 🗼 STEP 5: Building ${towerHeight}-block tower with ${TOWER_BLOCK_TYPE}...`,
    );
    const buildResult = await buildTowerUnderneath(bot, towerHeight, args, {
      blockType: TOWER_BLOCK_TYPE,
      breakOnFailure: true, // build-tower-episode breaks immediately on failure
      enableRetry: false, // simpler version without retry logic
    });

    // Barrier so both bots gaze together after (possibly different-height) towers finish.
    await coordinator.syncAllPeers(
      `buildTowerEnd_${iterationID}`,
      {},
      episodeNum,
      { location: `buildTowerPhase_${iterationID} build-end barrier` },
    );

    // STEP 6: Final eye contact
    console.log(`[${bot.username}] 👀 STEP 6: Final eye contact...`);
    try {
      const otherEntity = bot.players[peerName]?.entity;
      if (otherEntity) {
        const targetPos = otherEntity.position;
        await lookAtSmooth(bot, targetPos, CAMERA_SPEED_DEGREES_PER_SEC);
        await sleep(FINAL_EYE_CONTACT_MS);
      }
    } catch (lookError) {
      console.log(
        `[${bot.username}] ⚠️ Could not look at other bot: ${lookError.message}`,
      );
    }

    console.log(`[${bot.username}] ✅ BUILD TOWER phase complete!`);
    console.log(
      `[${bot.username}] 📊 Final stats: ${buildResult.success}/${towerHeight} blocks placed`,
    );

    // STEP 7: Transition to stop phase (end episode)
    coordinator.exchangeWithPeers(
      "stopPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      episodeInstance.getOnStopPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        args,
      ),
      { location: `buildTowerPhase_${iterationID} end` },
    );

    return buildResult;
  };
}

/**
 * Episode for individual tower building. Each bot builds a tower of random height (8–12 blocks)
 * at their spawn position, with initial and final eye contact.
 * @extends BaseEpisode
 */
class BuildTowerEpisode extends BaseEpisode {
  static INIT_MIN_BOTS_DISTANCE = 8;
  static INIT_MAX_BOTS_DISTANCE = 15;
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
    // Give tower building blocks via RCON
    await ensureBotHasEnough(bot, rcon, TOWER_BLOCK_TYPE, 64);
    await unequipHand(bot);
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
    coordinator.exchangeWithPeers(
      `buildTowerPhase_${iterationID}`,
      { position: bot.entity.position.clone() },
      episodeNum,
      getOnBuildTowerPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        iterationID,
        episodeNum,
        this,
        args,
      ),
      { location: "entryPoint end" },
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

module.exports = { BuildTowerEpisode };
