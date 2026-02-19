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

  constructor(sharedBotRng) {
    // This constructor intentionally does nothing with sharedBotRng
  }

  /**
   * Optional setup hook. No-op by default.
   * @returns {Promise<{botPositionNew: Vec3, otherBotPositionNew: Vec3}>}
   */
  async setupEpisode(
    bot,
    rcon,
    sharedBotRng,
    coordinator,
    episodeNum,
    args,
    botPosition,
    otherBotPosition,
  ) {
    return {
      botPositionNew: botPosition,
      otherBotPositionNew: otherBotPosition,
    };
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
   * @param {string} otherBotName - Name of the other bot
   * @returns {Function} Async function that handles the stop phase
   */
  getOnStopPhaseFn(
    bot,
    rcon,
    sharedBotRng,
    coordinator,
    otherBotName,
    episodeNum,
    args,
  ) {
    return async (otherBotPosition) => {
      if (bot._episodeStopping) {
        console.log(
          `[${bot.username}] Episode already stopping, skipping stop phase.`,
        );
        return;
      }
      bot._episodeStopping = true;
      coordinator.sendToOtherBot(
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

      // Wait for the connection to actually close

      coordinator.onceEvent(
        "stoppedPhase",
        episodeNum,
        this.getOnStoppedPhaseFn(
          bot,
          sharedBotRng,
          coordinator,
          otherBotName,
          episodeNum,
          bot._currentEpisodeResolve,
        ),
      );
      coordinator.sendToOtherBot(
        "stoppedPhase",
        bot.entity.position.clone(),
        episodeNum,
        "StopPhase end",
      );
    };
  }

  /**
   * Creates the onStoppedPhase handler function.
   * @param {Object} bot - The bot instance
   * @param {Object} sharedBotRng - Shared random number generator
   * @param {Object} coordinator - Coordinator for bot communication
   * @param {string} otherBotName - Name of the other bot
   * @param {number} episodeNum - Episode number
   * @param {Function} episodeResolve - Function to resolve the episode promise
   * @returns {Function} Async function that handles the stopped phase
   */
  getOnStoppedPhaseFn(
    bot,
    sharedBotRng,
    coordinator,
    otherBotName,
    episodeNum,
    episodeResolve,
  ) {
    return async (otherBotPosition) => {
      coordinator.sendToOtherBot(
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
