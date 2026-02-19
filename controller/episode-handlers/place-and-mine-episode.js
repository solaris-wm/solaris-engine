/**
 * Place-and-Mine Episode
 *
 * Episode Flow:
 * 1. teleportPhase → Bots teleport to random positions (not recorded)
 * 2. setupEpisode →
 *    - Provision items (6 block types)
 *    - Find ground using land_pos()
 *    - Find build location (P0: full cross, P2: single axis)
 *    - Position bots using rconTp()
 *    - Store build data (center, axes, roles)
 * 3. 📹 START RECORDING
 * 4. placeAndMinePhase →
 *    - Bots already positioned
 *    - If P2: Miner clears observation axis first
 *    - Builder places blocks in patterns (1-5 blocks per round)
 *    - Miner watches, then mines placed blocks
 *    - Repeat for NUM_ROUNDS rounds
 * 5. stopPhase → End episode
 */

const { Vec3 } = require("vec3");

const { ensureItemInHand, placeAt } = require("../primitives/building");
const { digBlock } = require("../primitives/digging");
const { ensureBotHasEnough, unequipHand } = require("../primitives/items");
const { land_pos, lookAtBot } = require("../primitives/movement");
const { decidePrimaryBot, rconTp } = require("../utils/coordination");
const { sleep } = require("../utils/helpers");
const { BaseEpisode } = require("./base-episode");

const BLOCK_PLACE_INTERVAL_MS_MIN = 400;
const BLOCK_PLACE_INTERVAL_MS_MAX = 800;
const BLOCK_BREAK_INTERVAL_MS_MIN = 400;
const BLOCK_BREAK_INTERVAL_MS_MAX = 800;
const ROUND_DELAY_MS_MIN = 500;
const ROUND_DELAY_MS_MAX = 1000;
const NUM_ROUNDS_MIN = 7;
const NUM_ROUNDS_MAX = 10;
const PLACEMENT_RETRY_LIMIT = 3;
const DISTANCE_FROM_CENTER = 2;

const BLOCK_TYPES = [
  "stone",
  "oak_planks",
  "bricks",
  "dirt",
  "smooth_sandstone",
];

function checkHorizontalStrip(bot, startX, y, startZ, direction, length = 5) {
  for (let i = 0; i < length; i++) {
    const pos =
      direction === "x"
        ? new Vec3(startX + i, y, startZ)
        : new Vec3(startX, y, startZ + i);

    const groundBlock = bot.blockAt(pos);
    const airAbove = bot.blockAt(pos.offset(0, 1, 0));

    if (
      !groundBlock ||
      groundBlock.name === "air" ||
      groundBlock.name === "cave_air" ||
      groundBlock.boundingBox === "empty"
    ) {
      return false;
    }

    if (
      !airAbove ||
      (airAbove.name !== "air" && airAbove.name !== "cave_air")
    ) {
      return false;
    }
  }
  return true;
}

function checkCrossPattern(bot, centerX, y, centerZ) {
  const center = new Vec3(centerX, y, centerZ);
  const centerGround = bot.blockAt(center);
  const centerAir = bot.blockAt(center.offset(0, 1, 0));

  if (
    !centerGround ||
    centerGround.name === "air" ||
    centerGround.name === "cave_air" ||
    centerGround.name === "water" ||
    centerGround.boundingBox === "empty"
  ) {
    return null;
  }

  if (
    !centerAir ||
    (centerAir.name !== "air" && centerAir.name !== "cave_air")
  ) {
    return null;
  }

  const hasXAxis = checkHorizontalStrip(bot, centerX - 2, y, centerZ, "x", 5);
  const hasZAxis = checkHorizontalStrip(bot, centerX, y, centerZ - 2, "z", 5);

  if (hasXAxis && hasZAxis) {
    return {
      center: center.offset(0, 1, 0),
      hasXAxis: true,
      hasZAxis: true,
      priority: 0,
      y: y + 1,
      groundY: y,
    };
  } else if (hasXAxis || hasZAxis) {
    return {
      center: center.offset(0, 1, 0),
      hasXAxis: !!hasXAxis,
      hasZAxis: !!hasZAxis,
      priority: 2,
      y: y + 1,
      groundY: y,
    };
  }

  return null;
}

