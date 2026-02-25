// Typical episode lengths in seconds (used for weighted random sampling)
// Weight = 1 / sqrt(length), so shorter episodes are sampled more frequently
const episodeTypicalLengths = {
  straightLineWalk: 20,
  chase: 10,
  orbit: 60,
  walkLook: 60,
  walkLookAway: 60,
  pvp: 15,
  pve: 60,
  buildStructure: 15,
  buildTower: 12,
  mine: 10,
  towerBridge: 22,
  buildHouse: 120,
  collector: 150,
  placeAndMine: 120,
  structureEval: 60,
  translationEval: 60,
  bothLookAwayEval: 60,
  oneLooksAwayEval: 60,
  rotationEval: 60,
  turnToLookEval: 60,
  turnToLookOppositeEval: 60,
};

/**
 * Weighted random selection based on inverse square root of episode lengths
 * @param {string[]} episodeTypes - Array of eligible episode type names
 * @param {Function} sharedBotRng - Random number generator function (returns 0-1)
 * @param {boolean} uniform - If true, use uniform weights instead of length-based weights
 * @param {boolean} ignoreEvalEpisodes - If true, filter out episode types ending in "Eval"
 * @returns {string} Selected episode type
 */
function selectWeightedEpisodeType(
  episodeTypes,
  sharedBotRng,
  uniform = false,
  ignoreEvalEpisodes = true,
) {
  // Filter out eval episodes if requested
  const filteredTypes = ignoreEvalEpisodes
    ? episodeTypes.filter((type) => !type.toLowerCase().endsWith("eval"))
    : episodeTypes;

  if (filteredTypes.length === 0) {
    throw new Error(
      "No episode types available to sample from after filtering out eval episodes",
    );
  }

  // Calculate weights: uniform or 1 / sqrt(length) for each episode type
  const weights = filteredTypes.map((type) => {
    if (uniform) {
      return 1;
    }
    const length = episodeTypicalLengths[type];
    if (length === undefined) {
      throw new Error(
        `Episode type "${type}" not found in episodeTypicalLengths`,
      );
    }
    return 1 / Math.sqrt(length);
  });

  // Calculate cumulative weights for sampling
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const cumulativeWeights = [];
  let cumulative = 0;
  for (const w of weights) {
    cumulative += w / totalWeight; // normalize
    cumulativeWeights.push(cumulative);
  }

  // Sample using the sharedBotRng
  const r = sharedBotRng();
  for (let i = 0; i < cumulativeWeights.length; i++) {
    if (r < cumulativeWeights[i]) {
      return filteredTypes[i];
    }
  }

  // Fallback to last element (handles floating point edge cases)
  return filteredTypes[filteredTypes.length - 1];
}

module.exports = {
  episodeTypicalLengths,
  selectWeightedEpisodeType,
};
