const { lookAtSmooth, sneak } = require("../../primitives/movement");
const { BaseEpisode } = require("../base-episode");

const CAMERA_SPEED_DEGREES_PER_SEC = 30;
const EPISODE_MIN_TICKS = 300;

function getOnTurnToLookPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (otherBotPosition) => {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    await bot.waitForTicks(2);

    coordinator.sendToOtherBot(
      "turnToLookPhase",
      bot.entity.position.clone(),
      episodeNum,
      "turnToLookPhase beginning",
    );

    const otherName = args.other_bot_name;
    const other = bot.players[otherName]?.entity;
    if (!other) {
      console.log(`[${bot.username}] Other bot missing, skipping.`);
      coordinator.sendToOtherBot(
        "stopPhase",
        bot.entity.position.clone(),
        episodeNum,
        "missing other bot",
      );
      return;
    }

    const me = bot.entity.position;
    const them = other.position;

    // ---- Phase 1: Look at each other ----
    console.log(`[${bot.username}] Looking at ${otherName}`);
    await lookAtSmooth(bot, them, 90, { randomized: false, useEasing: false });

    // ---- Phase 2: Signal beginning ----
    console.log(`[${bot.username}] Sneaking to signal beginning`);
    await sneak(bot);
    const startTick = bot.time.age;

    // ---- Phase 3: Face a random direction ----
    const vx = them.x - me.x;
    const vz = them.z - me.z;

    // Normalize horizontal vector
    const mag = Math.sqrt(vx * vx + vz * vz) || 1;
    const nx = vx / mag;
    const nz = vz / mag;

    // Rotate 90 degrees left or right
    // direction = +1 or -1 chosen from sharedRng so both bots choose opposite sides deterministically
    const dir = bot.username < otherName ? 1 : -1;

    // rotated vector
    const sideX = -nz * dir;
    const sideZ = nx * dir;

    const facePos = bot.entity.position.offset(sideX, 0, sideZ);
    console.log(
      `[${bot.username}] Facing sideways (${sideX.toFixed(2)}, ${sideZ.toFixed(2)})`,
    );

    episodeInstance._evalMetadata = {
      camera_speed_degrees_per_sec: CAMERA_SPEED_DEGREES_PER_SEC,
      side_vector: { x: sideX, z: sideZ },
      dir: dir,
    };

    await lookAtSmooth(bot, facePos, CAMERA_SPEED_DEGREES_PER_SEC, {
      randomized: false,
      useEasing: false,
    });

    // ---- Phase 4: Ensure minimum ticks ----
    const endTick = bot.time.age;
    const elapsed = endTick - startTick;
    const remaining = EPISODE_MIN_TICKS - elapsed;
    if (remaining > 0) {
      console.log(
        `[${bot.username}] Waiting ${remaining} ticks to reach ${EPISODE_MIN_TICKS}`,
      );
      await bot.waitForTicks(remaining);
    }

    // ---- Phase 5: Stop phase ----
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
      "turnToLookPhase end",
    );
  };
}

/**
 * Eval episode: bots look at each other, then one (by name order) faces sideways; used to
 * evaluate turning to look at the other bot.
 * @extends BaseEpisode
 */
class TurnToLookEvalEpisode extends BaseEpisode {
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
      "turnToLookPhase",
      episodeNum,
      getOnTurnToLookPhaseFn(
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
      "turnToLookPhase",
      bot.entity.position.clone(),
      episodeNum,
      "teleportPhase end",
    );
  }
}

module.exports = { TurnToLookEvalEpisode };
