const { Vec3 } = require("vec3");
const {
  gotoWithTimeout,
  initializePathfinder,
  lookAtSmooth,
  sneak,
  stopAll,
} = require("../../primitives/movement");
const { GoalXZ } = require("../../utils/bot-factory");
const { rconTp } = require("../../utils/coordination");
const { sleep } = require("../../utils/helpers");
const {
  hideNameTags,
  restoreNameTags,
} = require("../../utils/name-tag-visibility");
const { BaseEpisode } = require("../base-episode");

const CAMERA_SPEED_DEGREES_PER_SEC = 30;
const EPISODE_MIN_TICKS = 300;
const WALL_WIDTH = 9;
const WALL_HEIGHT = 3;
const WAYPOINT_TIMEOUT_MS = 8000;

function getOnWallWalkPhaseFn(
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
      "wallWalkPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      "wallWalkPhase beginning",
    );

    const isWalker = episodeInstance._isWalker;
    const wallAxis = episodeInstance._wallAxis;
    const wallCenter = episodeInstance._wallCenter;
    const goLeft = episodeInstance._goLeft;

    // Sneak to signal evaluation start
    await sneak(bot);
    const startTick = bot.time.age;

    if (isWalker) {
      // Walker: navigate around the wall via 2 waypoints
      const halfWidth = Math.floor(WALL_WIDTH / 2);
      const cx = wallCenter.x + 0.5;
      const cz = wallCenter.z + 0.5;
      const walkerDist = 5.5;
      const crossDist = 1.5; // stop ~1 block past the wall

      let wp1x, wp1z, wp2x, wp2z;

      if (wallAxis === "x") {
        // Wall along X, bots separated along Z
        // Walker starts at (cx, cz + side*walkerDist)
        const walkerSide = episodeInstance._walkerSide; // +1 or -1 along Z
        const edgeOffset = goLeft ? -(halfWidth + 2) : halfWidth + 2;

        // WP1: past the wall edge, same Z as start
        wp1x = cx + edgeOffset;
        wp1z = cz + walkerSide * walkerDist;
        // WP2: same X as WP1, cross to other side of wall
        wp2x = cx + edgeOffset;
        wp2z = cz - walkerSide * crossDist;
      } else {
        // Wall along Z, bots separated along X
        const walkerSide = episodeInstance._walkerSide; // +1 or -1 along X
        const edgeOffset = goLeft ? -(halfWidth + 2) : halfWidth + 2;

        // WP1: past the wall edge, same X as start
        wp1x = cx + walkerSide * walkerDist;
        wp1z = cz + edgeOffset;
        // WP2: same Z as WP1, cross to other side of wall
        wp2x = cx - walkerSide * crossDist;
        wp2z = cz + edgeOffset;
      }

      const waypoints = [
        { x: wp1x, z: wp1z, label: "WP1 (past edge)" },
        { x: wp2x, z: wp2z, label: "WP2 (cross sides)" },
      ];

      initializePathfinder(bot, { allowSprinting: false });

      for (const wp of waypoints) {
        console.log(
          `[${bot.username}] Walking to ${wp.label}: (${wp.x.toFixed(1)}, ${wp.z.toFixed(1)})`,
        );
        try {
          await gotoWithTimeout(bot, new GoalXZ(wp.x, wp.z), {
            timeoutMs: WAYPOINT_TIMEOUT_MS,
          });
        } catch (err) {
          console.log(
            `[${bot.username}] Waypoint ${wp.label} timeout/error: ${err?.message || err}`,
          );
        }
        await bot.waitForTicks(5);
      }

      stopAll(bot);

      // Turn to face observer
      const otherEntity = bot.players[peerName]?.entity;
      const currentOtherPos = otherEntity
        ? otherEntity.position
        : otherBotPosition;
      await lookAtSmooth(bot, currentOtherPos, CAMERA_SPEED_DEGREES_PER_SEC, {
        randomized: false,
        useEasing: false,
      });
    } else {
      // Observer: stand still, keep spawn orientation (facing wall)
    }

    // Wait for minimum ticks
    const endTick = bot.time.age;
    const remaining = EPISODE_MIN_TICKS - (endTick - startTick);
    if (remaining > 0) {
      console.log(
        `[${bot.username}] Waiting ${remaining} more ticks to reach ${EPISODE_MIN_TICKS}`,
      );
      await bot.waitForTicks(remaining);
    }

    // Setup stop phase
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
      { location: "wallWalkPhase end" },
    );
  };
}

/**
 * Eval episode where a wall spawns between bots: one bot (walker) navigates
 * around the wall via waypoints to the other side, while the other bot
 * (observer) stands still.
 * @extends BaseEpisode
 */
class WallWalkEvalEpisode extends BaseEpisode {
  static WORKS_IN_NON_FLAT_WORLD = false;
  static INIT_MIN_BOTS_DISTANCE = 14;
  static INIT_MAX_BOTS_DISTANCE = 14;

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
    const peerName = coordinator.getSinglePeerName();
    const otherBotPosition = peerPositionsMap.values().next().value;
    // Only the lead bot (alphabetically first) places the wall
    const isLeadBot = bot.username < peerName;

    // Use sharedBotRng to decide walker/observer (same result for both bots)
    const walkerIsLead = sharedBotRng() < 0.5;
    this._isWalker = walkerIsLead === isLeadBot;

    // Use sharedBotRng to pick which side of the wall to walk around
    this._goLeft = sharedBotRng() < 0.5;

