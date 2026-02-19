const fs = require("fs/promises");
const path = require("path");

const mineflayerViewerhl = require("prismarine-viewer-colalab").headless;
const { Rcon } = require("rcon-client");
const seedrandom = require("seedrandom");

const { sleep } = require("./utils/helpers");
const { waitForCameras } = require("./utils/camera-ready");
const { DEFAULT_CAMERA_SPEED_DEGREES_PER_SEC } = require("./utils/constants");
const {
  directTeleport,
  lookAtSmooth,
  stopAll,
} = require("./primitives/movement");
const { ensureBotHasEnough, unequipHand } = require("./primitives/items");
const { selectWeightedEpisodeType } = require("./utils/episode-weights");

// Import episode classes
const {
  StraightLineEpisode,
} = require("./episode-handlers/straight-line-episode");
const { ChaseEpisode } = require("./episode-handlers/chase-episode");
const { OrbitEpisode } = require("./episode-handlers/orbit-episode");
const { WalkLookEpisode } = require("./episode-handlers/walk-look-episode");
const {
  WalkLookAwayEpisode,
} = require("./episode-handlers/walk-look-away-episode");
const { PvpEpisode } = require("./episode-handlers/pvp-episode");
const {
  BuildStructureEpisode,
} = require("./episode-handlers/build-structure-episode");
const { BuildTowerEpisode } = require("./episode-handlers/build-tower-episode");
const { MineEpisode } = require("./episode-handlers/mine-episode");
const { PveEpisode } = require("./episode-handlers/pve-episode");
const {
  TowerBridgeEpisode,
} = require("./episode-handlers/tower-bridge-episode");
const { BuildHouseEpisode } = require("./episode-handlers/build-house-episode");
const { CollectorEpisode } = require("./episode-handlers/collector-episode");
const {
  PlaceAndMineEpisode,
} = require("./episode-handlers/place-and-mine-episode");
const {
  StructureEvalEpisode,
} = require("./episode-handlers/eval/structure-eval-episode");
const {
  TranslationEvalEpisode,
} = require("./episode-handlers/eval/translation-eval-episode");
const {
  BothLookAwayEvalEpisode,
} = require("./episode-handlers/eval/both-look-away-eval-episode");
const {
  OneLooksAwayEvalEpisode,
} = require("./episode-handlers/eval/one-looks-away-eval-episode");
const {
  RotationEvalEpisode,
} = require("./episode-handlers/eval/rotation-eval-episode");
const {
  TurnToLookEvalEpisode,
} = require("./episode-handlers/eval/turn-to-look-eval-episode");
const {
  TurnToLookOppositeEvalEpisode,
} = require("./episode-handlers/eval/turn-to-look-opposite-eval-episode");
const turnToLookEvalTpPoints = require("./episode-handlers/eval/turn-to-look-eval-episode-tp-points.json");

/**
 * Map of episode type string keys to their episode class constructors.
 * Used to instantiate episodes by type name (e.g. from config or env).
 * @type {Object<string, typeof import('./episode-handlers/base-episode').BaseEpisode>}
 */
const episodeClassMap = {
  straightLineWalk: StraightLineEpisode,
  chase: ChaseEpisode,
  orbit: OrbitEpisode,
  walkLook: WalkLookEpisode,
  walkLookAway: WalkLookAwayEpisode,
  pvp: PvpEpisode,
  pve: PveEpisode,
  buildStructure: BuildStructureEpisode,
  buildTower: BuildTowerEpisode,
  mine: MineEpisode,
  towerBridge: TowerBridgeEpisode,
  buildHouse: BuildHouseEpisode,
  collector: CollectorEpisode,
  placeAndMine: PlaceAndMineEpisode,
  // Eval episodes:
  structureEval: StructureEvalEpisode,
  translationEval: TranslationEvalEpisode,
  bothLookAwayEval: BothLookAwayEvalEpisode,
  oneLooksAwayEval: OneLooksAwayEvalEpisode,
  rotationEval: RotationEvalEpisode,
  turnToLookEval: TurnToLookEvalEpisode,
  turnToLookOppositeEval: TurnToLookOppositeEvalEpisode,
};

/**
 * Array of eval episode classes used to detect whether an episode instance
 * is an eval episode (e.g. in {@link isEvalEpisode}).
 * @type {Array<typeof import('./episode-handlers/base-episode').BaseEpisode>}
 */
const evalEpisodeClasses = [
  StructureEvalEpisode,
  TranslationEvalEpisode,
  BothLookAwayEvalEpisode,
  OneLooksAwayEvalEpisode,
  RotationEvalEpisode,
  TurnToLookEvalEpisode,
  TurnToLookOppositeEvalEpisode,
];

/**
 * Check if an episode instance is an eval episode
 * @param {Object} episodeInstance - Episode instance to check
 * @returns {boolean} True if the episode is an eval episode
 */
