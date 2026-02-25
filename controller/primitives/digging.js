const { Vec3 } = require("vec3");

const { sleep } = require("../utils/helpers");

/**
 * Dig a block with a timeout, similar to gotoWithTimeout.
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} block - Block to dig
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=10000] - Maximum time to attempt digging
 * @param {boolean} [options.stopOnTimeout=true] - Stop digging when timeout triggers
 * @returns {Promise<void>} Resolves when dig completes; rejects on timeout/error
 */
async function digWithTimeout(bot, block, options = {}) {
  const { timeoutMs = 7000, stopOnTimeout = true } = options;

  // Auto-equip best tool for this block (if tool plugin is available)
  if (bot.tool) {
    try {
      await bot.tool.equipForBlock(block, { requireHarvest: false });
      const equippedTool = bot.heldItem?.name || "unknown tool";
      console.log(
        `[${bot.username}] 🔧 Equipped ${equippedTool} for ${block.name}`,
      );
    } catch (toolError) {
      console.log(
        `[${bot.username}] ⚠️ Could not equip tool: ${toolError.message}, will dig anyway`,
      );
      // Continue anyway - bot will use whatever is in hand
    }
  }

  let timeoutId;
  const digPromise = bot.dig(block);
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      if (stopOnTimeout && typeof bot.stopDigging === "function") {
        try {
          bot.stopDigging();
        } catch (_) {}
      }
      reject(new Error(`dig timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([digPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Dig a block at a world position, if present.
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} blockPos - Block position to dig
 * @returns {Promise<boolean>} True if the block was air/dug successfully; false on error
 */
async function digBlock(bot, blockPos) {
  try {
    const block = bot.blockAt(blockPos);
    if (!block || block.name === "air" || block.name === "cave_air") {
      return true;
    }

    const blockCenter = blockPos.offset(0.5, 0.5, 0.5);
    await bot.lookAt(blockCenter);
    await sleep(50);
    await digWithTimeout(bot, block);
    return true;
  } catch (error) {
    console.log(`[${bot.username}] ❌ Error digging block: ${error.message}`);
    return false;
  }
}

/**
 * Place a torch on the floor at the bot's current feet position
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} movementDirection - Direction the bot is moving (not used)
 * @returns {Promise<boolean>} True if torch was placed
 */
async function placeTorchOnFloor(
  bot,
  torchType,
  torchEquipDelayMs,
  torchLookDelayMs,
  torchPlaceDelayMs,
  lookDelayMs,
  movementDirection = null,
) {
  try {
    const currentPos = bot.entity.position.clone();

    // Place torch at bot's current feet position (not behind)
    const torchPos = new Vec3(
      Math.floor(currentPos.x),
      Math.floor(currentPos.y),
      Math.floor(currentPos.z),
    );

    // Check if the torch position is valid (should be air or replaceable)
    const torchBlock = bot.blockAt(torchPos);
    if (!torchBlock) {
      console.log(`[${bot.username}] ⚠️ Cannot access block at ${torchPos}`);
      return false;
    }

    // Check if a torch is already there (skip if so)
    if (torchBlock.name === "torch" || torchBlock.name === "wall_torch") {
      console.log(
        `[${bot.username}] ⚠️ Torch already exists at ${torchPos}, skipping`,
      );
      return false;
    }

    // Find the floor block below torch position to place torch on
    const floorPos = torchPos.offset(0, -1, 0);
    const floorBlock = bot.blockAt(floorPos);

    if (
      !floorBlock ||
      floorBlock.name === "air" ||
      floorBlock.name === "cave_air"
    ) {
      console.log(
        `[${bot.username}] ⚠️ No floor block at ${floorPos} to place torch on`,
      );
      return false;
    }

    console.log(
      `[${bot.username}] 🔦 Placing torch on floor at ${torchPos} (on top of ${floorBlock.name})`,
    );

    // Equip torch
    const torch = bot.inventory.items().find((item) => item.name === torchType);
    if (!torch) {
      console.log(`[${bot.username}] ⚠️ No torches in inventory!`);
      return false;
    }

    console.log(
      `[${bot.username}] ✅ Found torch: ${torch.name} (${torch.count} remaining)`,
    );
    await bot.equip(torch, "hand");
    await sleep(torchEquipDelayMs);

    // Look down at the floor block where torch will be placed
    console.log(`[${bot.username}] 👀 Looking at floor block ${floorPos}`);
    await bot.lookAt(floorBlock.position.offset(0.5, 1, 0.5), false);
    await sleep(torchLookDelayMs);

    // Place torch on floor
    try {
      await bot.placeBlock(floorBlock, new Vec3(0, 1, 0)); // Place on top face of floor block
      await sleep(torchPlaceDelayMs); // Wait longer to make placement visible
      console.log(`[${bot.username}] ✅ Torch successfully placed on floor`);

      // Look back up/forward
      await bot.look(0, 0, false); // Look straight ahead
      await sleep(lookDelayMs);

      return true;
    } catch (placeError) {
      console.log(
        `[${bot.username}] ⚠️ Failed to place torch block: ${placeError.message}`,
      );
      return false;
    }
  } catch (error) {
    console.log(`[${bot.username}] ❌ Failed to place torch: ${error.message}`);
    return false;
  }
}
/**
 * Check if a torch can be placed on a block and return the best face direction
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} pos - Position to place torch
 * @returns {[boolean, Vec3|null]} [canPlace, faceVector]
 */
function canPlaceTorch(bot, pos) {
  // Check for above, east, west, south, and north torches
  const directions = [
    new Vec3(0, 1, 0), // up
    new Vec3(1, 0, 0), // east
    new Vec3(-1, 0, 0), // west
    new Vec3(0, 0, 1), // south
    new Vec3(0, 0, -1), // north
  ];

  // Calculate direction from block to bot
  const eyePosition = bot.entity.position.offset(0, 1.8, 0); // hardcode to ignore sneaking
  const toBot = new Vec3(
    eyePosition.x - pos.x,
    eyePosition.y - pos.y,
    eyePosition.z - pos.z,
  );

  // Sort directions by how well they point towards the bot
  // (using dot product: higher = more aligned)
  const sortedDirections = directions.slice().sort((a, b) => {
    const dotA = a.x * toBot.x + a.y * toBot.y + a.z * toBot.z;
    const dotB = b.x * toBot.x + b.y * toBot.y + b.z * toBot.z;
    return dotB - dotA; // Higher dot product first
  });

  for (const dir of sortedDirections) {
    const neighborPos = pos.offset(dir.x, dir.y, dir.z);
    const neighbor = bot.blockAt(neighborPos);
    if (neighbor && neighbor.name === "air") return [true, dir];
  }
  return [false, null];
}

/**
 * Place a torch on a nearby surface
 * @param {*} bot - Mineflayer bot instance
 * @param {Object} mcData - Minecraft data
 * @param {Array} oreIds - Array of ore block IDs to avoid
 * @param {number} maxTryTime - Maximum time to try placing torch (default 6 seconds)
 * @param {Function} stopRetryCondition - Function to check if torch placement should stop (default false)
 */
async function placeTorch(
  bot,
  mcData,
  oreIds,
  maxTorchDistance,
  maxTryTime = 6000,
  stopRetryCondition = () => false,
) {
  const isSolid = (b) =>
    b && b.boundingBox === "block" && !b.name.includes("leaves");
  try {
    const torchSlot = bot.inventory.findInventoryItem(
      mcData.itemsByName.torch.id,
    );
    if (!torchSlot) {
      console.log(`[${bot.username}] No torch in inventory`);
      return;
    }

    // Find a suitable surface to place torch
    const torchBasePositions = bot.findBlocks({
      matching: (block) => isSolid(block),
      maxDistance: maxTorchDistance,
      count: 20,
    });

    if (torchBasePositions.length === 0) {
      console.log(`[${bot.username}] No suitable surface for torch`);
      return;
    }

    await bot.equip(torchSlot, "hand");
    await bot.waitForTicks(2);

    const botPosition = bot.entity.position;
    const eyeLevel = botPosition.y + 1.8; // hardcode to ignore sneaking

    // Sort blocks by proximity to head level (prioritize head-level blocks)
    const sortedPositions = torchBasePositions.sort((a, b) => {
      const distA = Math.abs(a.y - eyeLevel);
      const distB = Math.abs(b.y - eyeLevel);
      return distA - distB;
    });

    // Try placing torch sequentially until one succeeds, up to maxTryTime
    const startTime = Date.now();
    for (const blockPos of sortedPositions) {
      // Check stop condition first
      if (stopRetryCondition()) {
        console.log(
          `[${bot.username}] Torch placement stopped due to stopRetryCondition`,
        );
        return;
      }

      if (Date.now() - startTime > maxTryTime) {
        console.log(
          `[${bot.username}] Torch placement loop timed out after ${maxTryTime}ms`,
        );
        return;
      }

      const distance = blockPos.distanceTo(botPosition);
      if (distance > maxTorchDistance) continue;

      const block = bot.blockAt(blockPos);
      // if it's an ore block, skip
      if (!block || oreIds.includes(block.type)) continue;

      const [canPlace, faceVector] = canPlaceTorch(bot, blockPos);
      if (!canPlace) continue;

      if (!bot.world.getBlock(blockPos)) continue;

      try {
        await bot.waitForTicks(2);
        console.log(
          `[${bot.username}] Attempting to place torch at ${blockPos}`,
        );
        // this may block up to 800ms
        await bot.placeBlock(block, faceVector);
        await bot.waitForTicks(2);
        console.log(`[${bot.username}] Torch placed at ${blockPos}`);
        return;
      } catch (error) {
        // Print Error and continue to next position
        console.log(
          `[${bot.username}] Failed to place torch at ${blockPos}:`,
          error.message,
        );
      }
    }
  } catch (error) {
    console.log(`[${bot.username}] Failed to place torch:`, error.message);
  }
}
/**
 * Check if a block is visible to the bot
 * @param {*} bot - Mineflayer bot instance
 * @param {*} block - Block to check
 * @returns {boolean} Whether the block is visible
 */
function isBlockVisible(bot, block) {
  if (!block) return false;
  return bot.canSeeBlock(block);
}

/**
 * Find visible valuable ores
 * @param {*} bot - Mineflayer bot instance
 * @param {Array} oreIds - Array of ore block IDs
 * @returns {Array} Array of visible ore blocks
 */
function findVisibleOres(bot, oreIds) {
  const visibleOres = [];
  const oreBlocks = bot.findBlocks({
    matching: oreIds,
    maxDistance: 16,
    count: 20,
  });
  const botPosition = bot.entity.position;
  for (const blockPos of oreBlocks) {
    const block = bot.blockAt(blockPos);
    if (
      block &&
      block.position.distanceTo(botPosition) < 16 &&
      isBlockVisible(bot, block)
    ) {
      visibleOres.push(block);
      console.log(
        `[${bot.username}] Found visible ${block.name} at ${block.position}`,
      );
    }
  }
  console.log(
    `[${bot.username}] Found ${visibleOres.length} visible ores out of ${oreBlocks.length} nearby ores`,
  );
  return visibleOres;
}

module.exports = {
  // Basic controls
  digWithTimeout,
  digBlock,
  placeTorchOnFloor,
  placeTorch,
  findVisibleOres,
  isBlockVisible,
};