function findBuildLocation(bot, startPos, searchRadius = 15) {
  const searchX = Math.floor(startPos.x);
  const searchZ = Math.floor(startPos.z);
  const searchY = Math.floor(startPos.y);

  let bestP2 = null;

  for (let radius = 0; radius <= searchRadius; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;

        const x = searchX + dx;
        const z = searchZ + dz;

        for (let dy = -5; dy <= 5; dy++) {
          const y = searchY + dy;
          const crossCheck = checkCrossPattern(bot, x, y, z);

          if (crossCheck) {
            if (crossCheck.priority === 0) {
              console.log(
                `[${bot.username}] ✅ P0: Found full cross at (${x}, ${y}, ${z})`,
              );
              return crossCheck;
            } else if (crossCheck.priority === 2 && !bestP2) {
              bestP2 = crossCheck;
              bestP2.x = x;
              bestP2.z = z;
            }
          }
        }
      }
    }
  }

  if (bestP2) {
    console.log(
      `[${bot.username}] ⚠️ P2: Found single axis at (${bestP2.x}, ${bestP2.groundY}, ${bestP2.z})`,
    );
    return bestP2;
  }

  return null;
}

function generateBlockPositions(center, blockCount, direction = "z") {
  const positions = [];
  const offsetDir = direction === "x" ? [1, 0, 0] : [0, 0, 1];

  if (blockCount === 1) {
    positions.push(center.clone());
  } else if (blockCount === 2) {
    positions.push(center.clone());
    const side = Math.random() < 0.5 ? -1 : 1;
    positions.push(
      center.offset(
        offsetDir[0] * side,
        offsetDir[1] * side,
        offsetDir[2] * side,
      ),
    );
  } else if (blockCount === 3) {
    positions.push(center.offset(-offsetDir[0], -offsetDir[1], -offsetDir[2]));
    positions.push(center.clone());
    positions.push(center.offset(offsetDir[0], offsetDir[1], offsetDir[2]));
  } else if (blockCount === 4) {
    positions.push(center.offset(-offsetDir[0], -offsetDir[1], -offsetDir[2]));
    positions.push(center.clone());
    positions.push(center.offset(offsetDir[0], offsetDir[1], offsetDir[2]));
    const side = Math.random() < 0.5 ? -2 : 2;
    positions.push(
      center.offset(
        offsetDir[0] * side,
        offsetDir[1] * side,
        offsetDir[2] * side,
      ),
    );
  } else {
    for (let i = -2; i <= 2; i++) {
      positions.push(
        center.offset(offsetDir[0] * i, offsetDir[1] * i, offsetDir[2] * i),
      );
    }
  }

  return positions;
}

function getOnBuildRoundPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  iterationID,
  episodeNum,
  episodeInstance,
  args,
  round,
) {
  return async (phaseDataOther) => {
    coordinator.sendToOtherBot(
      `buildRound_${iterationID}_${round}`,
      {},
      episodeNum,
      `buildRound_${iterationID}_${round} beginning`,
    );
    let nextPhaseData = {};
    if (episodeInstance._isBuilder) {
      const center = episodeInstance._buildCenter;
      const stripDirection = episodeInstance._axisOfActivity;

      console.log(
        `[${bot.username}] 🎯 Round ${round + 1}/${episodeInstance._numRounds}`,
      );

      const blockCount = [1, 2, 3, 4, 5][Math.floor(Math.random() * 5)];
      const blockType =
        BLOCK_TYPES[Math.floor(Math.random() * BLOCK_TYPES.length)];
      const positions = generateBlockPositions(
        center,
        blockCount,
        stripDirection,
      );

      await ensureItemInHand(bot, blockType);
      await sleep(100);

      const placedPositions = [];
      for (const pos of positions) {
        const success = await placeAt(bot, pos, blockType, {
          useSneak: false,
          tries: PLACEMENT_RETRY_LIMIT,
          args: null,
        });

        if (success) {
          placedPositions.push(pos);
        }

        await sleep(
          Math.random() *
            (BLOCK_PLACE_INTERVAL_MS_MAX - BLOCK_PLACE_INTERVAL_MS_MIN + 1) +
            BLOCK_PLACE_INTERVAL_MS_MIN,
        );
      }

      await sleep(200);
      await lookAtBot(bot, args.other_bot_name, 90);
      await sleep(500);

      await sleep(
        Math.random() * (ROUND_DELAY_MS_MAX - ROUND_DELAY_MS_MIN + 1) +
          ROUND_DELAY_MS_MIN,
      );
      nextPhaseData = { roundData: { positions: placedPositions, blockType } };
    } else {
      console.log(`[${bot.username}] is not a builder, skipping build round`);
    }
    coordinator.onceEvent(
      `mineRound_${iterationID}_${round}`,
      episodeNum,
      getOnMineRoundPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        iterationID,
        episodeNum,
        episodeInstance,
        args,
        round,
        nextPhaseData,
      ),
    );
    coordinator.sendToOtherBot(
      `mineRound_${iterationID}_${round}`,
      nextPhaseData,
      episodeNum,
      `buildRound_${iterationID}_${round} end`,
    );
  };
}

async function clearBuildArea(bot, center, clearDirection) {
  console.log(
    `[${bot.username}] 🧹 Clearing 5 blocks in ${clearDirection} direction`,
  );

  const positions = [];
  for (let i = -2; i <= 2; i++) {
    const pos =
      clearDirection === "x" ? center.offset(i, 0, 0) : center.offset(0, 0, i);
    positions.push(pos);
  }

  await ensureItemInHand(bot, "diamond_pickaxe");
  await sleep(100);

  for (const pos of positions) {
    const block = bot.blockAt(pos);
    if (block && block.name !== "air" && block.name !== "cave_air") {
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), false);
      await sleep(50);
      await digBlock(bot, pos);
      await sleep(
        Math.random() *
          (BLOCK_BREAK_INTERVAL_MS_MAX - BLOCK_BREAK_INTERVAL_MS_MIN + 1) +
          BLOCK_BREAK_INTERVAL_MS_MIN,
      );
    }
  }
}

function getOnMineRoundPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  iterationID,
  episodeNum,
  episodeInstance,
  args,
  round,
  phaseDataOur,
) {
  return async (phaseDataOther) => {
    coordinator.sendToOtherBot(
      `mineRound_${iterationID}_${round}`,
      phaseDataOur,
      episodeNum,
      `mineRound_${iterationID}_${round} beginning`,
    );

    if (!episodeInstance._isBuilder) {
      const roundData = phaseDataOther.roundData;
      if (!roundData) {
        throw new Error(
          `[${bot.username}] No roundData received from builder for mining phase.`,
        );
      }
      await ensureItemInHand(bot, "diamond_pickaxe");
      await sleep(100);

      console.log(
        `[${bot.username}] 👀 Round ${round + 1}/${episodeInstance._numRounds}: Watching builder...`,
      );

      await lookAtBot(bot, args.other_bot_name, 90);

      console.log(
        `[${bot.username}] ⛏️ Mining ${roundData.positions.length} block(s)...`,
      );

      let minedCount = 0;
      for (const posData of roundData.positions) {
        const pos = new Vec3(posData.x, posData.y, posData.z);
        await bot.lookAt(pos.offset(0.5, 0.5, 0.5), false);
        await sleep(50);

        const success = await digBlock(bot, pos);
        if (success) {
          minedCount++;
        }

        await sleep(
          Math.random() *
            (BLOCK_BREAK_INTERVAL_MS_MAX - BLOCK_BREAK_INTERVAL_MS_MIN + 1) +
            BLOCK_BREAK_INTERVAL_MS_MIN,
        );
      }

      await sleep(200);
      await lookAtBot(bot, args.other_bot_name, 90);
      await sleep(500);
      await sleep(
        Math.random() * (ROUND_DELAY_MS_MAX - ROUND_DELAY_MS_MIN + 1) +
          ROUND_DELAY_MS_MIN,
      );
    } else {
      console.log(`[${bot.username}] is not a miner, skipping mine round`);
    }
    if (round < episodeInstance._numRounds - 1) {
      const nextRound = round + 1;
      coordinator.onceEvent(
        `buildRound_${iterationID}_${nextRound}`,
        episodeNum,
        getOnBuildRoundPhaseFn(
          bot,
          rcon,
          sharedBotRng,
          coordinator,
          iterationID,
          episodeNum,
          episodeInstance,
          args,
          nextRound,
        ),
      );
      coordinator.sendToOtherBot(
        `buildRound_${iterationID}_${nextRound}`,
        {},
        episodeNum,
        `MineRound_${iterationID}_${round} end`,
      );
    } else {
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
        `placeAndMinePhase_${iterationID} end`,
      );
    }
  };
}

function getOnPlaceAndMinePhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  iterationID,
  episodeNum,
  episodeInstance,
  args,
) {
  return async function onPlaceAndMinePhase() {
    coordinator.sendToOtherBot(
      `placeAndMinePhase_${iterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      `placeAndMinePhase_${iterationID} beginning`,
    );

    console.log(
      `[${bot.username}] 🚀 Starting PLACE-AND-MINE phase ${iterationID}`,
    );

    const buildCenter = episodeInstance._buildCenter;
    const axisOfActivity = episodeInstance._axisOfActivity;
    const axisOfObservation = episodeInstance._axisOfObservation;
    const needsClearing = episodeInstance._needsClearing;
    const isBuilder = episodeInstance._isBuilder;
    const numRounds =
      Math.floor(sharedBotRng() * (NUM_ROUNDS_MAX - NUM_ROUNDS_MIN + 1)) +
      NUM_ROUNDS_MIN;
    episodeInstance._numRounds = numRounds;
    console.log(
      `[${bot.username}] 🎭 I am the ${isBuilder ? "🏗️ BUILDER" : "⛏️ MINER"}`,
    );
    console.log(
      `[${bot.username}] 📐 AxO=${axisOfObservation}, AxA=${axisOfActivity}`,
    );

    await lookAtBot(bot, args.other_bot_name, 90);
    await sleep(1000);

    if (needsClearing && !isBuilder) {
      console.log(`[${bot.username}] 🧹 Miner clearing observation axis...`);
      await clearBuildArea(bot, buildCenter, axisOfObservation);
      await sleep(500);
      await lookAtBot(bot, args.other_bot_name, 90);
      await sleep(500);
    }

    coordinator.onceEvent(
      `clearingComplete_${iterationID}`,
      episodeNum,
      getOnClearingCompletePhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        iterationID,
        episodeNum,
        episodeInstance,
        args,
      ),
    );
    coordinator.sendToOtherBot(
      `clearingComplete_${iterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      `clearingComplete_${iterationID} end`,
    );
  };
}

function getOnClearingCompletePhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  iterationID,
  episodeNum,
  episodeInstance,
  args,
) {
  return async () => {
    coordinator.sendToOtherBot(
      `clearingComplete_${iterationID}`,
      bot.entity.position.clone(),
      episodeNum,
      `clearingComplete_${iterationID} beginning`,
    );

    const round = 0;
    coordinator.onceEvent(
      `buildRound_${iterationID}_${round}`,
      episodeNum,
      getOnBuildRoundPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        iterationID,
        episodeNum,
        episodeInstance,
        args,
        round,
      ),
    );
    coordinator.sendToOtherBot(
      `buildRound_${iterationID}_${round}`,
      {},
      episodeNum,
      `clearingComplete_${iterationID} end`,
    );
  };
}