function isEvalEpisode(episodeInstance) {
  return evalEpisodeClasses.some(
    (EvalClass) => episodeInstance instanceof EvalClass,
  );
}

// Import episode-specific handlers

/**
 * Default list of episode type keys to run when EPISODE_TYPES is not set.
 * Each string must be a key of {@link episodeClassMap}.
 * @type {string[]}
 */
const defaultEpisodeTypes = [
  "straightLineWalk",
  "chase",
  "orbit",
  "walkLook",
  "buildHouse",
  "walkLookAway",
  "pvp",
  "pve",
  "buildStructure",
  "buildTower",
  "mine",
  "towerBridge",
  "collector",
  "placeAndMine",
  "structureEval",
  "translationEval",
  "bothLookAwayEval",
  "oneLooksAwayEval",
  "rotationEval",
  "turnToLookEval",
  "turnToLookOppositeEval",
];

const isCustomEpisodeTypes =
  process.env.EPISODE_TYPES && process.env.EPISODE_TYPES !== "all";
// Load episode types from environment variable or use default
const episodeTypes = isCustomEpisodeTypes
  ? process.env.EPISODE_TYPES.split(",").map((type) => type.trim())
  : defaultEpisodeTypes;

function formatDateForFilename(date) {
  /**
   * Left-pad a value with zeros.
   * @param {number|string} value - Value to pad.
   * @param {number} [length=2] - Target width.
   * @returns {string} Padded string.
   */
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(
    date.getDate(),
  )}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Persist per-episode metadata to disk (one JSON file per episode).
 *
 * @param {Object} params - Parameters bag.
 * @param {Object} params.args - CLI/config args. Must include `output_dir` and `bot_name`.
 * @param {*} params.bot - Mineflayer bot instance.
 * @param {*} params.episodeInstance - Episode instance (used for error/eval flags).
 * @param {number} params.episodeNum - Episode number.
 * @param {string} params.episodeType - Episode type key.
 * @returns {Promise<void>} Resolves once the file is written.
 */
async function saveEpisodeInfo({
  args,
  bot,
  episodeInstance,
  episodeNum,
  episodeType,
}) {
  const now = new Date();
  const formattedTimestamp = formatDateForFilename(now);
  const episodeNumStr = String(episodeNum).padStart(6, "0");
  const instanceId = args.instance_id ?? 0;
  const instanceIdStr = String(instanceId).padStart(3, "0");
  const botName = args.bot_name;
  const outputDir = args.output_dir;

  await fs.mkdir(outputDir, { recursive: true });

  const baseFileName = `${formattedTimestamp}_${episodeNumStr}_${botName}_instance_${instanceIdStr}_episode_info`;
  const filePath = path.join(outputDir, `${baseFileName}.json`);

  const payload = {
    timestamp: now.toISOString(),
    bot_name: botName,
    world_type: args.world_type,
    episode_number: episodeNum,
    episode_type: episodeType,
    instance_id: instanceId,
    encountered_error: Boolean(episodeInstance?._encounteredError),
    peer_encountered_error: Boolean(episodeInstance?._peerError),
    bot_died: Boolean(episodeInstance?._botDied),
    episode_recording_started: Boolean(
      episodeInstance?._episodeRecordingStarted,
    ),
    eval_metadata: episodeInstance?._evalMetadata || {},
  };

  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
  console.log(
    `[${bot.username}] Saved episode info to ${filePath} (encountered_error=${payload.encountered_error}, peer_encountered_error=${payload.peer_encountered_error}, bot_died=${payload.bot_died})`,
  );
}

/**
 * Run a single episode
 * @param {*} bot - Mineflayer bot instance
 * @param {*} rcon - RCON connection instance
 * @param {Function} sharedBotRng - Shared random number generator
 * @param {*} coordinator - Bot coordinator instance
 * @param {number} episodeNum - Episode number
 * @param {*} episodeInstance - Episode instance for this run
 * @param {Object} args - Configuration arguments
 * @returns {Promise<Function>} Resolves with a cleanup function for episode-scoped handlers.
 */
