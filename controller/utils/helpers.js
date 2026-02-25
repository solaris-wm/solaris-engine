/**
 * General utility functions
 */

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Promise that resolves after the specified time
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Generate random number between min and max
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Random number between min and max
 */
const rand = (min, max) => Math.random() * (max - min) + min;

/**
 * Choose random element from array
 * @param {Array} arr - Array to choose from
 * @returns {*} Random element from array
 */
const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Equip the first item of specified type in inventory
 * @param {*} bot - Mineflayer bot instance
 * @param {string} itemName - Name of item to equip
 * @param {string} dest - Destination slot ('torso','head','legs','feet','hand')
 */
async function equipFirst(bot, itemName, dest) {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (item) await bot.equip(item, dest);
}

module.exports = {
  sleep,
  rand,
  choice,
  equipFirst,
};
