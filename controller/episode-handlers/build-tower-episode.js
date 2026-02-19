// build-tower-episode.js - Individual tower building episode
const { ensureBotHasEnough, unequipHand } = require("../primitives/items");

const { buildTowerUnderneath } = require("../primitives/building");
const { sleep } = require("../primitives/movement");
const { BaseEpisode } = require("./base-episode");

// Constants for tower building behavior
const INITIAL_EYE_CONTACT_MS = 1500; // Initial look duration
const FINAL_EYE_CONTACT_MS = 1500; // Final look duration
const MIN_TOWER_HEIGHT = 8; // Minimum tower height
const MAX_TOWER_HEIGHT = 12; // Maximum tower height
const TOWER_BLOCK_TYPE = "oak_planks"; // Block type for towers
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
  return async function onBuildTowerPhase(otherBotPosition) {
    coordinator.sendToOtherBot(
      `buildTowerPhase_${iterationID}`,
      bot.entity.position.clone(),
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

    // STEP 6: Final eye contact
    console.log(`[${bot.username}] 👀 STEP 6: Final eye contact...`);
    try {
      const otherEntity = bot.players[args.other_bot_name]?.entity;
      if (otherEntity) {
        const targetPos = otherEntity.position.offset(0, otherEntity.height, 0);
        await bot.lookAt(targetPos, false);
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
      `buildTowerPhase_${iterationID} end`,
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
    otherBotPosition,
  ) {
    // Give tower building blocks via RCON
    await ensureBotHasEnough(bot, rcon, TOWER_BLOCK_TYPE, 64);
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
      `buildTowerPhase_${iterationID}`,
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
    );
    coordinator.sendToOtherBot(
      `buildTowerPhase_${iterationID}`,
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
    // Clean up any remaining blocks from inventory
  }
}

module.exports = { BuildTowerEpisode };