async function runSingleEpisode(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
) {
  console.log(`[${bot.username}] Starting episode ${episodeNum}`);

  episodeInstance._botDied = false;
  episodeInstance._episodeRecordingStarted = false;

  return new Promise((resolve) => {
    // Reset episode stopping guard at the start of each episode
    bot._episodeStopping = false;

    // Episode-scoped error handler that captures this episode number
    let episodeErrorHandled = false;

    /**
     * Handle any episode-scoped error (unhandled rejection/exception).
     *
     * Captures the episode number and ensures we only perform the stop/notify
     * sequence once per episode.
     *
     * @param {unknown} err - Error value.
     * @returns {Promise<void>} Resolves once peer has been notified and stop initiated.
     */
    const handleAnyError = async (err) => {
      if (episodeErrorHandled) {
        console.log(
          `[${bot.username}] Episode ${episodeNum} error already handled, skipping.`,
        );
        return;
      }
      episodeErrorHandled = true;
      episodeInstance._encounteredError = true;
      await notifyPeerErrorAndStop(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        episodeInstance,
        args,
        err,
      );
    };

    /**
     * Mark that the bot died during this episode.
     * @returns {void}
     */
    const handleBotDeath = () => {
      console.warn(
        `[${bot.username}] Episode ${episodeNum} detected bot death`,
      );
      episodeInstance._botDied = true;
    };

    /**
     * Remove all episode-scoped handlers/listeners.
     * @returns {void}
     */
    const cleanupEpisodeScopedHandlers = () => {
      process.removeListener("unhandledRejection", handleAnyError);
      process.removeListener("unhandledException", handleAnyError);
      bot.removeListener("death", handleBotDeath);
    };
    process.on("unhandledRejection", handleAnyError);
    process.on("unhandledException", handleAnyError);
    bot.once("death", handleBotDeath);

    // Ensure we clean up episode-scoped handlers when the episode resolves
    // Return the cleanup function to the caller so it can be invoked
    // after all pending phase handlers finish.
    /**
     * Resolve the episode promise with the cleanup function.
     * @returns {void}
     */
    bot._currentEpisodeResolve = () => {
      resolve(cleanupEpisodeScopedHandlers);
    };

    const { x, y, z } = bot.entity.position;
    console.log(
      `[${bot.username}] episode ${episodeNum} at (${x.toFixed(2)}, ${y.toFixed(
        2,
      )}, ${z.toFixed(2)})`,
    );

    coordinator.onceEvent(
      `peerErrorPhase_${episodeNum}`,
      episodeNum,
      getOnPeerErrorPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        episodeInstance,
        args,
      ),
    );
    const phaseDataOur = {
      position: bot.entity.position.clone(),
    };

    coordinator.onceEvent(
      "teleportPhase",
      episodeNum,
      getOnTeleportPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        episodeInstance,
        args,
        phaseDataOur,
      ),
    );
    coordinator.sendToOtherBot(
      "teleportPhase",
      phaseDataOur,
      episodeNum,
      "spawnPhase end",
    );
  });
}

/**
 * Notify the peer bot of an episode error and initiate the stop phase locally.
 *
 * @param {*} bot - Mineflayer bot instance.
 * @param {*} rcon - RCON connection instance.
 * @param {Function} sharedBotRng - Shared RNG instance.
 * @param {*} coordinator - Bot coordinator instance.
 * @param {number} episodeNum - Episode number.
 * @param {*} episodeInstance - Episode instance.
 * @param {Object} args - Configuration args.
 * @param {unknown} error - Error value.
 * @returns {Promise<void>} Resolves when peer is notified and stop is scheduled.
 */
async function notifyPeerErrorAndStop(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
  error,
) {
  const reason = error && error.message ? error.message : String(error);
  console.error(
    `[${bot.username}] Episode ${episodeNum} encountered an error:`,
    error,
  );
  coordinator.sendToOtherBot(
    `peerErrorPhase_${episodeNum}`,
    { reason },
    episodeNum,
    "error notifier",
  );
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
    `error notifier end`,
  );
  // Initiate our own stop sequence
}

/**
 * Setup bot protection effects and world rules (called once per bot)
 * @param {*} bot - Mineflayer bot instance
 * @param {*} rcon - RCON connection instance
 */
async function setupBotAndWorldOnce(bot, rcon) {
  const resistEffectRes = await rcon.send(
    `effect give ${bot.username} minecraft:resistance 999999 255 true`,
  );
  console.log(`[${bot.username}] resistEffectRes=${resistEffectRes}`);
  const waterBreathingEffectRes = await rcon.send(
    `effect give ${bot.username} minecraft:water_breathing 999999 0 true`,
  );
  console.log(
    `[${bot.username}] waterBreathingEffectRes=${waterBreathingEffectRes}`,
  );
  const fallDamageRes = await rcon.send(
    `attribute ${bot.username} minecraft:fall_damage_multiplier base set 0`,
  );
  console.log(`[${bot.username}] fallDamageRes=${fallDamageRes}`);
  const difficultyRes = await rcon.send("difficulty peaceful"); // or hard
  console.log(
    `[${bot.username}] set difficulty to peaceful, difficultyRes=${difficultyRes}`,
  );
  const fallDamageGameruleRes = await rcon.send("gamerule fallDamage false");
  console.log(
    `[${bot.username}] set fallDamage gamerule to false, fallDamageGameruleRes=${fallDamageGameruleRes}`,
  );
  const doImmediateRespawnRes = await rcon.send(
    "gamerule doImmediateRespawn true",
  );
  console.log(
    `[${bot.username}] set doImmediateRespawn gamerule to true, doImmediateRespawnRes=${doImmediateRespawnRes}`,
  );
  const keepInventoryRes = await rcon.send("gamerule keepInventory true");
  console.log(
    `[${bot.username}] set keepInventory gamerule to true, keepInventoryRes=${keepInventoryRes}`,
  );
  const showDeathMessagesRes = await rcon.send(
    "gamerule showDeathMessages false",
  );
  console.log(
    `[${bot.username}] set showDeathMessages gamerule to false, showDeathMessagesRes=${showDeathMessagesRes}`,
  );
  const tagResult = await rcon.send(`tag ${bot.username} add minebot`);
  console.log(
    `[${bot.username}] tag ${bot.username} add minebot result: ${tagResult}`,
  );
}

