const { MAX_BOTS_DISTANCE, MIN_BOTS_DISTANCE } = require("../utils/constants");
const { sleep } = require("../utils/helpers");

/**
 * Base episode lifecycle: setupEpisode, entryPoint, tearDownEpisode, and stop-phase coordination.
 * Subclasses override entryPoint (required), and optionally setupEpisode and tearDownEpisode.
 * @abstract
 */
class BaseEpisode {
  static INIT_MIN_BOTS_DISTANCE = MIN_BOTS_DISTANCE;
  static INIT_MAX_BOTS_DISTANCE = MAX_BOTS_DISTANCE;
  static WORKS_IN_NON_FLAT_WORLD = false;
  static SUPPORTS_N_PLAYER = false;

  constructor(sharedBotRng) {
    // This constructor intentionally does nothing with sharedBotRng
  }

  /**
   * Optional setup hook. No-op by default.
   * @returns {Promise<Vec3>} Position for the bot to look at after setup.
   */
  async setupEpisode(
    bot,
    rcon,
    sharedBotRng,
    coordinator,
    episodeNum,
    args,
    botPosition,
    peerPositionsMap,
  ) {
    return peerPositionsMap.values().next().value;
  }

  /**
   * Main episode logic. Must be implemented by subclasses.
   * @returns {Promise<any>}
   */
  async entryPoint(
    bot,
    rcon,
    sharedBotRng,
    coordinator,
    iterationID,
    episodeNum,
    args,
  ) {
    throw new Error("entryPoint() must be implemented by subclass");
  }

  /**
   * Optional teardown hook. No-op by default.
   * @returns {Promise<void>}
   */
  async tearDownEpisode(
    bot,
    rcon,
    sharedBotRng,
    coordinator,
    episodeNum,
    args,
  ) {}

  /**
   * Creates the onStopPhase handler function.
   * @param {Object} bot - The bot instance
   * @param {Object} sharedBotRng - Shared random number generator
   * @param {Object} coordinator - Coordinator for bot communication
   * @returns {Function} Async function that handles the stop phase
   */
  getOnStopPhaseFn(
    bot,
    rcon,
    sharedBotRng,
    coordinator,
    episodeNum,
    args,
  ) {
    return async (peerMap) => {
      if (bot._episodeStopping) {
        console.log(
          `[${bot.username}] Episode already stopping, skipping stop phase.`,
        );
        return;
      }
      bot._episodeStopping = true;
      coordinator.broadcastToPeers(
        "stopPhase",
        bot.entity.position.clone(),
        episodeNum,
        "stopPhase beginning",
      );
      if (this._episodeRecordingStarted) {
        console.log(`[${bot.username}] stops recording`);
        bot.emit("endepisode");
        console.log(
          `[${bot.username}] waiting for episode recording to end...`,
        );
        await new Promise((resolve) => {
          bot.once("episodeended", resolve);
        });
        console.log(
          `[${bot.username}] episode recording ended, connection closed`,
        );
        await sleep(1000);
      } else {
        console.log(
          `[${bot.username}] episode not started, skipping recording.`,
        );
      }

      coordinator.exchangeWithPeers(
        "stoppedPhase",
        bot.entity.position.clone(),
        episodeNum,
        this.getOnStoppedPhaseFn(
          bot,
          sharedBotRng,
          coordinator,
          episodeNum,
          bot._currentEpisodeResolve,
        ),
        { location: "StopPhase end" },
      );
    };
  }

  /**
   * Creates the onStoppedPhase handler function.
   * @param {Object} bot - The bot instance
   * @param {Object} sharedBotRng - Shared random number generator
   * @param {Object} coordinator - Coordinator for bot communication
   * @param {number} episodeNum - Episode number
   * @param {Function} episodeResolve - Function to resolve the episode promise
   * @returns {Function} Async function that handles the stopped phase
   */
  getOnStoppedPhaseFn(
    bot,
    sharedBotRng,
    coordinator,
    episodeNum,
    episodeResolve,
  ) {
    return async (peerMap) => {
      coordinator.broadcastToPeers(
        "stoppedPhase",
        bot.entity.position.clone(),
        episodeNum,
        "stoppedPhase beginning",
      );
      console.log(`[${bot.username}] stopped`);
      // Resolve the episode promise instead of exiting
      episodeResolve();
    };
  }
}

module.exports = { BaseEpisode };
