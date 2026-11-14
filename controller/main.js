/**
 * Modularized Minecraft Bot Coordination System
 *
 * This is the new modular version of controller.js with improved code organization.
 * All utility functions have been extracted into separate modules for better maintainability.
 */

const { parseArgs } = require("./config/args");
const { getOnSpawnFn } = require("./episodes-loop");
const { makeBot } = require("./utils/bot-factory");
const { BotCoordinator } = require("./utils/coordination");
const { sleep } = require("./utils/helpers");

function parsePeerEndpoints(peerEndpoints) {
  if (!peerEndpoints) {
    throw new Error(
      "peer_endpoints is required; entrypoint must pass Name:host:port entries for all peers",
    );
  }
  return peerEndpoints
    .split(",")
    .map((endpoint) => endpoint.trim())
    .filter(Boolean)
    .map((endpoint) => {
      const [name, host, port] = endpoint.split(":");
      if (!name || !host || !port) {
        throw new Error(
          `Invalid peer endpoint "${endpoint}". Expected Name:host:port`,
        );
      }
      return { name, host, port: Number(port) };
    });
}

/**
 * Main function to initialize and run the bot
 */
async function main() {
  // Parse command line arguments
  const args = parseArgs();
  const peers = parsePeerEndpoints(args.peer_endpoints);

  console.log(`Starting bot: ${args.bot_name}`);
  console.log(
    `Coordinator: ${args.bot_name}, Port: ${args.coord_port}, Peers: ${peers.map((p) => `${p.name}@${p.host}:${p.port}`).join(",")}`,
  );
  console.log(
    `[${args.bot_name}] Waiting ${args.bootstrap_wait_time} seconds before creating bot...`,
  );

  // Wait for bootstrap time
  await sleep(args.bootstrap_wait_time * 1000);

  // Create bot instance
  const bot = makeBot({
    username: args.bot_name,
    host: args.host,
    port: args.port,
    version: args.mc_version,
  });

  const coordinator = new BotCoordinator(args.bot_name, args.coord_port, peers);

  // Set up spawn event handler
  bot.once(
    "spawn",
    getOnSpawnFn(
      bot,
      args.act_recorder_host,
      args.act_recorder_port,
      coordinator,
      args,
    ),
  );

  // Handle system chat packets
  bot._client.on("packet", (data, meta) => {
    if (meta.name === "system_chat" && data && data.content) {
      console.log("SYSTEM:", JSON.stringify(data.content));
    }
  });
}

// Run the main function
main().catch(console.error);
