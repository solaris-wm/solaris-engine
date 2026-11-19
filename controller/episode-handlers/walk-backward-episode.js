const { lookSmooth, stopAll } = require("../primitives/movement");
const { sleep } = require("../utils/helpers");
const { DEFAULT_CAMERA_SPEED_DEGREES_PER_SEC } = require("../utils/constants");
const { BaseEpisode } = require("./base-episode");

const WALK_LEGS = 3;
const WALK_LEG_MIN_BLOCKS = 6;
const WALK_LEG_MAX_BLOCKS = 10;
const STUCK_MS = 800; // no progress for this long -> we've backed into something

/**
 * Walk backwards while looking level ahead.  Each leg turns to a new heading,
 * looks straight ahead at the horizon (pitch 0), then holds "back" so the agent
 * reverses *away* from where the camera is pointing -- the scene recedes in
 * view.  A leg ends after ~8 blocks, when the agent backs into something (no
 * progress), or on a timeout; the next leg's turn then sends it a new way, so it
 * reverses, bumps, turns, and reverses elsewhere.
 */
async function walkBackwardLookingAhead(bot, legs, args, sharedBotRng) {
  const timeoutMs = (args.walk_timeout ?? 10) * 1000;
  try {
    for (let n = 0; n < legs; n++) {
      // New heading: turn +/-[30,150] deg from the current facing, look level.
      const sign = sharedBotRng() < 0.5 ? -1 : 1;
      const turnRad = (sign * (30 + sharedBotRng() * 120) * Math.PI) / 180;
      await lookSmooth(
        bot,
        bot.entity.yaw + turnRad,
        0, // level pitch -- look straight ahead at the horizon
        DEFAULT_CAMERA_SPEED_DEGREES_PER_SEC,
      );

      const distance =
        WALK_LEG_MIN_BLOCKS +
        sharedBotRng() * (WALK_LEG_MAX_BLOCKS - WALK_LEG_MIN_BLOCKS);
      const startPos = bot.entity.position.clone();
      const startTime = Date.now();
      let lastPos = startPos;
      let lastMoveTime = startTime;
      bot.setControlState("back", true);
      try {
        while (bot.entity.position.distanceTo(startPos) < distance) {
          if (Date.now() - startTime > timeoutMs) break;
          // Bump detector: backing in blind, so if we stop moving we've hit
          // something -- end the leg and let the next turn redirect us.
          if (bot.entity.position.distanceTo(lastPos) > 0.05) {
            lastPos = bot.entity.position.clone();
            lastMoveTime = Date.now();
          } else if (Date.now() - lastMoveTime > STUCK_MS) {
            break;
          }
          await sleep(50);
        }
      } finally {
        bot.setControlState("back", false);
      }
      console.log(
        `[${bot.username}] backed leg ${n + 1}/${legs} ` +
          `~${bot.entity.position.distanceTo(startPos).toFixed(1)} blocks`,
      );
    }
  } finally {
    stopAll(bot);
  }
}

function getOnBackwardPhaseFn(
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
      "backwardPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      "backwardPhase beginning",
    );

    console.log(`[${bot.username}] backward: walking ${WALK_LEGS} legs`);
    await walkBackwardLookingAhead(bot, WALK_LEGS, args, sharedBotRng);

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
      { location: "backwardPhase end" },
    );
  };
}

/**
 * Single-player episode: the bot reverses over a few legs, looking level ahead
 * the whole time, turning to a new heading between legs.  Produces "scene
 * recedes" egomotion (the opposite optical flow of a forward walk).
 * Does not read peer state, so it runs standalone with one bot.
 * @extends BaseEpisode
 */
class WalkBackwardEpisode extends BaseEpisode {
  static WORKS_IN_NON_FLAT_WORLD = true;

  // Face the peer at setup when one exists; with no peer, look level ahead in
  // the bot's current direction (feet-height target -> pitch 0).
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
      "backwardPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      getOnBackwardPhaseFn(
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

module.exports = { WalkBackwardEpisode };
