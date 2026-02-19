/**
 * Basic Movement Building Blocks for Mineflayer Bots
 * These functions provide consistent, deterministic movement primitives
 * that can be used across all episodes.
 */

// Import pathfinder components correctly according to official README

// ============================================================================
// EXPORTS
// ============================================================================
const FOV_DEGREES = 90; // total FOV in front of the bot

/**
 * Give the bot a randomly selected sword via RCON.
 * @param {*} bot - Mineflayer bot instance
 * @param {*} rcon - RCON connection instance (must support send())
 * @returns {Promise<void>}
 */
async function giveRandomSword(bot, rcon) {
  const swords = [
    "minecraft:wooden_sword",
    "minecraft:stone_sword",
    "minecraft:iron_sword",
    "minecraft:golden_sword",
    "minecraft:diamond_sword",
    "minecraft:netherite_sword",
  ];
  const randomSword = swords[Math.floor(Math.random() * swords.length)];
  const giveSwordRes = await rcon.send(`give ${bot.username} ${randomSword} 1`);
  console.log(
    `[${bot.username}] Gave random sword: ${randomSword}, response=${giveSwordRes}`,
  );
}

/**
 * Equip the first sword found in the bot's inventory.
 * @param {*} bot - Mineflayer bot instance
 * @returns {Promise<void>}
 */
async function equipSword(bot) {
  const swordItem = bot.inventory
    .items()
    .find((item) => item.name.includes("sword"));
  if (swordItem) {
    await bot.equip(swordItem, "hand");
    console.log(`[${bot.username}] Equipped ${swordItem.name} to hand`);
  } else {
    console.log(
      `[${bot.username}] Warning: Could not find any sword in inventory to equip`,
    );
  }
}

/**
 * Check if a position is within the bot's forward-facing FOV cone.
 * @param {any} bot - The bot instance
 * @param {any} targetPos - The target position (Vec3)
 * @param {number} fovDegrees - Field of view in degrees (default 90)
 * @returns {boolean} True if the target is in the bot's FOV
 */
function isInForwardFOV(bot, targetPos, fovDegrees = FOV_DEGREES) {
  const botPos = bot.entity.position;
  const yaw = bot.entity.yaw;

  // Calculate forward direction vector
  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);

  // Calculate direction to target
  const dx = targetPos.x - botPos.x;
  const dz = targetPos.z - botPos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (dist === 0) return true; // Target is at bot position

  // Normalize direction to target
  const targetDirX = dx / dist;
  const targetDirZ = dz / dist;

  // Calculate dot product (cosine of angle between vectors)
  const dotProduct = forwardX * targetDirX + forwardZ * targetDirZ;

  // Calculate the angle threshold
  const fovRadians = (fovDegrees * Math.PI) / 180;
  const angleThreshold = Math.cos(fovRadians / 2);

  return dotProduct >= angleThreshold;
}

module.exports = {
  // Basic controls
  giveRandomSword,
  equipSword,
  isInForwardFOV,
  FOV_DEGREES,
};
