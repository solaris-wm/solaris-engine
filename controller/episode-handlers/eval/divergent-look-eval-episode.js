const { sneak } = require("../../primitives/movement");
const { BaseEpisode } = require("../base-episode");

const EPISODE_MIN_TICKS = 300;

function getOnDivergentLookPhaseFn(
  bot,
  rcon,
  sharedBotRng,
  coordinator,
  episodeNum,
  episodeInstance,
  args,
) {
  return async (peerMap) => {
    coordinator.broadcastToPeers(
      "divergentLookPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      "divergentLookPhase beginning",
    );

    episodeInstance._evalMetadata = {
      yaw_alpha: episodeInstance._yawAlpha,
      yaw_bravo: episodeInstance._yawBravo,
    };

    // Sneak to signal evaluation start
    await sneak(bot);
    const startTick = bot.time.age;

    console.log(
      `[${bot.username}] Divergent look: holding still for ${EPISODE_MIN_TICKS} ticks`,
    );

    // Hold completely still for EPISODE_MIN_TICKS
    const endTick = bot.time.age;
    const remaining = EPISODE_MIN_TICKS - (endTick - startTick);
    if (remaining > 0) {
      await bot.waitForTicks(remaining);
    }

    // Setup stop phase
    coordinator.exchangeWithPeers(
      "stopPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      episodeInstance.getOnStopPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        args,
      ),
      { location: "divergentLookPhase end" },
    );
  };
}

/**
 * Eval episode where both bots face random divergent directions and hold still;
 * used to evaluate pose-awareness for gaze direction prediction.
 * @extends BaseEpisode
 */
class DivergentLookEvalEpisode extends BaseEpisode {
  static WORKS_IN_NON_FLAT_WORLD = true;
  static INIT_MIN_BOTS_DISTANCE = 10;
  static INIT_MAX_BOTS_DISTANCE = 12;
  static ACCEPTED_BIOMES = [
    "desert", "badlands", "eroded_badlands", "wooded_badlands",
    "snowy_plains", "snowy_taiga", "snowy_beach", "snowy_slopes",
    "frozen_peaks", "ice_spikes", "frozen_river",
    "savanna", "savanna_plateau", "windswept_savanna",
    "swamp", "mangrove_swamp", "cherry_grove", "mushroom_fields",
  ];

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
    const peerName = coordinator.getSinglePeerName();
    // Generate two random yaw values
    const yaw1 = sharedBotRng() * 2 * Math.PI - Math.PI;
    const yaw2 = sharedBotRng() * 2 * Math.PI - Math.PI;

    // Assign yaws deterministically by name sorting
    const isAlpha = bot.username < peerName;
    const myYaw = isAlpha ? yaw1 : yaw2;

    // Store yaw values on instance for the phase handler to set metadata
    this._yawAlpha = yaw1;
    this._yawBravo = yaw2;

    // Compute a fake "other bot position" 10 blocks in the assigned yaw direction.
    // The framework will auto-orient this bot to face that point before recording starts.
    // In Minecraft, yaw = atan2(-dx, -dz), so to get a point at a given yaw:
    //   dx = -sin(yaw), dz = -cos(yaw)
    const dx = -Math.sin(myYaw);
    const dz = -Math.cos(myYaw);
    const fakeTarget = botPosition.offset(dx * 10, 0, dz * 10);

    return fakeTarget;
  }

  async entryPoint(
    bot,
    rcon,
    sharedBotRng,
    coordinator,
    iterationID,
    episodeNum,
    args,
  ) {
    coordinator.exchangeWithPeers(
      "divergentLookPhase",
      { position: bot.entity.position.clone() },
      episodeNum,
      getOnDivergentLookPhaseFn(
        bot,
        rcon,
        sharedBotRng,
        coordinator,
        episodeNum,
        this,
        args,
      ),
      { location: "teleportPhase end" },
    );
  }
}

module.exports = { DivergentLookEvalEpisode };