/**
 * Episode where one bot (builder) places blocks in patterns and the other (miner) watches then
 * mines them. Roles and build location are chosen in setup; rounds repeat for a random number of times.
 * @extends BaseEpisode
 */
class PlaceAndMineEpisode extends BaseEpisode {
  static INIT_MIN_BOTS_DISTANCE = 4;
  static INIT_MAX_BOTS_DISTANCE = 8;
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
    console.log(`[${bot.username}] 🎬 Setting up place-and-mine episode...`);
    const { botPositionNew, otherBotPositionNew } =
      await this.findGroundAndPositionBots(
        bot,
        rcon,
        sharedBotRng,
        args,
        botPosition,
        otherBotPosition,
      );

    for (const blockType of BLOCK_TYPES) {
      await ensureBotHasEnough(bot, rcon, blockType, 64);
    }

    await unequipHand(bot);
    await sleep(500);

    console.log(`[${bot.username}] ✅ Place-and-mine episode setup complete`);
    return {
      botPositionNew,
      otherBotPositionNew,
    };
  }

  async findGroundAndPositionBots(
    bot,
    rcon,
    sharedBotRng,
    args,
    botPosition,
    otherBotPosition,
  ) {
    const myPos = botPosition;

    const midX = Math.floor((myPos.x + otherBotPosition.x) / 2);
    const midZ = Math.floor((myPos.z + otherBotPosition.z) / 2);

    const groundPos = land_pos(bot, midX, midZ);
    if (!groundPos) {
      throw new Error(`Could not find ground at midpoint (${midX}, ${midZ})`);
    }

    const buildLocation = findBuildLocation(bot, groundPos, 15);
    if (!buildLocation) {
      throw new Error(`Could not find suitable build location`);
    }

    const buildCenter = buildLocation.center;
    const needsClearing = buildLocation.priority === 2;

    let axisOfObservation, axisOfActivity;
    const useXAsObservation = sharedBotRng() < 0.5;
    if (buildLocation.priority === 0) {
      axisOfObservation = useXAsObservation ? "x" : "z";
      axisOfActivity = useXAsObservation ? "z" : "x";
    } else if (buildLocation.priority === 2) {
      if (buildLocation.hasXAxis) {
        axisOfObservation = "z";
        axisOfActivity = "x";
      } else {
        axisOfObservation = "x";
        axisOfActivity = "z";
      }
    }

    const side = sharedBotRng() < 0.5 ? -1 : 1;
    const isBuilder = decidePrimaryBot(bot, sharedBotRng, args);
    const builderOffset = side * DISTANCE_FROM_CENTER;
    const minerOffset = -side * DISTANCE_FROM_CENTER;

    const builderPos =
      axisOfObservation === "x"
        ? buildCenter.offset(builderOffset, 0, 0)
        : buildCenter.offset(0, 0, builderOffset);

    const minerPos =
      axisOfObservation === "x"
        ? buildCenter.offset(minerOffset, 0, 0)
        : buildCenter.offset(0, 0, minerOffset);

    const botPositionNew = isBuilder ? builderPos : minerPos;
    const otherBotPositionNew = isBuilder ? minerPos : builderPos;

    await rconTp(
      rcon,
      bot.username,
      botPositionNew.x,
      botPositionNew.y,
      botPositionNew.z,
    );
    await sleep(1000);

    this._buildCenter = buildCenter;
    this._axisOfActivity = axisOfActivity;
    this._axisOfObservation = axisOfObservation;
    this._needsClearing = needsClearing;
    this._isBuilder = isBuilder;
    return {
      botPositionNew,
      otherBotPositionNew,
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
      `placeAndMinePhase_${iterationID}`,
      episodeNum,
      getOnPlaceAndMinePhaseFn(
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
      `placeAndMinePhase_${iterationID}`,
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
    await unequipHand(bot);
  }
}

module.exports = {
  PlaceAndMineEpisode,
};
