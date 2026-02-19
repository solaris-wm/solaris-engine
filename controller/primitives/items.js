/**
 * items.js - Utilities for managing bot inventory and equipment
 */

const { sleep } = require("../utils/helpers");

/**
 * Unequips an item from the bot's hand
 * @param {*} bot - Mineflayer bot instance
 * @param {string} [itemType] - Optional item type to check for (e.g., "sword", "pickaxe")
 * @returns {Promise<boolean>} True if successfully unequipped or nothing to unequip
 */
async function unequipHand(bot, itemType = null) {
  if (!bot || !bot.entity || !bot.inventory) {
    console.log(
      `[${
        bot?.username || "unknown"
      }] Cannot unequip - bot not properly initialized`,
    );
    return false;
  }

  // Check if the bot has an item equipped
  const itemInHand = bot.heldItem;

  if (!itemInHand) {
    console.log(`[${bot.username}] No item equipped in hand`);
    return true;
  }

  // If itemType is specified, check if the item matches that type
  if (itemType) {
    const itemName = itemInHand.name || "";
    const displayName = itemInHand.displayName?.toLowerCase() || "";

    if (
      !itemName.includes(itemType.toLowerCase()) &&
      !displayName.includes(itemType.toLowerCase())
    ) {
      console.log(
        `[${bot.username}] Item in hand (${itemName}) is not a ${itemType}, skipping unequip`,
      );
      return true;
    }
  }

  // Safely unequip the main hand item
  await bot.unequip("hand");
  console.log(`[${bot.username}] Unequipped ${itemInHand.name} from main hand`);
  return true;
}

/**
 * Ensure the bot has at least targetCount of the given item in inventory
 * @param {*} bot - Mineflayer bot instance
 * @param {*} rcon - RCON connection instance
 * @param {string} itemName - Minecraft item name (e.g., 'stone')
 * @param {number} targetCount - Desired count in inventory
 */
async function ensureBotHasEnough(
  bot,
  rcon,
  itemName = "stone",
  targetCount = 128,
) {
  // @ts-ignore: module provides runtime data but no TS types in this project
  const mcData = require("minecraft-data")(bot.version);
  const item = mcData.itemsByName[itemName];
  if (!item) {
    throw new Error(`Unknown item: ${itemName} for version ${bot.version}`);
  }

  const have = bot.inventory.count(item.id, null);
  const need = Math.max(0, targetCount - have);
  console.log(
    `[${bot.username}] inventory ${itemName}: have=${have}, target=${targetCount}, need=${need}`,
  );
  if (need === 0) return;

  const cmd = `give ${bot.username} minecraft:${itemName} ${need}`;
  const res = await rcon.send(cmd);
  console.log(
    `[${bot.username}] ensureBotHasEnough: ${cmd} -> ${String(res).trim()}`,
  );

  // brief wait for inventory to update, then verify
  await sleep(800);
  const after = bot.inventory.count(item.id, null);
  console.log(
    `[${bot.username}] inventory ${itemName}: now ${after}/${targetCount}`,
  );
}

/**
 * Ensure an item is equipped in hand
 * @param {*} bot - Mineflayer bot instance
 * @param {string} itemName - Name of item to equip
 * @param {Object} args - Configuration arguments with rcon settings (optional)
 * @returns {Promise<number>} Item ID
 */
async function ensureItemInHand(bot, itemName, args = null) {
  const mcData = require("minecraft-data")(bot.version);
  const target = mcData.itemsByName[itemName];
  if (!target) throw new Error(`Unknown item: ${itemName}`);
  const id = target.id;

  // Check if already in inventory
  let item = bot.inventory.items().find((i) => i.type === id);

  // If not found, try to get it

  if (!item) throw new Error(`Item ${itemName} not in inventory`);

  await bot.equip(id, "hand");
  return id;
}

module.exports = {
  unequipHand,
  ensureBotHasEnough,
  ensureItemInHand,
};
