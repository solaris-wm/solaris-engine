const EventEmitter = require("events");
const net = require("net");

function pickRandom(array, sharedBotRng) {
  const sortedArray = array.slice().sort();
  return sortedArray[Math.floor(sharedBotRng() * sortedArray.length)];
}

function decidePrimaryBot(bot, sharedBotRng, args) {
  const primaryBotName = pickRandom(
    [bot.username, args.other_bot_name],
    sharedBotRng,
  );
  return bot.username === primaryBotName;
}
/**
 * RCON teleportation function
 * @param {string} name - Player name
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {number} z - Z coordinate
 * @returns {Promise<string>} RCON response
 */
async function rconTp(rcon, name, x, y, z) {
  const res = await rcon.send(`tp ${name} ${x} ${y} ${z}`);
  return res;
}

/**
 * Bot coordination class for inter-bot communication via TCP sockets
 */
class BotCoordinator extends EventEmitter {
  constructor(botName, coordPort, otherCoordHost, otherCoordPort) {
    super();
    this.botName = botName;
    this.coordPort = coordPort;
    this.otherCoordHost = otherCoordHost;
    this.otherCoordPort = otherCoordPort;
    this.clientConnection = null;
    this.server = null;
    this.executingEvents = new Map(); // Track currently executing event handlers
    this.eventCounter = 0; // Auto-incrementing counter for unique event tracking
  }

  async setupConnections() {
    console.log(`[${this.botName}] Setting up connections...`);

    // Set up server and client connections in parallel and wait for both to be ready
    const [serverReady, clientReady] = await Promise.all([
      this.setupServer(),
      this.setupClient(),
    ]);

    console.log(
      `[${this.botName}] All connections established - server ready: ${serverReady}, client ready: ${clientReady}`,
    );
    return { serverReady, clientReady };
  }

  setupServer() {
    return new Promise((resolve) => {
      this.server = net.createServer((socket) => {
        console.log(`[${this.botName} Server] Other bot connected`);
        let buffer = "";

        socket.on("data", (data) => {
          buffer += data.toString();
          let lines = buffer.split("\n");

          // Keep the last incomplete line in the buffer
          buffer = lines.pop();

          // Process each complete line
          lines.forEach((line) => {
            if (line.trim()) {
              try {
                const message = JSON.parse(line);
                const listenerCount = this.listenerCount(message.eventName);
                if (listenerCount > 0) {
                  console.log(
                    `[${this.botName} Server] Received: ${message.eventName} (${listenerCount} listeners) - emitting`,
                  );
                  this.emit(message.eventName, message.eventParams);
                } else {
                  console.log(
                    `[${this.botName} Server] Received: ${message.eventName} (no listeners)`,
                  );
                }
              } catch (err) {
                console.error(
                  `[${
                    this.botName
                  } Server] Parse error: ${err}, message: ${data.toString()}`,
                );
                console.error(
                  `[${this.botName} Server] Problematic line:`,
                  line,
                );
              }
            }
          });
        });
        socket.on("close", () => {
          console.log(`[${this.botName} Server] Other bot disconnected`);
        });

        // Resolve when the other bot connects to our server
        resolve(true);
      });

      this.server.listen(this.coordPort, () => {
        console.log(
          `[${this.botName} Server] Listening on port ${this.coordPort}, waiting for other bot to connect...`,
        );
      });
    });
  }

  setupClient() {
    return new Promise((resolve) => {
      const attemptConnection = () => {
        this.clientConnection = net.createConnection(
          { host: this.otherCoordHost, port: this.otherCoordPort },
          () => {
            console.log(
              `[${this.botName} Client] Connected to other bot's server at ${this.otherCoordHost}:${this.otherCoordPort}`,
            );
            resolve(true);
          },
        );

        this.clientConnection.on("error", (err) => {
          console.log(
            `[${this.botName} Client] Connection failed, retrying in 2s:`,
            err.message,
          );
          setTimeout(attemptConnection, 2000);
        });

        this.clientConnection.on("close", () => {
          console.log(`[${this.botName} Client] Disconnected from other bot`);
          this.clientConnection = null;
          setTimeout(attemptConnection, 2000); // Auto-reconnect
        });
      };

      attemptConnection();
    });
  }

  sendToOtherBot(eventName, eventParams, episodeNum, location) {
    eventName = getEventName(eventName, episodeNum);
    if (this.clientConnection) {
      const message = JSON.stringify({ eventName, eventParams });
      console.log(
        `[sendToOtherBot] ${location}: Sending ${eventName} via client connection`,
      );
      this.clientConnection.write(message + "\n");
    } else {
      console.log(
        `[sendToOtherBot] ${location}: No client connection available for ${eventName}`,
      );
    }
  }

  onceEvent(eventName, episodeNum, handler) {
    const fullEventName = getEventName(eventName, episodeNum);
    const eventId = this.eventCounter++;
    const uniqueKey = `${fullEventName}_${eventId}`;

    const wrappedHandler = async (...args) => {
      // Mark event as executing with unique key
      this.executingEvents.set(uniqueKey, true);

      try {
        // Execute the handler (supports both sync and async handlers)
        await handler(...args);
      } finally {
        // Remove event from executing map when done
        this.executingEvents.delete(uniqueKey);
      }
    };

    this.once(fullEventName, wrappedHandler);
  }

  async waitForAllPhasesToFinish() {
    let lastLogTime = 0;
    const logIntervalMs = 2000;

    while (this.executingEvents.size > 0) {
      const now = Date.now();

      if (now - lastLogTime >= logIntervalMs) {
        console.log(
          `[${this.botName}] Waiting for ${
            this.executingEvents.size
          } event(s) to finish: ${[...this.executingEvents.keys()].join(", ")}`,
        );
        lastLogTime = now;
      }
      // Wait a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.log(`[${this.botName}] All event handlers finished`);
  }

  async syncBots(episodeNum) {
    return new Promise((resolve) => {
      this.onceEvent("syncBots", episodeNum, () => {
        this.sendToOtherBot("syncBots", {}, episodeNum, `syncBots beginning`);
        console.log(`[${this.botName}] Syncing bots...`);
        resolve();
      });
      this.sendToOtherBot("syncBots", {}, episodeNum, `syncBots outer`);
    });
  }
}

function getEventName(eventName, episodeNum) {
  return `episode_${episodeNum}_${eventName}`;
}

module.exports = {
  rconTp,
  BotCoordinator,
  decidePrimaryBot,
  pickRandom,
};
