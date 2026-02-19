const { Rcon } = require("rcon-client");

/**
 * Sleep utility
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Connect to RCON server
 * @param {string} host - RCON host
 * @param {number} port - RCON port
 * @param {string} password - RCON password
 * @returns {Promise<Rcon>} RCON connection
 */
async function connectRcon(host, port, password) {
  return Rcon.connect({
    host: host,
    port: Number(port),
    password: password,
  });
}

/**
 * Execute RCON command with automatic connection management
 * @param {string} host - RCON host
 * @param {number} port - RCON port
 * @param {string} password - RCON password
 * @param {Function} task - Async function that receives rcon connection
 * @returns {Promise<any>} Result from task function
 */
async function useRcon(host, port, password, task) {
  const rcon = await connectRcon(host, port, password);
  try {
    return await task(rcon);
  } finally {
    try {
      await rcon.end();
    } catch (err) {
      console.warn(
        "[camera-ready] Failed to close RCON connection:",
        err?.message || err,
      );
    }
  }
}

/**
 * Extract player names from RCON list command response
 * @param {string} listResponse - Response from 'list' command
 * @returns {Set<string>} Set of player names
 */
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

/**
 * Wait for both camera clients to join the Minecraft server
 * @param {string} rconHost - RCON server host
 * @param {number} rconPort - RCON server port
 * @param {string} rconPassword - RCON password
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} checkInterval - Milliseconds between checks
 * @returns {Promise<boolean>} True if both cameras found, false if timeout
 */
async function waitForCameras(
  rconHost,
  rconPort,
  rconPassword,
  maxRetries,
  checkInterval,
) {
  const cameraNames = ["CameraAlpha", "CameraBravo"];

  console.log(`[camera-ready] Waiting for cameras: ${cameraNames.join(", ")}`);
  console.log(
    `[camera-ready] Max retries: ${maxRetries}, check interval: ${checkInterval}ms`,
  );

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const list = await useRcon(rconHost, rconPort, rconPassword, (rcon) =>
        rcon.send("list"),
      );
      const players = extractPlayers(list);

      const foundCameras = cameraNames.filter((name) => players.has(name));
      const missingCameras = cameraNames.filter((name) => !players.has(name));

      if (foundCameras.length === cameraNames.length) {
        console.log(
          `[camera-ready] All cameras present: ${foundCameras.join(", ")}`,
        );
        return true;
      }

      console.log(
        `[camera-ready] Attempt ${attempt}/${maxRetries}: ` +
          `Found [${foundCameras.join(", ") || "none"}], ` +
          `Missing [${missingCameras.join(", ")}], ` +
          `All players: [${Array.from(players).join(", ") || "none"}]`,
      );
    } catch (err) {
      console.warn(
        `[camera-ready] Failed to query player list (attempt ${attempt}/${maxRetries}):`,
        err?.message || err,
      );
    }

    // Don't sleep after the last attempt
    if (attempt < maxRetries) {
      await sleep(checkInterval);
    }
  }

  console.error(
    `[camera-ready] Timeout: Cameras did not join within ${maxRetries} attempts`,
  );
  return false;
}

module.exports = {
  waitForCameras,
  extractPlayers,
};
