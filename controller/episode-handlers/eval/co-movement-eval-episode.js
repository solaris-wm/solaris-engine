const { Vec3 } = require("vec3");
const { lookAtSmooth, sneak } = require("../../primitives/movement");
const { BaseEpisode } = require("../base-episode");

const CAMERA_SPEED_DEGREES_PER_SEC = 171.8873;
const EPISODE_MIN_TICKS = 300;
// Each bot walks toward the midpoint and stops this far from it, leaving the two
// roughly 2x this distance apart (~7.4 blocks in practice, since each bot slightly
// overshoots the per-tick distance check).
const STOP_XZ_DISTANCE_FROM_MARKER = 4;
const APPROACH_TIMEOUT_TICKS = 200;
// How far each bot travels during the co-movement phase. Both bots move in
// opposite world directions, so the relative displacement is 2x this.
//
// Lateral (left/right) keeps the partner comfortably inside the frame.
// Radial (forward/back) has to be smaller: the bots start only ~7.4 blocks apart,
// so 2 blocks each leaves ~3.4 blocks at the closest (both forward) and ~11.4 at
// the farthest (both backward).
const MOVE_XZ_DISTANCE_LATERAL = 2.75;
const MOVE_XZ_DISTANCE_RADIAL = 2;
const MOVE_XZ_DISTANCE_FOR = {
  left: MOVE_XZ_DISTANCE_LATERAL,
  right: MOVE_XZ_DISTANCE_LATERAL,
  forward: MOVE_XZ_DISTANCE_RADIAL,
  back: MOVE_XZ_DISTANCE_RADIAL,
};
const MOVE_TIMEOUT_TICKS = 100;
// Hold still between the approach and the co-movement so the two sub-tasks are
// cleanly separable in the video.
const FREEZE_TICKS = 20;

// The four egocentric directions, mirroring the translation eval.
const DIRECTIONS = ["forward", "back", "left", "right"];

/**
 * Both bots issue the same egocentric command. They face each other, so they
 * move in opposite world directions.
 * @param {number} episodeNum
 * @returns {{caseNum: number, direction: string}}
 */
function movementCase(episodeNum) {
  const caseNum = episodeNum % DIRECTIONS.length;
  return { caseNum, direction: DIRECTIONS[caseNum] };
}

/**
 * Orientation places the second bot on +X, -X, +Z or -Z of the first one.
 * It changes every 4 episodes, so 16 episodes cover all 4 x 4 (direction x
 * orientation) combinations. The instance offset rotates which episode lands on
 * which orientation, so two worlds do not march in lockstep.
 * @param {number} episodeNum
 * @param {number} [instanceId=0]
 * @returns {{orientation: number, axis: string, sign: number}}
 */
function lineupPlan(episodeNum, instanceId = 0) {
  const orientation =
    (Math.floor(episodeNum / DIRECTIONS.length) +
      2 * Number(instanceId || 0)) %
    4;
  return {
    orientation,
    axis: orientation < 2 ? "x" : "z",
    sign: orientation % 2 === 0 ? 1 : -1,
  };
}

function xzDistance(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// Scan down at (x, z) for the ground surface and return the y of the air block
// on top of it (a valid standing y). Returns null if no ground found.
function findSurfaceY(bot, x, z, scanTopY, scanDepth = 10) {
  for (let y = scanTopY; y >= scanTopY - scanDepth; y--) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (block && block.boundingBox === "block") {
      return y + 1;
    }
  }
  return null;
}

function getOnApproachPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (peerMap) => {
    const peerName = coordinator.getSinglePeerName();
    const otherBotPosition = peerMap.values().next().value.position;
    coordinator.broadcastToPeers(
      "coMovementApproachPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      "coMovementApproachPhase beginning",
    );

    const { caseNum, direction } = movementCase(episodeNum);
    const [alphaName, bravoName] = [bot.username, peerName].sort();

    const markerPos = episodeInstance._markerPos;
    const approachStartPos = bot.entity.position.clone();

    // Directions are egocentric, i.e. relative to each bot's own facing while it
    // looks at the other bot.
    episodeInstance._evalMetadata = {
      bots_chosen: [alphaName, bravoName],
      camera_speed_degrees_per_sec: CAMERA_SPEED_DEGREES_PER_SEC,
      midpoint_position: { x: markerPos.x, y: markerPos.y, z: markerPos.z },
      lineup_axis: episodeInstance._lineupAxis,
      lineup_orientation: episodeInstance._lineupOrientation,
      lineup_sign: episodeInstance._lineupSign,
      case_num: caseNum,
      leader: alphaName,
      move_directions: {
        [alphaName]: direction,
        [bravoName]: direction,
      },
      this_bot_move_direction: direction,
      stop_xz_distance_from_marker: STOP_XZ_DISTANCE_FROM_MARKER,
      move_xz_distance: MOVE_XZ_DISTANCE_FOR[direction],
      move_xz_distance_lateral: MOVE_XZ_DISTANCE_LATERAL,
      move_xz_distance_radial: MOVE_XZ_DISTANCE_RADIAL,
      freeze_ticks: FREEZE_TICKS,
      approach_start_position: {
        x: approachStartPos.x,
        y: approachStartPos.y,
        z: approachStartPos.z,
      },
    };

    // Face the other bot, then sneak to signal evaluation start
    await lookAtSmooth(
      bot,
      new Vec3(otherBotPosition.x, otherBotPosition.y, otherBotPosition.z),
      CAMERA_SPEED_DEGREES_PER_SEC,
      { randomized: false, useEasing: false },
    );
    await sneak(bot);
    episodeInstance._evalStartTick = bot.time.age;

    console.log(
      `[${bot.username}] approaching midpoint at (${markerPos.x}, ${markerPos.y}, ${markerPos.z}) ` +
        `along ${episodeInstance._lineupAxis} axis, stopping ${STOP_XZ_DISTANCE_FROM_MARKER} blocks away, ` +
        `then moving ${direction} (case ${caseNum})`,
    );

    // Both bots walk straight toward each other (the midpoint lies on that line)
    // and stop at a fixed distance from it.
    const approachStartTick = bot.time.age;
    bot.setControlState("forward", true);
    try {
      while (
        xzDistance(bot.entity.position, markerPos) >
          STOP_XZ_DISTANCE_FROM_MARKER &&
        bot.time.age - approachStartTick < APPROACH_TIMEOUT_TICKS
      ) {
        await bot.waitForTicks(1);
      }
    } finally {
      bot.setControlState("forward", false);
    }
    await bot.waitForTicks(2);

    const approachEndPos = bot.entity.position.clone();
    episodeInstance._evalMetadata.approach_end_position = {
      x: approachEndPos.x,
      y: approachEndPos.y,
      z: approachEndPos.z,
    };
    console.log(
      `[${bot.username}] approach done at (${approachEndPos.x.toFixed(2)}, ${approachEndPos.z.toFixed(
        2,
      )}), ${xzDistance(approachEndPos, markerPos).toFixed(2)} blocks from midpoint`,
    );

    // Re-face the other bot before the co-movement handshake so both bots
    // enter the move phase already oriented and move simultaneously.
    const otherEntity = bot.players[peerName]?.entity;
    const refacePos = otherEntity
      ? otherEntity.position
      : new Vec3(markerPos.x, approachEndPos.y, markerPos.z); // midpoint is on the same line
    await lookAtSmooth(bot, refacePos, CAMERA_SPEED_DEGREES_PER_SEC, {
      randomized: false,
      useEasing: false,
    });

    coordinator.exchangeWithPeers(
      "coMovementPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      getOnCoMovementPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        episodeInstance,
        args,
        direction,
      ),
      { location: "coMovementApproachPhase end" },
    );
  };
}

function getOnCoMovementPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
  direction,
) {
  return async (peerMap) => {
    coordinator.broadcastToPeers(
      "coMovementPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      "coMovementPhase beginning",
    );

    // Both bots are already facing each other; a fixed-length freeze keeps the
    // moves simultaneous and separates the approach from the co-movement.
    await bot.waitForTicks(FREEZE_TICKS);

    console.log(`[${bot.username}] moving ${direction}`);

    const moveDistance = MOVE_XZ_DISTANCE_FOR[direction];
    const moveStartPos = bot.entity.position.clone();
    const moveStartTick = bot.time.age;
    bot.setControlState(direction, true);
    try {
      while (
        xzDistance(bot.entity.position, moveStartPos) < moveDistance &&
        bot.time.age - moveStartTick < MOVE_TIMEOUT_TICKS
      ) {
        await bot.waitForTicks(1);
      }
    } finally {
      bot.setControlState(direction, false);
    }
    await bot.waitForTicks(2);

    const moveEndPos = bot.entity.position.clone();
    episodeInstance._evalMetadata.move_end_position = {
      x: moveEndPos.x,
      y: moveEndPos.y,
      z: moveEndPos.z,
    };
    console.log(
      `[${bot.username}] move done, travelled ${xzDistance(
        moveEndPos,
        moveStartPos,
      ).toFixed(2)} blocks ${direction}`,
    );

    // Ensure minimum episode length measured from the start-of-eval sneak
    const startTick = episodeInstance._evalStartTick;
    const endTick = bot.time.age;
    const remainingTicks = EPISODE_MIN_TICKS - (endTick - startTick);
    if (remainingTicks > 0) {
      console.log(
        `[${bot.username}] waiting ${remainingTicks} more ticks to reach ${EPISODE_MIN_TICKS} total ticks`,
      );
      await bot.waitForTicks(remainingTicks);
    } else {
      console.log(
        `[${bot.username}] already passed ${EPISODE_MIN_TICKS} ticks (elapsed: ${endTick - startTick})`,
      );
    }

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
      { location: "coMovementPhase end" },
    );
  };
}

