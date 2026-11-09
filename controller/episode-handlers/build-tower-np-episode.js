const { Vec3 } = require("vec3");
const { ensureBotHasEnough, unequipHand } = require("../primitives/items");
const { buildTowerUnderneath } = require("../primitives/building");
const { lookAtSmooth, sleep } = require("../primitives/movement");
const { BaseEpisode } = require("./base-episode");

const INITIAL_EYE_CONTACT_MS = 1500;
const FINAL_EYE_CONTACT_MS = 1500;
const CAMERA_SPEED_DEGREES_PER_SEC = 60;
// Slowest eased 180° turn at 0.4x randomized speed is ~9.4 s; bound the post-build turn above that.
const FINAL_LOOK_TIMEOUT_MS = 15000;
const MIN_TOWER_HEIGHT = 8;
const MAX_TOWER_HEIGHT = 12;
const TOWER_BLOCK_TYPE = "oak_planks";
// Pass peer FEET (not eye) as the look-at target: lookAtSmooth uses bot feet as the
// rotation source, so feet-to-feet and eye-to-eye produce the same pitch. Adding a
// 1.62 (or 1.8) offset would tilt the gaze upward by ~9° at ~10-block distance.

function getCentroid(positions) {
  const totals = positions.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }),
    { x: 0, y: 0, z: 0 },
  );
  return new Vec3(
    totals.x / positions.length,
    totals.y / positions.length,
    totals.z / positions.length,
  );
}

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
    coordinator.broadcastToPeers(
      `buildTowerPhase_${iterationID}`,
      { position: bot.entity.position.clone() },
      episodeNum,
      `buildTowerPhase_${iterationID} beginning`,
    );

    console.log(
      `[${bot.username}] 🚀 Starting BUILD TOWER phase ${iterationID}`,
    );

    const peerPositions = [...peerMap.values()].map((v) => v.position);
    const peerCentroid = getCentroid(peerPositions);

    console.log(
      `[${bot.username}] 👀 Initial eye contact with peer centroid...`,
    );
    try {
      await lookAtSmooth(bot, peerCentroid, CAMERA_SPEED_DEGREES_PER_SEC);
      await sleep(INITIAL_EYE_CONTACT_MS);
    } catch (lookError) {
      console.log(
        `[${bot.username}] ⚠️ Could not look at peer centroid: ${lookError.message}`,
      );
    }

    // Barrier so all bots start placing blocks at the same wall-clock moment —
    // lookAtSmooth duration varies with initial yaw/pitch and would otherwise skew starts.
    await coordinator.syncAllPeers(
      `buildTowerStart_${iterationID}`,
      {},
      episodeNum,
      { location: `buildTowerPhase_${iterationID} build-start barrier` },
    );

    const towerHeight =
      MIN_TOWER_HEIGHT +
      Math.floor(sharedBotRng() * (MAX_TOWER_HEIGHT - MIN_TOWER_HEIGHT + 1));
    console.log(`[${bot.username}] 📏 Tower height: ${towerHeight} blocks`);

    const buildResult = await buildTowerUnderneath(bot, towerHeight, args, {
      blockType: TOWER_BLOCK_TYPE,
      breakOnFailure: true,
      enableRetry: false,
    });

    // Barrier so all bots gaze together after their (possibly different-height) towers finish.
    await coordinator.syncAllPeers(
      `buildTowerEnd_${iterationID}`,
      {},
      episodeNum,
      { location: `buildTowerPhase_${iterationID} build-end barrier` },
    );

    // Recompute the centroid from live peer feet so the final gaze points at peers
    // currently on top of their towers rather than the stale ground positions in peerMap.
    const peerNames = coordinator
      .getAllPlayerNames()
      .filter((n) => n !== bot.username);
    const livePeerPositions = [];
    for (const name of peerNames) {
      const e = bot.players[name]?.entity;
      if (e) livePeerPositions.push(e.position);
    }
    const finalTarget =
      livePeerPositions.length > 0
        ? getCentroid(livePeerPositions)
        : peerCentroid;

    console.log(`[${bot.username}] 👀 Final eye contact...`);
    try {
      // Leftover place attempts from the tower build can leave the eased look unresolved forever.
      await Promise.race([
        lookAtSmooth(bot, finalTarget, CAMERA_SPEED_DEGREES_PER_SEC),
        sleep(FINAL_LOOK_TIMEOUT_MS),
      ]);
      await sleep(FINAL_EYE_CONTACT_MS);
    } catch (lookError) {
      console.log(
        `[${bot.username}] ⚠️ Could not look at peer centroid: ${lookError.message}`,
      );
    }

    console.log(
      `[${bot.username}] 📊 Final stats: ${buildResult.success}/${towerHeight} blocks placed`,
    );

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
 * N-player tower-build episode. Each bot builds its own tower of random height at its spawn
 * position, looking at the peer centroid for initial and final eye contact.
 * @extends BaseEpisode
 */
class BuildTowerNpEpisode extends BaseEpisode {
  static INIT_MIN_BOTS_DISTANCE = 8;
  static INIT_MAX_BOTS_DISTANCE = 15;
  static WORKS_IN_NON_FLAT_WORLD = true;
  static SUPPORTS_N_PLAYER = true;

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
    // optional teardown
  }
}

module.exports = { BuildTowerNpEpisode };
