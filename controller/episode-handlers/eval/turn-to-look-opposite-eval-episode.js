const { lookAtSmooth, sneak } = require("../../primitives/movement");
const { BaseEpisode } = require("../base-episode");

const CAMERA_SPEED_DEGREES_PER_SEC = 30;
const EPISODE_MIN_TICKS = 300;

function getOnTurnToLookOppositePhaseFn(
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
      "turnToLookOppositePhase",
      bot.entity.position.clone(),
      episodeNum,
      "turnToLookOppositePhase beginning",
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

    // Make both bots use the same rotation direction, which results in opposite facing directions
    // because their base vectors (toward each other) are already opposite
    const dir = 1;

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
      "turnToLookOppositePhase end",
    );
  };
}

/**
 * Eval episode: same as TurnToLook but both bots rotate the same direction so they end up
 * facing opposite directions; used to evaluate turn-to-look in opposite configuration.
 * @extends BaseEpisode
 */
class TurnToLookOppositeEvalEpisode extends BaseEpisode {
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
      "turnToLookOppositePhase",
      episodeNum,
      getOnTurnToLookOppositePhaseFn(
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
      "turnToLookOppositePhase",
      bot.entity.position.clone(),
      episodeNum,
      "teleportPhase end",
    );
  }
}

module.exports = { TurnToLookOppositeEvalEpisode };
