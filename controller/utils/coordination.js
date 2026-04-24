const EventEmitter = require("events");
const net = require("net");

function pickRandom(array, sharedBotRng) {
  const sortedArray = array.slice().sort();
  return sortedArray[Math.floor(sharedBotRng() * sortedArray.length)];
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
  constructor(botName, coordPort, peers) {
    super();
    this.botName = botName;
    this.coordPort = coordPort;
    this.peers = peers; // [{name, host, port}] — N-1 entries, one per remote peer
    this.clientConnections = new Map(); // peerName -> Socket (outbound to each peer)
    this.server = null;
    this.executingEvents = new Map(); // unique key -> true; in-flight handler tracking for waitForAllPhasesToFinish
    this.eventCounter = 0; // monotonic; mints unique keys for executingEvents
  }

  async setupConnections() {
    console.log(`[${this.botName}] Setting up connections...`);

    const clientPromises = this.peers.map((peer) => this.setupClient(peer));
    const [serverReady, ...clientsReady] = await Promise.all([
      this.setupServer(),
      ...clientPromises,
    ]);

    console.log(
      `[${this.botName}] All connections established - server ready: ${serverReady}, clients ready: ${clientsReady.length}/${this.peers.length}`,
    );
    return { serverReady, clientsReady };
  }

  setupServer() {
    return new Promise((resolve) => {
      const expectedPeers = this.peers.length;
      let connectedPeers = 0;

      this.server = net.createServer((socket) => {
        console.log(`[${this.botName} Server] Peer connected`);
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
                const { eventName, eventParams, from } = message;
                const listenerCount = this.listenerCount(eventName);
                if (listenerCount > 0) {
                  console.log(
                    `[${this.botName} Server] Received: ${eventName} from ${from} (${listenerCount} listeners) - emitting`,
                  );
                  this.emit(eventName, eventParams, from);
                } else {
                  console.log(
                    `[${this.botName} Server] Received: ${eventName} from ${from} (no listeners) - dropped`,
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
          console.log(`[${this.botName} Server] Peer disconnected`);
        });

        connectedPeers++;
        if (connectedPeers === expectedPeers) {
          resolve(true);
        }
      });

      this.server.listen(this.coordPort, () => {
        console.log(
          `[${this.botName} Server] Listening on port ${this.coordPort}, waiting for ${expectedPeers} peer(s) to connect...`,
        );
      });
    });
  }

  setupClient(peer) {
    return new Promise((resolve) => {
      const attemptConnection = () => {
        const socket = net.createConnection(
          { host: peer.host, port: peer.port },
          () => {
            console.log(
              `[${this.botName} Client] Connected to ${peer.name} at ${peer.host}:${peer.port}`,
            );
            this.clientConnections.set(peer.name, socket);
            resolve(true);
          },
        );

        socket.on("error", (err) => {
          console.log(
            `[${this.botName} Client] Connection to ${peer.name} failed, retrying in 2s:`,
            err.message,
          );
          setTimeout(attemptConnection, 2000);
        });

        socket.on("close", () => {
          console.log(
            `[${this.botName} Client] Disconnected from ${peer.name}`,
          );
          this.clientConnections.delete(peer.name);
          setTimeout(attemptConnection, 2000); // Auto-reconnect
        });
      };

      attemptConnection();
    });
  }

  broadcastToPeers(eventName, eventParams, episodeNum, location) {
    eventName = getEventName(eventName, episodeNum);
    const peerNames = [...this.clientConnections.keys()];
    if (peerNames.length === 0) {
      console.log(
        `[broadcastToPeers] ${location}: No peer connections available for ${eventName}`,
      );
      return;
    }
    const message = JSON.stringify({
      eventName,
      eventParams,
      from: this.botName,
    });
    console.log(
      `[broadcastToPeers] ${location}: Sending ${eventName} to ${peerNames.join(", ")}`,
    );
    for (const socket of this.clientConnections.values()) {
      socket.write(message + "\n");
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

  exchangeWithPeers(eventName, eventParams, episodeNum, handler, { location }) {
    const fullEventName = getEventName(eventName, episodeNum);
    const eventId = this.eventCounter++;
    const uniqueKey = `${fullEventName}_${eventId}`;
    const expectedPeers = this.peers.length;
    const peerMap = new Map();

    const accumulate = async (params, from) => {
      peerMap.set(from, params);
      if (peerMap.size === expectedPeers) {
        this.off(fullEventName, accumulate);
        this.executingEvents.set(uniqueKey, true);
        try {
          await handler(peerMap);
        } finally {
          this.executingEvents.delete(uniqueKey);
        }
      }
    };

    this.on(fullEventName, accumulate);
    this.broadcastToPeers(eventName, eventParams, episodeNum, location);
  }

  syncAllPeers(eventName, eventParams, episodeNum, { location }) {
    return new Promise((resolve) => {
      this.exchangeWithPeers(
        eventName,
        eventParams,
        episodeNum,
        (peerMap) => {
          this.broadcastToPeers(eventName, eventParams, episodeNum, location);
          resolve(peerMap);
        },
        { location },
      );
    });
  }

  getAllPlayerNames() {
    return [this.botName, ...this.peers.map((p) => p.name)].sort();
  }

  getSinglePeerName() {
    return this.peers[0].name;
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
}

function getEventName(eventName, episodeNum) {
  return `episode_${episodeNum}_${eventName}`;
}

module.exports = {
  rconTp,
  BotCoordinator,
  pickRandom,
};