    // Calculate midpoint between bots
    const midX = (botPosition.x + otherBotPosition.x) / 2;
    const midY = botPosition.y;
    const midZ = (botPosition.z + otherBotPosition.z) / 2;

    // Determine wall orientation: perpendicular to the connecting line,
    // axis-aligned to nearest cardinal direction
    const dx = otherBotPosition.x - botPosition.x;
    const dz = otherBotPosition.z - botPosition.z;

    // If |dx| > |dz|, bots are primarily separated along X,
    // so wall should be along Z axis (perpendicular to X).
    // Otherwise wall should be along X axis.
    const wallAxis = Math.abs(dx) > Math.abs(dz) ? "z" : "x";

    const wallCenterX = Math.floor(midX);
    const wallCenterY = Math.floor(midY);
    const wallCenterZ = Math.floor(midZ);

    // Store wall info for phase handler and teardown
    this._wallCenter = new Vec3(wallCenterX, wallCenterY, wallCenterZ);
    this._wallAxis = wallAxis;
    this._isLeadBot = isLeadBot;

    // Calculate fill coordinates
    const halfWidth = Math.floor(WALL_WIDTH / 2);
    let x1, y1, z1, x2, y2, z2;

    if (wallAxis === "x") {
      // Wall extends along X axis
      x1 = wallCenterX - halfWidth;
      z1 = wallCenterZ;
      x2 = wallCenterX + halfWidth;
      z2 = wallCenterZ;
    } else {
      // Wall extends along Z axis
      x1 = wallCenterX;
      z1 = wallCenterZ - halfWidth;
      x2 = wallCenterX;
      z2 = wallCenterZ + halfWidth;
    }

    y1 = wallCenterY;
    y2 = wallCenterY + WALL_HEIGHT - 1;

    // Store fill coordinates for teardown
    this._fillCoords = { x1, y1, z1, x2, y2, z2 };

    if (isLeadBot) {
      console.log(
        `[${bot.username}] Placing ${WALL_WIDTH}x${WALL_HEIGHT} wall at (${x1},${y1},${z1}) to (${x2},${y2},${z2})`,
      );
      const fillCmd = `fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} stone`;
      const fillRes = await rcon.send(fillCmd);
      console.log(`[${bot.username}] Wall fill result: ${fillRes}`);

      // Hide name tags so the wall genuinely occludes the observer.
      // Without this the floating tag renders through the wall.
      await hideNameTags(rcon, coordinator.getAllPlayerNames());
    }

    this._evalMetadata = {
      wall_width: WALL_WIDTH,
      wall_height: WALL_HEIGHT,
      wall_center: { x: wallCenterX, y: wallCenterY, z: wallCenterZ },
      wall_axis: wallAxis,
      role: this._isWalker ? "walker" : "observer",
      walk_direction: this._goLeft ? "left" : "right",
    };

    // Place bots in a straight line through wall center
    // Walker: 5 blocks from wall surface, Observer: 7 blocks from wall surface
    const walkerDist = 5.5; // 5 blocks + 0.5 to wall block center
    const observerDist = 7.5; // 7 blocks + 0.5 to wall block center
    const cx = wallCenterX + 0.5; // center of the wall block
    const cz = wallCenterZ + 0.5;
    let botPosNew, otherPosNew;

    // Each bot gets its own distance based on role
    const botDist = this._isWalker ? walkerDist : observerDist;
    const otherDist = this._isWalker ? observerDist : walkerDist;

    if (wallAxis === "x") {
      // Wall along X → bots separated along Z, both at wall center X
      const botSide = botPosition.z < midZ ? -1 : 1;
      botPosNew = new Vec3(cx, botPosition.y, cz + botSide * botDist);
      otherPosNew = new Vec3(cx, otherBotPosition.y, cz - botSide * otherDist);
      // Store walker's side for waypoint calculation
      this._walkerSide = this._isWalker ? botSide : -botSide;
    } else {
      // Wall along Z → bots separated along X, both at wall center Z
      const botSide = botPosition.x < midX ? -1 : 1;
      botPosNew = new Vec3(cx + botSide * botDist, botPosition.y, cz);
      otherPosNew = new Vec3(cx - botSide * otherDist, otherBotPosition.y, cz);
      // Store walker's side for waypoint calculation
      this._walkerSide = this._isWalker ? botSide : -botSide;
    }

    console.log(
      `[${bot.username}] Role: ${this._isWalker ? "WALKER" : "OBSERVER"}, direction: ${this._goLeft ? "left" : "right"}`,
    );

    // Teleport this bot to its new position and wait for server to update
    await rconTp(rcon, bot.username, botPosNew.x, botPosNew.y, botPosNew.z);
    await sleep(1000);

    return otherPosNew;
  }

  async tearDownEpisode(bot, rcon, sharedBotRng, coordinator, episodeNum, args) {
    // Only the lead bot removes the wall and restores name tags
    if (this._isLeadBot && this._fillCoords) {
      const { x1, y1, z1, x2, y2, z2 } = this._fillCoords;
      console.log(
        `[${bot.username}] Removing wall at (${x1},${y1},${z1}) to (${x2},${y2},${z2})`,
      );
      const clearCmd = `fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} air`;
      try {
        const clearRes = await rcon.send(clearCmd);
        console.log(`[${bot.username}] Wall clear result: ${clearRes}`);
      } catch (err) {
        console.error(`[${bot.username}] Failed to clear wall:`, err);
      }
      await restoreNameTags(rcon);
    }
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
      "wallWalkPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      getOnWallWalkPhaseFn(
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

module.exports = { WallWalkEvalEpisode };
