import { Rcon } from "rcon-client";

const {
  RCON_HOST = "127.0.0.1",
  RCON_PORT = "25575",
  RCON_PASSWORD = "research",
  EPISODE_REQUIRED_PLAYERS = "",
  EPISODE_START_COMMAND = "episode start",
  EPISODE_START_RETRIES = "15",
  EPISODE_PLAYER_CHECK_INTERVAL_MS = "2000",
} = process.env;

const requiredPlayers = parsePlayers(EPISODE_REQUIRED_PLAYERS);
const maxAttempts = Number(EPISODE_START_RETRIES);
const retryDelayMs = Number(EPISODE_PLAYER_CHECK_INTERVAL_MS) || 2000;

async function connect() {
  return Rcon.connect({
    host: RCON_HOST,
    port: Number(RCON_PORT),
    password: RCON_PASSWORD,
  });
}

async function useRcon(task) {
  const rcon = await connect();
  try {
    return await task(rcon);
  } finally {
    try {
      await rcon.end();
    } catch (err) {
      console.warn(
        "[episode-starter] failed to close RCON connection:",
        err?.message || err,
      );
    }
  }
}

async function waitForPlayers() {
  if (requiredPlayers.length === 0) {
    console.log(
      "[episode-starter] No required players configured; continuing immediately",
    );
    return true;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const list = await useRcon((rcon) => rcon.send("list"));
      const players = extractPlayers(list);
      if (requiredPlayers.every((name) => players.has(name))) {
        console.log(
          "[episode-starter] Required players present:",
          requiredPlayers.join(", "),
        );
        return true;
      }
      console.log(
        `[episode-starter] Waiting for players (attempt ${attempt}/${maxAttempts}): ${Array.from(players).join(", ")}`,
      );
    } catch (err) {
      console.warn(
        "[episode-starter] Failed to query player list:",
        err?.message || err,
      );
    }
    await sleep(retryDelayMs);
  }
  console.error("[episode-starter] Players never appeared; giving up");
  return false;
}

function extractPlayers(listResponse) {
  const players = new Set();
  const match = listResponse.match(/: (.*)$/);
  if (!match) {
    return players;
  }
  const namesSection = match[1].trim();
  if (!namesSection) {
    return players;
  }
  for (const name of namesSection.split(",").map((n) => n.trim())) {
    if (name) {
      players.add(name);
    }
  }
  return players;
}

async function triggerCommand() {
  const command = EPISODE_START_COMMAND.trim();
  if (!command) {
    console.log("[episode-starter] No command configured; nothing to send");
    return;
  }
  try {
    const response = await useRcon((rcon) => rcon.send(command));
    console.log("[episode-starter] command response:", response?.trim());
  } catch (err) {
    console.error(
      "[episode-starter] Failed to issue command:",
      err?.message || err,
    );
  }
}

async function main() {
  console.log("[episode-starter] waiting for server players");
  const ready = await waitForPlayers();
  if (!ready) {
    process.exit(1);
  }
  await triggerCommand();
  process.exit(0);
}

function parsePlayers(rawList) {
  return Array.from(
    new Set(
      (rawList || "")
        .split(/[, ]+/)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
