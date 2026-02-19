const mineflayer = require("mineflayer");

const MC_HOST = process.env.MC_HOST || "127.0.0.1";
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USERNAME = process.env.MC_USERNAME || "SpectatorPassive";
const RETRY_MS = 5000;
const VERSION = "1.21";
const INITIAL_DELAY_MS = 30000;

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Promise that resolves after the specified time
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mineflayerVersion =
    (require("mineflayer/package.json") || {}).version || "unknown";
  console.log(
    `[${MC_USERNAME}] mineflayer ${mineflayerVersion}; target ${MC_HOST}:${MC_PORT}`,
  );

  await connectWithRetry({ delayMs: INITIAL_DELAY_MS });
}

async function connectWithRetry({ delayMs }) {
  console.log(
    `[${MC_USERNAME}] connecting in ${delayMs}ms to ${MC_HOST}:${MC_PORT}`,
  );
  await sleep(delayMs);

  const bot = makeBot({
    host: MC_HOST,
    port: MC_PORT,
    username: MC_USERNAME,
    version: VERSION,
  });

  bot.once("login", () => {
    console.log(`[${MC_USERNAME}] joined ${MC_HOST}:${MC_PORT}`);
  });

  bot.on("kicked", (reason) => {
    console.log(
      `[${MC_USERNAME}] kicked: ${reason}, reconnecting in ${RETRY_MS}ms`,
    );
  });

  bot.on("end", async () => {
    console.log(`[${MC_USERNAME}] disconnected, reconnecting in ${RETRY_MS}ms`);
    await connectWithRetry({ delayMs: RETRY_MS });
  });

  bot.on("error", (err) => {
    console.log(`[${MC_USERNAME}] error: ${err.message}`);
  });
}

function makeBot({ username, host, port, version = "1.21" }) {
  const bot = mineflayer.createBot({
    host,
    port,
    username,
    version,
    checkTimeoutInterval: 10 * 60 * 1000,
  });

  bot.on("kicked", (reason) => console.log(`[${username}] kicked:`, reason));
  bot.on("error", (err) => console.log(`[${username}] error:`, err));

  return bot;
}

main().catch((err) => {
  console.error(`[${MC_USERNAME}] fatal error`, err);
});
