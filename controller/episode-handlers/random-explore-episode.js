const { lookSmooth, jump, stopAll } = require("../primitives/movement");
const { digBlock } = require("../primitives/digging");
const { buildTowerUnderneath } = require("../primitives/building");
const { ensureBotHasEnough } = require("../primitives/items");
const { sleep } = require("../utils/helpers");
const {
  DEFAULT_CAMERA_SPEED_DEGREES_PER_SEC,
  JUMP_PROBABILITY,
} = require("../utils/constants");
const { BaseEpisode } = require("./base-episode");

const WALK_LEGS = 2;
const WALK_LEG_MIN_BLOCKS = 5;
const WALK_LEG_MAX_BLOCKS = 8;
const BREAK_COUNT = 2;
const TOWER_HEIGHT = 6;
const TOWER_BLOCK = "diamond_block";
const TOWER_BLOCK_COUNT = 64;

/**
 * Walk somewhere like a real player: turn to a new heading, look level ahead,
 * then walk forward toward it.  Repeats for `legs` legs so the bot actually
 * covers ground with the camera facing where it's going, hopping occasionally.
 */
async function walkLookingAhead(bot, legs, args, sharedBotRng) {
  const timeoutMs = (args.walk_timeout ?? 10) * 1000;
  try {
    for (let n = 0; n < legs; n++) {
      // New heading: turn +/-[30,150] deg from the current facing, look forward.
      const sign = sharedBotRng() < 0.5 ? -1 : 1;
      const turnRad = (sign * (30 + sharedBotRng() * 120) * Math.PI) / 180;
      await lookSmooth(
        bot,
        bot.entity.yaw + turnRad,
        0, // level pitch -- look straight ahead
        DEFAULT_CAMERA_SPEED_DEGREES_PER_SEC,
      );

      // Walk forward toward where we're looking, for a random distance.
      const distance =
        WALK_LEG_MIN_BLOCKS +
        sharedBotRng() * (WALK_LEG_MAX_BLOCKS - WALK_LEG_MIN_BLOCKS);
      const startPos = bot.entity.position.clone();
      const startTime = Date.now();
      let lastJump = startTime;
      bot.setControlState("forward", true);
      try {
        while (bot.entity.position.distanceTo(startPos) < distance) {
          if (Date.now() - startTime > timeoutMs) break;
          // Occasional hop while moving (forward stays held -> jumps forward).
          if (Date.now() - lastJump > 1000 && sharedBotRng() < JUMP_PROBABILITY) {
            lastJump = Date.now();
            await jump(bot, 350);
          }
          await sleep(50);
        }
      } finally {
        bot.setControlState("forward", false);
      }
      console.log(
        `[${bot.username}] walked leg ${n + 1}/${legs} ` +
          `~${bot.entity.position.distanceTo(startPos).toFixed(1)} blocks`,
      );
    }
  } finally {
    stopAll(bot);
  }
}

/**
 * Break a couple of nearby blocks the bot can see and reach.  Skips the block
 * directly underfoot (which the client cannot reliably dig) plus unbreakable
 * and leaf blocks, so it produces a clean removal without digging into bedrock.
 */
async function breakRandomBlocks(bot, count, sharedBotRng) {
  const underfoot = bot.entity.position.floored().offset(0, -1, 0);
  const isBreakable = (b) =>
    b &&
    b.boundingBox === "block" &&
    b.name !== "bedrock" &&
    !b.name.includes("leaves");
  const candidates = bot
    .findBlocks({ matching: isBreakable, maxDistance: 3, count: 40 })
    .filter((pos) => !pos.equals(underfoot));

  // Random order via the shared per-episode RNG.
  candidates.sort(() => sharedBotRng() - 0.5);

  let broken = 0;
  for (const pos of candidates) {
    if (broken >= count) break;
    const block = bot.blockAt(pos);
    if (!block || !bot.canSeeBlock(block)) continue;
    await digBlock(bot, pos);
    await bot.waitForTicks(4);
    broken += 1;
  }
}

function getOnExplorePhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
) {
  return async () => {
    coordinator.broadcastToPeers(
      "explorePhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      "explorePhase beginning",
    );

    // Stock a tool for breaking and blocks for the tower.
    await ensureBotHasEnough(bot, rcon, "diamond_pickaxe", 1);
    await ensureBotHasEnough(bot, rcon, "diamond_shovel", 1);
    await ensureBotHasEnough(bot, rcon, TOWER_BLOCK, TOWER_BLOCK_COUNT);

    // 1. Walk somewhere: turn to a heading, look ahead, walk forward -- a few legs.
    console.log(`[${bot.username}] explore: walking ${WALK_LEGS} legs`);
    await walkLookingAhead(bot, WALK_LEGS, args, sharedBotRng);

    // 2. Break a couple of random nearby blocks.
    console.log(`[${bot.username}] explore: breaking ${BREAK_COUNT} random blocks`);
    await breakRandomBlocks(bot, BREAK_COUNT, sharedBotRng);

    // 3. Build a tower straight up underneath the bot.
    console.log(`[${bot.username}] explore: building ${TOWER_HEIGHT}-block tower`);
    await buildTowerUnderneath(bot, TOWER_HEIGHT, args, { blockType: TOWER_BLOCK });

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
      { location: "explorePhase end" },
    );
  };
}

/**
 * Single-player episode: the bot walks somewhere over a couple of legs (turning
 * to face and look where it's going), breaks a couple of nearby blocks, then
 * builds a tower straight up underneath itself.
 * Does not read peer state, so it runs standalone with one bot.
 * @extends BaseEpisode
 */
class RandomExploreEpisode extends BaseEpisode {
  static WORKS_IN_NON_FLAT_WORLD = true;

  // Face the peer at setup when one exists; with no peer, look ahead in the
  // bot's current direction instead of at a non-existent peer position.
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
    const peer = peerPositionsMap.values().next().value;
    if (peer) return peer;
    const yaw = bot.entity.yaw;
    // Look ahead level with the horizon: lookAtSmooth reckons pitch from the
    // bot's feet, so keep the target at feet height (dy = 0 -> pitch 0).
    return bot.entity.position.offset(
      -Math.sin(yaw) * 4,
      0,
      -Math.cos(yaw) * 4,
    );
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
      "explorePhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      getOnExplorePhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        this,
        args,
      ),
      { location: "teleportPhase end" },
    );
  }
}

module.exports = { RandomExploreEpisode };