/**
 * Setup camera player protection effects (called once per camera)
 * @param {*} bot - Mineflayer bot instance (used to derive camera username)
 * @param {*} rcon - RCON connection instance
 */
async function setupCameraPlayerOnce(bot, rcon) {
  const cameraUsername = `Camera${bot.username}`;
  const resistEffectResCamera = await rcon.send(
    `effect give ${cameraUsername} minecraft:resistance 999999 255 true`,
  );
  console.log(`[${cameraUsername}] resistEffectRes=${resistEffectResCamera}`);
  const waterBreathingEffectResCamera = await rcon.send(
    `effect give ${cameraUsername} minecraft:water_breathing 999999 0 true`,
  );
  console.log(
    `[${cameraUsername}] waterBreathingEffectRes=${waterBreathingEffectResCamera}`,
  );
  const fallDamageResCamera = await rcon.send(
    `attribute ${cameraUsername} minecraft:fall_damage_multiplier base set 0`,
  );
  console.log(`[${cameraUsername}] fallDamageRes=${fallDamageResCamera}`);
}

/**
 * Setup bot and camera saturation effects for each episode
 * @param {*} bot - Mineflayer bot instance
 * @param {*} rcon - RCON connection instance
 * @param {Object} args - Configuration arguments
 */
async function setupBotAndCameraForEpisode(bot, rcon, args) {
  const saturationEffectRes = await rcon.send(
    `effect give ${bot.username} minecraft:saturation 999999 255 true`,
  );
  console.log(`[${bot.username}] saturationEffectRes=${saturationEffectRes}`);
  if (args.enable_camera_wait) {
    const camRes = await rcon.send(
      `effect give Camera${bot.username} minecraft:saturation 999999 255 true`,
    );
    console.log(`[${bot.username}] Camera saturationEffectRes=${camRes}`);
  }
  await sleep(1000);
  console.log(`[${bot.username}] unequipping hand before episode`);
  await clearBotInventory(bot, rcon);
  await sleep(500);
  await ensureBotHasEnough(bot, rcon, "stone", 64);
  const givePickaxeRes = await rcon.send(
    `give ${bot.username} minecraft:diamond_pickaxe 1`,
  );
  console.log(`[${bot.username}] givePickaxeRes=${givePickaxeRes}`);
  const giveShovelRes = await rcon.send(
    `give ${bot.username} minecraft:diamond_shovel 1`,
  );
  console.log(`[${bot.username}] giveShovelRes=${giveShovelRes}`);
  const giveAxeRes = await rcon.send(
    `give ${bot.username} minecraft:diamond_axe 1`,
  );
  console.log(`[${bot.username}] giveAxeRes=${giveAxeRes}`);
  await unequipHand(bot);
}

/**
 * Clear all items from the bot's inventory.
 *
 * @param {*} bot - Mineflayer bot instance.
 * @param {*} rcon - RCON connection instance.
 * @returns {Promise<void>} Resolves when the `/clear` command completes.
 */
async function clearBotInventory(bot, rcon) {
  // /clear <name> with no item argument deletes ALL items
  const cmd = `clear ${bot.username}`;
  const response = await rcon.send(cmd);
  console.log(`[${bot.username}] clearBotInventory response: ${response}`);
}

/**
 * Get spawn phase handler function
 * @param {*} bot - Mineflayer bot instance
 * @param {string} host - Server host
 * @param {number} actRecorderPort - Act recorder port
 * @param {*} coordinator - Bot coordinator instance
 * @param {Object} args - Configuration arguments
 * @returns {Function} Spawn phase handler
 */
