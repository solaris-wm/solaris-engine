const util = require("util");

const mineflayer = require("mineflayer");
const {
  pathfinder,
  Movements,
  goals: { GoalNear, GoalNearXZ, GoalXZ, GoalBlock, GoalFollow },
} = require("mineflayer-pathfinder");

const pvp = require("mineflayer-pvp").plugin;
const toolPlugin = require("mineflayer-tool").plugin;

// Log mineflayer version once to help debug protocol mismatches
const MINEFLAYER_VERSION =
  (require("mineflayer/package.json") || {}).version || "unknown";
console.log(`[bot-factory] mineflayer version: ${MINEFLAYER_VERSION}`);

/**
 * Create a new Mineflayer bot instance
 * @param {Object} config - Bot configuration
 * @param {string} config.username - Bot username
 * @param {string} config.host - Server host
 * @param {number} config.port - Server port
 * @param {string} config.version - Minecraft version (defaults to 1.21)
 * @returns {Bot} Mineflayer bot instance
 */
function makeBot({ username, host, port, version = "1.21" }) {
  const bot = mineflayer.createBot({
    host,
    port,
    username,
    version,
    checkTimeoutInterval: 10 * 60 * 1000,
  });

  // Load pathfinder plugin
  bot.loadPlugin(pathfinder);

  bot.loadPlugin(pvp);

  // Load tool plugin for automatic tool selection
  bot.loadPlugin(toolPlugin);

  bot.on("end", () => console.log(`[${bot.username}] disconnected.`));
  bot.on("kicked", (reason) =>
    console.log(
      `[${bot.username}] kicked:`,
      util.inspect(reason, { depth: null }),
    ),
  );
  bot.on("error", (err) => console.log(`[${bot.username}] error:`, err));

  bot.on("spawn", () => {
    console.log(
      `[${bot.username}] 🎮 Spawned in world at (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`,
    );
  });

  bot.on("health", () => {
    if (bot.health <= 5 && bot.health > 0) {
      console.log(`[${bot.username}] ⚠️ Low health: ${bot.health}/20`);
    }
  });

  bot.on("death", () => {
    console.log(
      `[${bot.username}] 💀 Died at (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`,
    );
  });

  // Log when bot respawns
  bot.on("respawn", () => {
    console.log(`[${bot.username}] ♻️ Respawned`);
  });

  return bot;
}

module.exports = {
  makeBot,
  Movements,
  GoalNear,
  GoalNearXZ,
  GoalXZ,
  GoalBlock,
  GoalFollow,
};