/**
 * Eval episode for co-movement: two bots line up on a principal axis, walk
 * toward the shared midpoint, hold still, then both move at the same time in the
 * same egocentric direction (by episode number). They face each other, so they
 * move in opposite world directions and always move relative to each other.
 * @extends BaseEpisode
 */
class CoMovementAlwaysRelativeMotionEvalEpisode extends BaseEpisode {
  static WORKS_IN_NON_FLAT_WORLD = true;
  // Far enough that each bot still walks a judgable distance (~3-5 blocks)
  // before reaching its stop point.
  static INIT_MIN_BOTS_DISTANCE = 14;
  static INIT_MAX_BOTS_DISTANCE = 18;

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
    const otherBotPosition = peerPositionsMap.values().next().value;
    const isAlpha = bot.username < coordinator.getSinglePeerName();
    const alphaPos = isAlpha ? botPosition : otherBotPosition;
    const bravoPos = isAlpha ? otherBotPosition : botPosition;

    // Line the bots up along a principal axis: keep alpha in place and teleport
    // bravo so both share the other coordinate, preserving the current distance.
    // Both bots compute the same plan from the exchanged positions; only bravo
    // teleports itself.
    const { orientation, axis, sign } = lineupPlan(
      episodeNum,
      args.instance_id,
    );
    this._lineupAxis = axis;
    this._lineupOrientation = orientation;
    this._lineupSign = sign;

    const dist = xzDistance(alphaPos, bravoPos);
    let bravoTargetX, bravoTargetZ;
    if (axis === "x") {
      bravoTargetX = alphaPos.x + sign * dist;
      bravoTargetZ = alphaPos.z;
    } else {
      bravoTargetX = alphaPos.x;
      bravoTargetZ = alphaPos.z + sign * dist;
    }
    const scanTop = Math.floor(Math.max(alphaPos.y, bravoPos.y)) + 2;
    const bravoTargetY =
      findSurfaceY(
        bot,
        Math.floor(bravoTargetX),
        Math.floor(bravoTargetZ),
        scanTop,
      ) || Math.floor(alphaPos.y);

    if (!isAlpha) {
      const tpRes = await rcon.send(
        `tp ${bot.username} ${bravoTargetX.toFixed(2)} ${bravoTargetY} ${bravoTargetZ.toFixed(2)}`,
      );
      console.log(
        `[${bot.username}] aligned to ${axis} axis (orientation ${orientation}) at ` +
          `(${bravoTargetX.toFixed(2)}, ${bravoTargetY}, ${bravoTargetZ.toFixed(2)}), result: ${tpRes}`,
      );
      await bot.waitForTicks(10);
    }

    const alphaNew = new Vec3(alphaPos.x, alphaPos.y, alphaPos.z);
    const bravoNew = new Vec3(bravoTargetX, bravoTargetY, bravoTargetZ);

    // Midpoint of the (now axis-aligned) pair; both bots walk toward it.
    const midX = Math.floor((alphaNew.x + bravoNew.x) / 2);
    const midZ = Math.floor((alphaNew.z + bravoNew.z) / 2);
    let markerY = findSurfaceY(bot, midX, midZ, scanTop);
    if (markerY === null) {
      markerY = Math.floor(alphaPos.y);
      console.log(
        `[${bot.username}] could not find ground at midpoint, defaulting y to ${markerY}`,
      );
    }
    this._markerPos = new Vec3(midX, markerY, midZ);

    return isAlpha ? bravoNew : alphaNew;
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
      "coMovementApproachPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      getOnApproachPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        this,
        args,
      ),
      { location: "entryPoint end" },
    );
  }
}

module.exports = {
  movementCase,
  lineupPlan,
  CoMovementAlwaysRelativeMotionEvalEpisode,
};