function getOnSpawnFn(bot, host, actRecorderPort, coordinator, args) {
  return async () => {
    bot.pathfinder.thinkTimeout = 7500; // max total planning time per path (ms)
    bot.pathfinder.tickTimeout = 15; // max CPU per tick spent "thinking" (ms)
    bot.pathfinder.searchRadius = 96; // don’t search beyond ~6 chunks from the bot
    bot.pathfinder.maxDropDown = 15;
    const rcon = await Rcon.connect({
      host: args.rcon_host,
      port: args.rcon_port,
      password: args.rcon_password,
      timeout: 10000, // increased from the 2000ms default
    });
    await setupBotAndWorldOnce(bot, rcon);

    // Wait for both connections to be established
    console.log("Setting up coordinator connections...");
    await coordinator.setupConnections();
    console.log(
      "All coordinator connections ready, proceeding with bot spawn...",
    );

    const { x, y, z } = bot.entity.position;
    console.log(
      `[${bot.username}] spawned at (${x.toFixed(2)}, ${y.toFixed(
        2,
      )}, ${z.toFixed(2)})`,
    );

    // Wait for both cameras to join before starting recording
    if (args.enable_camera_wait) {
      console.log(`[${bot.username}] Waiting for cameras to join server...`);
      const camerasReady = await waitForCameras(
        args.rcon_host,
        args.rcon_port,
        args.rcon_password,
        args.camera_ready_retries,
        args.camera_ready_check_interval,
      );

      if (!camerasReady) {
        console.error(
          `[${bot.username}] Cameras failed to join within timeout. Exiting.`,
        );
        process.exit(1);
      }
      // Give resistance to the camera bot paired with this bot, e.g., if Alpha then AlphaCamera
      await setupCameraPlayerOnce(bot, rcon);

      console.log(
        `[${bot.username}] Cameras detected, waiting ${args.bootstrap_wait_time}s for popups to clear...`,
      );
      await sleep(args.bootstrap_wait_time * 1000);
    }

    // Initialize viewer once for the entire program
    mineflayerViewerhl(bot, {
      output: `${host}:${actRecorderPort}`,
      width: 640,
      height: 360,
      frames: 400,
      disableRendering: args.viewer_rendering_disabled,
      interval: args.viewer_recording_interval,
    });
    // Run multiple episodes
    // Respect world type for eligible episode filtering
    const worldType = (args.world_type || "flat").toLowerCase();
    const isFlatWorld = worldType === "flat";
    const allEpisodeTypes = episodeTypes;
    const eligibleEpisodeTypesForWorld = isFlatWorld
      ? allEpisodeTypes
      : allEpisodeTypes.filter(
          (type) => episodeClassMap[type].WORKS_IN_NON_FLAT_WORLD === true,
        );

    if (!isFlatWorld && eligibleEpisodeTypesForWorld.length === 0) {
      throw new Error(
        "No episodes are eligible for normal world. Mark episode classes with WORKS_IN_NON_FLAT_WORLD = true.",
      );
    }
    const sortedEligible = eligibleEpisodeTypesForWorld.slice().sort();

    // In smoke test mode, iterate over all eligible episode types in alphabetical order
    let episodesToRun = [];
    if (args.smoke_test === 1) {
      // Cycle through eligible episode types until we reach episodes_num
      for (let i = 0; i < args.episodes_num; i++) {
        const episodeType = sortedEligible[i % sortedEligible.length];
        episodesToRun.push({
          episodeNum: args.start_episode_id + i,
          episodeType: episodeType,
        });
      }
      console.log(
        `[${bot.username}] SMOKE TEST MODE: Running ${episodesToRun.length} episodes cycling through ${sortedEligible.length} eligible episode types (world_type=${worldType}) in alphabetical order`,
      );
    } else {
      // Normal mode: use the configured episodes_num, episode type picked at random from eligible
      for (let i = 0; i < args.episodes_num; i++) {
        episodesToRun.push({
          episodeNum: args.start_episode_id + i,
          episodeType: null, // Will be randomly selected
        });
      }
    }

    for (const episodeConfig of episodesToRun) {
      const episodeNum = episodeConfig.episodeNum;
      const botsRngBaseSeed = args.bot_rng_seed;
      // Concatenate episodeNum to the seed string to get a unique, reproducible seed per episode
      const botsRngSeedWithEpisode = `${botsRngBaseSeed}_${episodeNum}`;
      const sharedBotRng = seedrandom(botsRngSeedWithEpisode);

      // Select episode type (weighted by inverse sqrt of typical length)
      const selectedEpisodeType =
        args.smoke_test === 1
          ? episodeConfig.episodeType
          : selectWeightedEpisodeType(
              sortedEligible,
              sharedBotRng,
              args.uniform_weights,
              !isCustomEpisodeTypes,
            );

      console.log(
        `[${bot.username}] Selected episode type: ${selectedEpisodeType}`,
      );

      // Get the episode class for the selected type
      const EpisodeClass = episodeClassMap[selectedEpisodeType];

      if (!EpisodeClass) {
        throw new Error(
          `Invalid episode type: ${selectedEpisodeType}, allowed types are: ${Object.keys(
            episodeClassMap,
          )
            .sort()
            .join(", ")}`,
        );
      }

      // Create an instance of the episode class
      const episodeInstance = new EpisodeClass(sharedBotRng);

      console.log(
        `[${bot.username}] Created ${EpisodeClass.name} instance for episode ${episodeNum}`,
      );
      await sleep(1000);
      const episodeCleanup = await runSingleEpisode(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        episodeInstance,
        args,
      );
      await coordinator.waitForAllPhasesToFinish();
      episodeCleanup();

      // Force stop bot.pvp and pathfinder navigation
      if (bot.pvp) {
        bot.pvp.forceStop();
        console.log(`[${bot.username}] Stopped PVP for episode ${episodeNum}`);
      }
      if (bot.pathfinder) {
        bot.pathfinder.setGoal(null);
        console.log(
          `[${bot.username}] Stopped pathfinder navigation for episode ${episodeNum}`,
        );
      }
      stopAll(bot);

      console.log(`[${bot.username}] tearing down episode ${episodeNum}`);
      try {
        await episodeInstance.tearDownEpisode(
          bot,
          rcon,
          sharedBotRng,
          coordinator,
          episodeNum,
          args,
        );
      } catch (err) {
        console.error(
          `[${bot.username}] Error during tearDownEpisode, continuing:`,
          err,
        );
      }
      console.log(`[${bot.username}] Episode ${episodeNum} completed`);
      await saveEpisodeInfo({
        args,
        bot,
        episodeInstance,
        episodeNum,
        episodeType: selectedEpisodeType,
      });
      console.log(`[${bot.username}] Syncing bots for episode ${episodeNum}`);
      await coordinator.syncBots(episodeNum);
      console.log(`[${bot.username}] Synced bots for episode ${episodeNum}`);
    }
    await rcon.end();

    const totalEpisodesRun = episodesToRun.length;
    console.log(`[${bot.username}] All ${totalEpisodesRun} episodes completed`);
    process.exit(0);
  };
}

/**
 * Get teleport phase handler function
 * @param {*} bot - Mineflayer bot instance
 * @param {*} rcon - RCON connection instance
 * @param {Function} sharedBotRng - Shared random number generator
 * @param {*} coordinator - Bot coordinator instance
 * @param {number} episodeNum - Episode number
 * @param {*} episodeInstance - Episode instance
 * @param {Object} args - Configuration arguments
 * @param {Object} phaseDataOur - Our phase data payload
 * @returns {Function} Teleport phase handler
 */
function getOnTeleportPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
  phaseDataOur,
) {
  return async (phaseDataOther) => {
    coordinator.sendToOtherBot(
      "teleportPhase",
      phaseDataOur,
      episodeNum,
      "teleportPhase beginning",
    );
    const otherBotPosition = phaseDataOther.position;
    const ourPosition = phaseDataOur.position;
    if (args.teleport && bot.username < args.other_bot_name) {
      console.log(`[${bot.username}] performs bots teleporting`);
      await teleport(
        bot,
        rcon,
        args,
        ourPosition,
        otherBotPosition,
        episodeInstance,
        sharedBotRng,
        episodeNum,
      );
    }

    coordinator.onceEvent(
      "postTeleportPhase",
      episodeNum,
      getOnPostTeleportPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        episodeInstance,
        args,
      ),
    );
    coordinator.sendToOtherBot(
      "postTeleportPhase",
      {},
      episodeNum,
      "teleportPhase end",
    );
  };
}

/**
 * Get post-teleport phase handler.
 *
 * @param {*} bot - Mineflayer bot instance
 * @param {*} rcon - RCON connection instance
 * @param {Function} sharedBotRng - Shared RNG
 * @param {*} coordinator - Bot coordinator
 * @param {number} episodeNum - Episode number
 * @param {*} episodeInstance - Episode instance
 * @param {Object} args - Configuration args
 * @returns {Function} Post-teleport phase handler
 */
function getOnPostTeleportPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
) {
  return async () => {
    coordinator.sendToOtherBot(
      "postTeleportPhase",
      {},
      episodeNum,
      "postTeleportPhase beginning",
    );
    const phaseDataOur = {
      position: bot.entity.position.clone(),
    };
    console.log(
      `[${bot.username}] our position after teleport: ${JSON.stringify(
        phaseDataOur,
      )}`,
    );

    coordinator.onceEvent(
      "setupEpisodePhase",
      episodeNum,
      getOnSetupEpisodeFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        episodeInstance,
        args,
        phaseDataOur,
      ),
    );
    coordinator.sendToOtherBot(
      "setupEpisodePhase",
      phaseDataOur,
      episodeNum,
      "postTeleportPhase end",
    );
  };
}

/**
 * Get setup-episode phase handler.
 *
 * @param {*} bot - Mineflayer bot instance
 * @param {*} rcon - RCON connection instance
 * @param {Function} sharedBotRng - Shared RNG
 * @param {*} coordinator - Bot coordinator
 * @param {number} episodeNum - Episode number
 * @param {*} episodeInstance - Episode instance
 * @param {Object} args - Configuration args
 * @param {Object} phaseDataOur - Our phase payload (expects `position`)
 * @returns {Function} Setup-episode phase handler
 */
function getOnSetupEpisodeFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
  phaseDataOur,
) {
  return async (phaseDataOther) => {
    console.log(
      `[${bot.username}] other position after teleport: ${JSON.stringify(
        phaseDataOther,
      )}`,
    );
    try {
      await setupBotAndCameraForEpisode(bot, rcon, args);
    } catch (error) {
      console.error(
        `[${bot.username}] Failed to setup bot and camera for episode:`,
        error,
      );
    }
    console.log(`[${bot.username}] setting up episode ${episodeNum}`);
    const { botPositionNew, otherBotPositionNew } =
      await episodeInstance.setupEpisode(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        args,
        phaseDataOur.position,
        phaseDataOther.position,
      );
    await lookAtSmooth(
      bot,
      otherBotPositionNew,
      DEFAULT_CAMERA_SPEED_DEGREES_PER_SEC,
      { randomized: false, useEasing: false },
    );

    await sleep(1000);

    // Call the entry point method
    coordinator.onceEvent(
      "startRecordingPhase",
      episodeNum,
      getOnStartRecordingFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        episodeInstance,
        args,
      ),
    );
    coordinator.sendToOtherBot(
      "startRecordingPhase",
      bot.entity.position.clone(),
      episodeNum,
      "teleportPhase end",
    );
  };
}

/**
 * Get start-recording phase handler.
 *
 * @param {*} bot - Mineflayer bot instance
 * @param {*} rcon - RCON connection instance
 * @param {Function} sharedBotRng - Shared RNG
 * @param {*} coordinator - Bot coordinator
 * @param {number} episodeNum - Episode number
 * @param {*} episodeInstance - Episode instance
 * @param {Object} args - Configuration args
 * @returns {Function} Start-recording phase handler
 */
function getOnStartRecordingFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (otherBotPosition) => {
    coordinator.sendToOtherBot(
      "startRecordingPhase",
      bot.entity.position.clone(),
      episodeNum,
      "startRecordingPhase end",
    );
    if (bot._episodeStopping) {
      console.log(
        `[${bot.username}] episode already stopping, skipping start recording`,
      );
    } else {
      console.log(`[${bot.username}] starting episode recording`);
      bot.emit("startepisode", episodeNum);
      episodeInstance._episodeRecordingStarted = true;
      await sleep(1000);
    }

    const iterationID = 0;
    episodeInstance.entryPoint(
      bot,
      rcon,
      sharedBotRng,
      coordinator,
      iterationID,
      episodeNum,
      args,
    );
  };
}

/**
 * Teleport both bots to a randomized location (or episode-specific fixed points).
 *
 * Uses `spreadplayers` to place both bots within the configured distance bounds.
 * For some eval episodes, applies special-case teleporting.
 *
 * @param {*} bot - Mineflayer bot instance.
 * @param {*} rcon - RCON connection instance.
 * @param {Object} args - Configuration args.
 * @param {*} ourPosition - Our current position (vec3-like).
 * @param {*} otherBotPosition - Peer current position (vec3-like).
 * @param {*} episodeInstance - Episode instance (used for min/max distances and eval detection).
 * @param {Function} sharedBotRng - Shared RNG (currently unused; reserved for future determinism).
 * @param {number} episodeNum - Episode number (for logging/commands).
 * @returns {Promise<void>} Resolves when teleport attempt finishes.
 */
async function teleport(
  bot,
  rcon,
  args,
  ourPosition,
  otherBotPosition,
  episodeInstance,
  sharedBotRng,
  episodeNum,
) {
  // Set time to day for eval episodes if enabled
  if (args.eval_time_set_day && isEvalEpisode(episodeInstance)) {
    const timeSetRes = await rcon.send("time set day");
    console.log(
      `[${bot.username}] time set to day for eval episode, result=${timeSetRes}`,
    );
  }

  // Custom TP logic for TurnToLookEpisode
  if (
    episodeInstance instanceof TurnToLookEvalEpisode ||
    episodeInstance instanceof TurnToLookOppositeEvalEpisode
  ) {
    if (turnToLookEvalTpPoints && turnToLookEvalTpPoints.length > 0) {
      await directTeleport(
        bot,
        rcon,
        args.other_bot_name,
        episodeNum,
        turnToLookEvalTpPoints,
      );
      return;
    }
  }

  // Initialize teleport center once as the midpoint between this bot and the other bot
  if (!bot._teleport_center) {
    bot._teleport_center = {
      x: (ourPosition.x + otherBotPosition.x) / 2,
      z: (ourPosition.z + otherBotPosition.z) / 2,
    };
    console.log(
      `[${bot.username}] initializing teleport center: ${JSON.stringify(bot._teleport_center)}`,
    );
  }
  if (!bot._teleport_radius) {
    bot._teleport_radius = args.teleport_radius;
  }
  const teleportCenter = bot._teleport_center;
  // Pick a random point in the world within the specified radius from center
  const MAX_ATTEMPTS_WITH_THIS_RADIUS = 10;
  const TOTAL_ATTEMPTS = 100;
  const MAX_RCON_TIMEOUTS = 3;
  let attemptsWithThisRadius = 0;
  let rconTimeoutCount = 0;
  let success = false;
  for (let i = 0; i < TOTAL_ATTEMPTS; i++) {
    console.log(
      `[${bot.username}] teleporting with radius: ${bot._teleport_radius}`,
    );
    const randomAngle = Math.random() * 2 * Math.PI;
    const randomDistance = Math.random() * bot._teleport_radius;

    const randomPointX =
      teleportCenter.x + randomDistance * Math.cos(randomAngle);
    const randomPointZ =
      teleportCenter.z + randomDistance * Math.sin(randomAngle);

    console.log(
      `[${bot.username}] picked random center at (${randomPointX.toFixed(
        2,
      )}, ${randomPointZ.toFixed(2)})`,
    );
    // Use spreadplayers to place both bots around the chosen center
    const centerX = Math.floor(randomPointX);
    const centerZ = Math.floor(randomPointZ);
    const minDistance = episodeInstance.constructor.INIT_MIN_BOTS_DISTANCE;
    const maxRange = Math.floor(
      episodeInstance.constructor.INIT_MAX_BOTS_DISTANCE / 2,
    );
    const targets = `${bot.username} ${args.other_bot_name}`;
    const cmd = `spreadplayers ${centerX} ${centerZ} ${minDistance} ${maxRange} false @a[tag=minebot]`;
    console.log(`[${bot.username}] spreadplayers command: ${cmd}`);
    let result;
    try {
      result = await rcon.send(cmd);
    } catch (err) {
      if (
        err.message &&
        err.message.includes("Timeout for packet id") &&
        rconTimeoutCount < MAX_RCON_TIMEOUTS
      ) {
        rconTimeoutCount++;
        console.log(
          `[${bot.username}] RCON timeout, retrying (${rconTimeoutCount}/${MAX_RCON_TIMEOUTS})...`,
        );
        await sleep(2500);
        continue;
      } else {
        throw err;
      }
    }
    console.log(`[${bot.username}] spreadplayers result: ${result}`);
    attemptsWithThisRadius++;
    if (!result.startsWith("Spread 2 player")) {
      if (attemptsWithThisRadius >= MAX_ATTEMPTS_WITH_THIS_RADIUS) {
        console.log(
          `[${bot.username}] spreadplayers failed after ${attemptsWithThisRadius} attempts with radius ${bot._teleport_radius}, halving the radius and trying again`,
        );
        bot._teleport_radius /= 2;
        attemptsWithThisRadius = 0;
      } else {
        console.log(`[${bot.username}] spreadplayers failed, trying again`);
      }
      await sleep(1000);
    } else {
      success = true;
      await sleep(5000);
      break;
    }
  }
  if (!success) {
    console.log(
      `[${bot.username}] spreadplayers failed after ${TOTAL_ATTEMPTS} attempts, skipping teleport`,
    );
  }
}

/**
 * Get peer-error phase handler for a specific episode.
 *
 * When the peer reports an error, mark `_peerError` and schedule the stop phase.
 *
 * @param {*} bot - Mineflayer bot instance
 * @param {*} rcon - RCON connection instance
 * @param {Function} sharedBotRng - Shared RNG
 * @param {*} coordinator - Bot coordinator
 * @param {number} episodeNum - Episode number
 * @param {*} episodeInstance - Episode instance
 * @param {Object} args - Configuration args
 * @returns {Function} Peer-error phase handler
 */
function getOnPeerErrorPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (phaseDataOther) => {
    console.error(
      `[${bot.username}] Received peerErrorPhase_${episodeNum} from peer, stopping.`,
      phaseDataOther["reason"],
    );
    episodeInstance._peerError = true;
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
      `peerErrorPhase_${episodeNum} end`,
    );
  };
}

module.exports = {
  runSingleEpisode,
  getOnSpawnFn,
  getOnTeleportPhaseFn,
  setupBotAndWorldOnce,
  setupCameraPlayerOnce,
  setupBotAndCameraForEpisode,
};
