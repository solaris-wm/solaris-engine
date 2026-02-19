// building.js - Utilities for collaborative house building episodes
const { Movements } = require("mineflayer-pathfinder");
const {
  goals: { GoalNear },
} = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");

const { digWithTimeout } = require("./digging");
const { ensureItemInHand } = require("./items");
const {
  getScaffoldingBlockIds,
  gotoWithTimeout,
  initializePathfinder,
  stopPathfinder,
} = require("./movement");

// Cardinal directions for finding reference blocks (faces to click)
// Ordered by preference: Top face first (easiest), then horizontals, then bottom
const CARDINALS = [
  new Vec3(0, 1, 0), // +Y (top) - PREFERRED: easiest to place on
  new Vec3(-1, 0, 0), // -X (west)
  new Vec3(1, 0, 0), // +X (east)
  new Vec3(0, 0, -1), // -Z (north)
  new Vec3(0, 0, 1), // +Z (south)
  new Vec3(0, -1, 0), // -Y (bottom) - LAST: hardest to place on
];

/**
 * Check if a block is air or air-like (passable)
 * @param {*} block - Block to check
 * @returns {boolean} True if air-like
 */
function isAirLike(block) {
  return !block || block.name === "air" || block.boundingBox === "empty";
}

/**
 * Check if a position is within reach
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} pos - Position to check
 * @param {number} max - Maximum reach distance
 * @returns {boolean} True if in reach
 */
function inReach(bot, pos, max = 4.5) {
  return bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= max;
}

/**
 * Calculate a score for how good a face is for placement
 * Considers bot's view direction, face orientation, and accessibility
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} faceVec - Face vector (normal direction)
 * @param {Vec3} refBlockPos - Position of reference block
 * @returns {number} Score from 0-100 (higher is better)
 */
function scoreFace(bot, faceVec, refBlockPos) {
  let score = 50; // Base score

  // Get bot's view direction (normalized)
  const yaw = bot.entity.yaw;
  const pitch = bot.entity.pitch;
  const viewDir = new Vec3(
    -Math.sin(yaw) * Math.cos(pitch),
    -Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  );

  // Calculate dot product between view direction and face normal
  // Dot product: 1 = facing directly, 0 = perpendicular, -1 = facing away
  const dotProduct =
    viewDir.x * faceVec.x + viewDir.y * faceVec.y + viewDir.z * faceVec.z;

  // Bonus for faces the bot is already looking at (0 to +30 points)
  if (dotProduct > 0) {
    score += dotProduct * 30;
  } else {
    // Penalty for faces behind the bot (-20 to 0 points)
    score += dotProduct * 20;
  }

  // Bonus for horizontal faces (+10 points) - easier to reach and see
  if (faceVec.y === 0) {
    score += 10;
  }

  // Extra bonus for top face (+15 points) - most natural placement
  if (faceVec.y === 1) {
    score += 15;
  }

  // Penalty for bottom face (-10 points) - hardest to place on
  if (faceVec.y === -1) {
    score -= 10;
  }

  // Bonus for closer blocks (+0 to +10 points based on distance)
  const distance = bot.entity.position.distanceTo(refBlockPos);
  const maxReach = bot.game.gameMode === 1 ? 6 : 4.5;
  if (distance <= maxReach) {
    score += (1 - distance / maxReach) * 10;
  }

  // Clamp score to 0-100 range
  return Math.max(0, Math.min(100, score));
}

/**
 * Find the best reference block and face for placing at targetPos
 * Enhanced version with visibility checks and scoring
 * Returns all viable candidates for fallback support
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} targetPos - Target position to place block
 * @param {Object} options - Options {returnAll: boolean, minScore: number}
 * @returns {Object|Array|null} Best candidate, all candidates array, or null
 */
function findBestPlaceReference(bot, targetPos, options = {}) {
  const { returnAll = false, minScore = 0 } = options;
  const candidates = [];

  // Validation: Check if targetPos is valid
  if (
    !targetPos ||
    typeof targetPos.x !== "number" ||
    typeof targetPos.y !== "number" ||
    typeof targetPos.z !== "number"
  ) {
    console.warn(`[${bot.username}] ⚠️ Invalid target position:`, targetPos);
    return returnAll ? [] : null;
  }

  // Try all 6 cardinal directions
  for (const face of CARDINALS) {
    try {
      const refPos = targetPos.plus(face); // Position of block we'd click on
      const refBlock = bot.blockAt(refPos);

      // Skip if no block exists at this position
      if (!refBlock) continue;

      // Only click on solid blocks (not air, not liquids, not transparent)
      if (refBlock.boundingBox !== "block") continue;
      if (refBlock.material === "noteblock") continue; // Skip note blocks (can be problematic)

      // Check if bot can see this block (basic visibility check)
      if (!bot.canSeeBlock(refBlock)) continue;

      // Face vector is the opposite of the offset from ref to target
      const faceVec = new Vec3(-face.x, -face.y, -face.z);

      // Calculate face center point for detailed checks
      const faceCenter = refBlock.position.offset(
        0.5 + faceVec.x * 0.5,
        0.5 + faceVec.y * 0.5,
        0.5 + faceVec.z * 0.5,
      );

      // Check if the face itself is obstructed by another block
      // (e.g., if there's a block between the reference block and target)
      const obstructionPos = refPos.plus(faceVec);
      const obstructionBlock = bot.blockAt(obstructionPos);
      if (
        obstructionBlock &&
        obstructionBlock.boundingBox === "block" &&
        !obstructionPos.equals(targetPos)
      ) {
        // Face is blocked by another solid block
        continue;
      }

      // Calculate score for this face
      const score = scoreFace(bot, faceVec, refBlock.position);

      // Only include candidates above minimum score threshold
      if (score >= minScore) {
        candidates.push({
          refBlock,
          faceVec,
          score,
          distance: bot.entity.position.distanceTo(refBlock.position),
        });
      }
    } catch (error) {
      // Gracefully handle errors for individual faces
      console.warn(
        `[${bot.username}] ⚠️ Error checking face ${face}: ${error.message}`,
      );
      continue;
    }
  }

  // Sort candidates by score (highest first)
  candidates.sort((a, b) => b.score - a.score);

  // Return all candidates if requested (for fallback support)
  if (returnAll) {
    return candidates;
  }

  // Return the best candidate, or null if none found
  if (candidates.length > 0) {
    const best = candidates[0];
    console.log(
      `[${bot.username}] 🎯 Best face: score=${best.score.toFixed(1)}, ` +
        `vec=(${best.faceVec.x},${best.faceVec.y},${best.faceVec.z}), ` +
        `dist=${best.distance.toFixed(1)} ` +
        `(${candidates.length} candidates)`,
    );
    return {
      refBlock: best.refBlock,
      faceVec: best.faceVec,
      score: best.score,
      alternatives: candidates.length - 1,
    };
  }

  return null;
}

/**
 * Find a reference block + face vector to place at targetPos
 * DEPRECATED: Use findBestPlaceReference() instead
 * Kept for backward compatibility
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} targetPos - Target position to place block
 * @returns {Object|null} {refBlock, faceVec} or null if no valid reference
 */
function findPlaceReference(bot, targetPos) {
  const result = findBestPlaceReference(bot, targetPos);
  if (result) {
    return { refBlock: result.refBlock, faceVec: result.faceVec };
  }
  return null;
}

/**
 * Perform a raycast from one position to another to check for obstructions
 * Steps through the ray in small increments and checks for solid blocks
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} fromPos - Starting position (usually bot's eye position)
 * @param {Vec3} toPos - Target position (usually face center)
 * @returns {Object} {clear: boolean, obstruction: Vec3|null}
 */
function raycastToPosition(bot, fromPos, toPos) {
  const direction = toPos.minus(fromPos);
  const distance = direction.norm();

  if (distance === 0) {
    return { clear: true, obstruction: null };
  }

  const normalized = direction.scaled(1 / distance);
  const stepSize = 0.1; // Check every 0.1 blocks
  const steps = Math.ceil(distance / stepSize);

  for (let i = 1; i < steps; i++) {
    const checkPos = fromPos.plus(normalized.scaled(i * stepSize));
    const block = bot.blockAt(checkPos.floored());

    // Check if there's a solid block obstructing the path
    if (block && block.boundingBox === "block") {
      // Make sure it's not the target block itself
      const flooredCheck = checkPos.floored();
      const flooredTo = toPos.floored();
      if (!flooredCheck.equals(flooredTo)) {
        return { clear: false, obstruction: flooredCheck };
      }
    }
  }

  return { clear: true, obstruction: null };
}

/**
 * Check if a target position is completely obstructed (all faces blocked)
 * Used to detect if a block is enclosed and cannot be placed
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} targetPos - Position to check
 * @returns {boolean} True if all 6 faces are blocked by solid blocks
 */
function isBlockObstructed(bot, targetPos) {
  let blockedFaces = 0;

  for (const face of CARDINALS) {
    const adjacentPos = targetPos.plus(face);
    const adjacentBlock = bot.blockAt(adjacentPos);

    // If there's a solid block on this face, it's blocked
    if (adjacentBlock && adjacentBlock.boundingBox === "block") {
      blockedFaces++;
    }
  }

  // If all 6 faces are blocked, the position is completely obstructed
  return blockedFaces === 6;
}

/**
 * Check if the bot can see a specific face of a reference block
 * Performs detailed line-of-sight validation using raycast
 * @param {*} bot - Mineflayer bot instance
 * @param {*} refBlock - Reference block to check
 * @param {Vec3} faceVec - Face vector (normal direction of the face)
 * @returns {boolean} True if bot has clear line of sight to the face
 */
function canSeeFace(bot, refBlock, faceVec) {
  // Calculate the center point of the face we want to click
  const faceCenter = refBlock.position.offset(
    0.5 + faceVec.x * 0.5,
    0.5 + faceVec.y * 0.5,
    0.5 + faceVec.z * 0.5,
  );

  // Get bot's eye position (eyes are at 90% of entity height)
  const eyePos = bot.entity.position.offset(0, bot.entity.height * 0.9, 0);

  // First check: Can bot see the block at all? (fast check)
  if (!bot.canSeeBlock(refBlock)) {
    return false;
  }

  // Second check: Raycast from eye to face center (detailed check)
  const raycast = raycastToPosition(bot, eyePos, faceCenter);
  if (!raycast.clear) {
    // Something is blocking the line of sight
    return false;
  }

  // Third check: Make sure the face isn't pointing away from the bot
  // (We shouldn't be able to "see" the back of a block)
  const toFace = faceCenter.minus(eyePos).normalize();
  const dotProduct =
    toFace.x * faceVec.x + toFace.y * faceVec.y + toFace.z * faceVec.z;

  // If dot product is positive, we're looking at the back of the face
  // (face normal points away from us)
  if (dotProduct > 0.1) {
    return false;
  }

  return true;
}

/**
 * Check if a position is safe for the bot to stand
 * Validates ground support, no obstructions, and reasonable distance
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} position - Position to check
 * @param {Vec3} targetPos - Target block position (for distance check)
 * @returns {boolean} True if position is safe
 */
function isPositionSafe(bot, position, targetPos) {
  const flooredPos = position.floored();

  // Check 1: Position must be within reasonable distance (not too far)
  const maxDistance = bot.game.gameMode === 1 ? 6 : 4.5;
  if (position.distanceTo(targetPos) > maxDistance) {
    return false;
  }

  // Check 2: Block at position should be air (not inside a block)
  const blockAtPos = bot.blockAt(flooredPos);
  if (blockAtPos && blockAtPos.boundingBox === "block") {
    return false;
  }

  // Check 3: Block above should also be air (enough headroom)
  const blockAbove = bot.blockAt(flooredPos.offset(0, 1, 0));
  if (blockAbove && blockAbove.boundingBox === "block") {
    return false;
  }

  // Check 4: Must have solid ground below (or be on existing structure)
  const groundPos = flooredPos.offset(0, -1, 0);
  const groundBlock = bot.blockAt(groundPos);
  if (!groundBlock || groundBlock.boundingBox !== "block") {
    return false;
  }

  return true;
}

/**
 * Calculate the optimal position for the bot to stand when placing a block
 * Considers face direction, distance, and viewing angle
 * @param {*} bot - Mineflayer bot instance
 * @param {*} refBlock - Reference block to place on
 * @param {Vec3} faceVec - Face vector
 * @param {Vec3} targetPos - Target position where block will be placed
 * @returns {Object} {position: Vec3, yaw: number, pitch: number}
 */
function calculateOptimalPosition(bot, refBlock, faceVec, targetPos) {
  // Calculate face center
  const faceCenter = refBlock.position.offset(
    0.5 + faceVec.x * 0.5,
    0.5 + faceVec.y * 0.5,
    0.5 + faceVec.z * 0.5,
  );

  // Ideal distance: 2.5-3.5 blocks away from the face
  const idealDistance = 3.0;

  // Calculate direction away from the face (opposite of face normal)
  // We want to stand back from the face, not on top of it
  const awayFromFace = new Vec3(-faceVec.x, 0, -faceVec.z); // Keep Y=0 for horizontal movement

  // If face is horizontal (top or bottom), use different logic
  if (faceVec.y !== 0) {
    // For top/bottom faces, stand to the side
    // Use the direction from target to bot's current position
    const currentDir = bot.entity.position.minus(targetPos);
    awayFromFace.x = currentDir.x;
    awayFromFace.z = currentDir.z;
  }

  // Normalize the direction
  const horizontalDist = Math.sqrt(
    awayFromFace.x * awayFromFace.x + awayFromFace.z * awayFromFace.z,
  );
  if (horizontalDist > 0.001) {
    awayFromFace.x /= horizontalDist;
    awayFromFace.z /= horizontalDist;
  } else {
    // Fallback: use bot's current direction
    awayFromFace.x = -Math.sin(bot.entity.yaw);
    awayFromFace.z = -Math.cos(bot.entity.yaw);
  }

  // Calculate optimal standing position
  const optimalPos = faceCenter.offset(
    awayFromFace.x * idealDistance,
    0, // Keep at same Y level initially
    awayFromFace.z * idealDistance,
  );

  // Adjust Y to ground level
  const groundY = Math.floor(optimalPos.y);
  optimalPos.y = groundY;

  // Calculate yaw and pitch to look at face center
  const dx = faceCenter.x - optimalPos.x;
  const dy = faceCenter.y - (optimalPos.y + bot.entity.height * 0.9); // Eye level
  const dz = faceCenter.z - optimalPos.z;

  const yaw = Math.atan2(-dx, -dz);
  const groundDistance = Math.sqrt(dx * dx + dz * dz);
  const pitch = Math.atan2(dy, groundDistance);

  return {
    position: optimalPos,
    yaw: yaw,
    pitch: pitch,
  };
}

/**
 * Move the bot to an optimal position for placing a block
 * Uses pathfinder to navigate and validates line of sight after movement
 * @param {*} bot - Mineflayer bot instance
 * @param {*} refBlock - Reference block to place on
 * @param {Vec3} faceVec - Face vector
 * @param {Vec3} targetPos - Target position where block will be placed
 * @param {number} timeoutMs - Timeout for pathfinding (default: 5000ms)
 * @returns {Promise<Object>} {success: boolean, position: Vec3, reason: string}
 */
async function moveToPlacementPosition(
  bot,
  refBlock,
  faceVec,
  targetPos,
  timeoutMs = 5000,
) {
  // Calculate optimal position
  const optimal = calculateOptimalPosition(bot, refBlock, faceVec, targetPos);

  // Check if bot is already in a good position
  const currentDist = bot.entity.position.distanceTo(refBlock.position);
  const maxReach = bot.game.gameMode === 1 ? 6 : 4.5;

  if (currentDist <= maxReach && canSeeFace(bot, refBlock, faceVec)) {
    // Already in good position
    return {
      success: true,
      position: bot.entity.position.clone(),
      reason: "Already in optimal position",
    };
  }

  // Check if optimal position is safe
  if (!isPositionSafe(bot, optimal.position, targetPos)) {
    // Try alternative positions in a circle around the target
    const angles = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];
    for (const angle of angles) {
      const altX =
        optimal.position.x * Math.cos(angle) -
        optimal.position.z * Math.sin(angle);
      const altZ =
        optimal.position.x * Math.sin(angle) +
        optimal.position.z * Math.cos(angle);
      const altPos = new Vec3(altX, optimal.position.y, altZ);

      if (isPositionSafe(bot, altPos, targetPos)) {
        optimal.position = altPos;
        break;
      }
    }
  }

  // Use pathfinder to move to position
  if (!bot.pathfinder) {
    return {
      success: false,
      position: bot.entity.position.clone(),
      reason: "Pathfinder not initialized",
    };
  }

  try {
    const { goals } = require("mineflayer-pathfinder");
    const goal = new goals.GoalNear(
      optimal.position.x,
      optimal.position.y,
      optimal.position.z,
      2, // Accept within 2 blocks
    );

    bot.pathfinder.setGoal(goal, true);

    // Wait for movement to complete or timeout
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        bot.pathfinder.setGoal(null);
        resolve();
      }, timeoutMs);

      const checkGoal = () => {
        if (!bot.pathfinder.isMoving()) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkGoal, 100);
        }
      };
      checkGoal();
    });

    // Verify we can still see the face after movement
    if (canSeeFace(bot, refBlock, faceVec)) {
      return {
        success: true,
        position: bot.entity.position.clone(),
        reason: "Moved to optimal position",
      };
    } else {
      return {
        success: false,
        position: bot.entity.position.clone(),
        reason: "Lost line of sight after movement",
      };
    }
  } catch (error) {
    return {
      success: false,
      position: bot.entity.position.clone(),
      reason: `Pathfinding error: ${error.message}`,
    };
  }
}

/**
 * Prepare the bot for block placement with natural-looking behavior
 * Looks at the target face, validates reach and sight line
 * @param {*} bot - Mineflayer bot instance
 * @param {*} refBlock - Reference block to place on
 * @param {Vec3} faceVec - Face vector
 * @param {number} delayMs - Delay after looking (default: 250ms)
 * @returns {Promise<Object>} {ready: boolean, reason: string}
 */
async function prepareForPlacement(bot, refBlock, faceVec, delayMs = 500) {
  // Calculate face center point
  const faceCenter = refBlock.position.offset(
    0.5 + faceVec.x * 0.5,
    0.5 + faceVec.y * 0.5,
    0.5 + faceVec.z * 0.5,
  );

  // Disable pathfinder auto-look temporarily to prevent interference
  const pathfinderEnableLook = bot.pathfinder
    ? bot.pathfinder.enableLook
    : null;
  if (bot.pathfinder) {
    bot.pathfinder.enableLook = false;
  }

  try {
    // Slowly turn to face the target (force=false for smooth turn)
    try {
      await bot.lookAt(faceCenter, false);
    } catch (lookError) {
      // If smooth look fails, try forced look
      try {
        await bot.lookAt(faceCenter, true);
      } catch (forcedLookError) {
        return {
          ready: false,
          reason: `Cannot look at target: ${forcedLookError.message}`,
        };
      }
    }

    // Natural pause after looking (makes movement more human-like)
    if (delayMs > 0) {
      await new Promise((res) => setTimeout(res, delayMs));
    }

    // Verify bot is still in reach
    const maxReach = bot.game.gameMode === 1 ? 6 : 4.5;
    if (!inReach(bot, refBlock.position, maxReach)) {
      return {
        ready: false,
        reason: "Target out of reach after looking",
      };
    }

    // Verify sight line is still clear
    if (!canSeeFace(bot, refBlock, faceVec)) {
      return {
        ready: false,
        reason: "Lost line of sight after looking",
      };
    }

    return {
      ready: true,
      reason: "Ready for placement",
    };
  } finally {
    // Restore pathfinder enableLook setting
    if (bot.pathfinder && pathfinderEnableLook !== null) {
      bot.pathfinder.enableLook = pathfinderEnableLook;
    }
  }
}

/**
 * Move close enough to place if needed
 * @param {*} bot - Mineflayer bot instance
 * @param {*} refBlock - Reference block to click
 * @param {Vec3} faceVec - Face vector
 * @param {number} maxTries - Maximum attempts
 * @returns {Promise<boolean>} True if in reach
 */
async function ensureReachAndSight(bot, refBlock, faceVec, maxTries = 3) {
  // NOTE: Camera aiming is already done by prepareForPlacement()
  // We only need to verify reach, not re-aim the camera

  for (let i = 0; i < maxTries; i++) {
    const maxReach = bot.game.gameMode === 1 ? 6 : 4.5;
    if (inReach(bot, refBlock.position, maxReach)) return true;

    // Nudge closer using pathfinder if available
    if (bot.pathfinder) {
      const { GoalNear } = require("mineflayer-pathfinder").goals;
      const p = refBlock.position;
      bot.pathfinder.setGoal(new GoalNear(p.x, p.y, p.z, 2), true);
      await new Promise((res) => setTimeout(res, 350));
    } else {
      // Simple wait if no pathfinder
      await new Promise((res) => setTimeout(res, 200));
    }
  }

  return inReach(bot, refBlock.position, 5);
}

/**
 * Robust place at exact target (x,y,z) with itemName
 * Auto-finds a reference face, ensures reach/LOS, sneaks if needed, retries
 * Enhanced with pre-placement ritual for human-like behavior
 * Phase 7: Added fallback mechanisms, validation, and graceful error handling
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} targetPos - Target position to place block
 * @param {string} itemName - Name of block/item to place
 * @param {Object} options - Options for placement {useSneak, tries, args, prePlacementDelay, maxRetries}
 * @returns {Promise<boolean>} True if successfully placed
 */
async function placeAt(
  bot,
  targetPos,
  itemName,
  {
    useSneak = false,
    tries = 5,
    args = null,
    prePlacementDelay = 150,
    maxRetries = 10,
  } = {},
) {
  // Phase 7: Validation - Check if bot is in valid state
  if (!bot || !bot.entity) {
    console.error(`[${bot?.username || "Unknown"}] ❌ Bot not in valid state`);
    return false;
  }

  // Preconditions: check if already placed
  const airNow = isAirLike(bot.blockAt(targetPos));
  if (!airNow) return true; // already placed

  // Phase 7: Validate item availability
  try {
    await ensureItemInHand(bot, itemName, args);
  } catch (error) {
    console.error(
      `[${bot.username}] ❌ Cannot equip ${itemName}: ${error.message}`,
    );
    return false;
  }

  // Phase 7: Get all viable face candidates for fallback support
  const allCandidates = findBestPlaceReference(bot, targetPos, {
    returnAll: true,
    minScore: 20,
  });
  if (!allCandidates || allCandidates.length === 0) {
    console.error(`[${bot.username}] ❌ No valid faces found for ${targetPos}`);
    return false;
  }

  console.log(
    `[${bot.username}] 📋 Found ${allCandidates.length} viable face(s) for placement`,
  );

  const sneakWas = bot.getControlState("sneak");
  if (useSneak) bot.setControlState("sneak", true);

  try {
    let candidateIndex = 0;
    let totalAttempts = 0;
    const maxTotalAttempts = Math.min(maxRetries, allCandidates.length * tries);

    // Phase 7: Try each candidate face with retries
    while (
      candidateIndex < allCandidates.length &&
      totalAttempts < maxTotalAttempts
    ) {
      const candidate = allCandidates[candidateIndex];
      const { refBlock, faceVec, score } = candidate;

      console.log(
        `[${bot.username}] 🎯 Trying face ${candidateIndex + 1}/${allCandidates.length} ` +
          `(score: ${score.toFixed(1)}, attempt: ${totalAttempts + 1}/${maxTotalAttempts})`,
      );

      for (let i = 0; i < tries && totalAttempts < maxTotalAttempts; i++) {
        totalAttempts++;

        // Pre-placement ritual: look at target and validate
        const preparation = await prepareForPlacement(
          bot,
          refBlock,
          faceVec,
          prePlacementDelay,
        );

        if (!preparation.ready) {
          console.log(`[${bot.username}] ⚠️ Not ready: ${preparation.reason}`);
          break; // Move to next candidate
        }

        // Verify reach one more time before placing
        const ok = await ensureReachAndSight(bot, refBlock, faceVec, 1);
        if (!ok) {
          console.log(`[${bot.username}] ⚠️ Lost reach/sight`);
          break; // Move to next candidate
        }

        // Attempt placement
        try {
          await bot.placeBlock(refBlock, faceVec);

          // Wait 500ms after placement without moving camera
          await new Promise((res) => setTimeout(res, 500));
        } catch (e) {
          console.log(`[${bot.username}] ⚠️ Placement failed: ${e.message}`);
          await new Promise((res) => setTimeout(res, 100));
          continue; // Retry same face
        }

        // Confirm world state - verify block was actually placed
        await new Promise((res) => setTimeout(res, 50)); // Brief wait for world update
        const placed = !isAirLike(bot.blockAt(targetPos));

        if (placed) {
          const placedBlock = bot.blockAt(targetPos);
          console.log(
            `[${bot.username}] ✅ Successfully placed ${placedBlock?.name || itemName} at ${targetPos} ` +
              `(face ${candidateIndex + 1}, attempt ${totalAttempts})`,
          );
          return true;
        }

        console.log(`[${bot.username}] ⚠️ Block not confirmed, retrying...`);
        await new Promise((res) => setTimeout(res, 80));
      }

      // Move to next candidate face
      candidateIndex++;
    }

    // Phase 7: All fallback attempts exhausted
    console.error(
      `[${bot.username}] ❌ Failed to place block at ${targetPos} after ${totalAttempts} attempts ` +
        `across ${candidateIndex} face(s)`,
    );
    return false;
  } catch (error) {
    // Phase 7: Graceful error handling
    console.error(
      `[${bot.username}] ❌ Unexpected error in placeAt: ${error.message}`,
    );
    return false;
  } finally {
    if (useSneak && !sneakWas) bot.setControlState("sneak", false);
  }
}

/**
 * Place multiple blocks in a deterministic order (bottom-up, near-to-far)
 * @param {*} bot - Mineflayer bot instance
 * @param {Array<Vec3>} positions - Array of positions to place blocks
 * @param {string} itemName - Name of block/item to place
 * @param {Object} options - Options for placement {useSneak, tries, args, delayMs, useBuildOrder, useSmartPositioning}
 * @returns {Promise<Object>} {success: number, failed: number, skipped: number}
 */
async function placeMultiple(bot, positions, itemName, options = {}) {
  const {
    delayMs = 300,
    useBuildOrder = true,
    useSmartPositioning = false, // Disabled by default for performance
  } = options;

  console.log(
    `[${bot.username}] 🏗️ Starting to place ${positions.length} blocks...`,
  );

  // Use intelligent build order if enabled
  const sorted = useBuildOrder
    ? sortByBuildability(positions, bot)
    : positions.slice().sort((a, b) => {
        // Fallback: simple bottom-up, near-to-far sorting
        if (a.y !== b.y) return a.y - b.y;
        const distA = bot.entity.position.distanceTo(a);
        const distB = bot.entity.position.distanceTo(b);
        if (Math.abs(distA - distB) > 0.5) return distA - distB;
        return a.x - b.x;
      });

  let success = 0;
  let failed = 0;
  let skipped = 0;
  const placedSet = new Set(); // Track successfully placed blocks

  console.log(
    `[${bot.username}] 📋 Build order: ${useBuildOrder ? "OPTIMIZED" : "SIMPLE"}`,
  );
  console.log(
    `[${bot.username}] 🎯 Smart positioning: ${useSmartPositioning ? "ENABLED" : "DISABLED"}`,
  );

  for (let i = 0; i < sorted.length; i++) {
    const pos = sorted[i];
    const progress = `[${i + 1}/${sorted.length}]`;

    try {
      // Check if block already exists (might have been placed by another bot)
      const existingBlock = bot.blockAt(pos);
      if (existingBlock && existingBlock.boundingBox === "block") {
        console.log(
          `[${bot.username}] ${progress} ⏭️ Block already exists at ${pos}`,
        );
        skipped++;
        placedSet.add(`${pos.x},${pos.y},${pos.z}`);
        continue;
      }

      // Optional: Smart positioning (move to optimal location before placing)
      if (useSmartPositioning) {
        const plan = findBestPlaceReference(bot, pos);
        if (plan) {
          const moveResult = await moveToPlacementPosition(
            bot,
            plan.refBlock,
            plan.faceVec,
            pos,
            3000, // 3 second timeout
          );

          if (!moveResult.success) {
            console.log(
              `[${bot.username}] ${progress} ⚠️ Could not reach optimal position: ${moveResult.reason}`,
            );
            // Continue anyway, placeAt will handle it
          }
        }
      }

      // Attempt to place the block
      const placed = await placeAt(bot, pos, itemName, options);

      if (placed) {
        success++;
        placedSet.add(`${pos.x},${pos.y},${pos.z}`);
        // placeAt already logs success
      } else {
        failed++;
        // placeAt already logs failure
      }
    } catch (error) {
      failed++;
      console.log(
        `[${bot.username}] ${progress} ❌ Error placing at ${pos}: ${error.message}`,
      );
    }

    // Add delay between block placements for more human-like building
    if (delayMs > 0 && i < sorted.length - 1) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  // Summary
  console.log(`[${bot.username}] 🏁 Placement complete!`);
  console.log(
    `[${bot.username}]    ✅ Success: ${success}/${positions.length}`,
  );
  console.log(`[${bot.username}]    ❌ Failed: ${failed}/${positions.length}`);
  console.log(
    `[${bot.username}]    ⏭️ Skipped: ${skipped}/${positions.length}`,
  );

  return { success, failed, skipped };
}

/**
 * Fast block placement - no checks, just place immediately
 * Used during pillar jumping where we know the context
 * @param {*} bot - Mineflayer bot instance
 * @param {*} referenceBlock - Block to place on top of
 * @returns {Promise<boolean>} True if placement was attempted
 */
async function fastPlaceBlock(bot, referenceBlock) {
  try {
    const faceVector = new Vec3(0, 1, 0); // Top face
    await bot.placeBlock(referenceBlock, faceVector);
    return true;
  } catch (error) {
    // Don't log here - too noisy during spam attempts
    return false;
  }
}

/**
 * Build a tower by jumping and placing blocks directly underneath
 * Uses the classic Minecraft "pillar jumping" technique with configurable retry logic
 * @param {*} bot - Mineflayer bot instance
 * @param {number} towerHeight - Height of tower to build
 * @param {Object} args - Configuration arguments (for RCON if needed)
 * @param {Object} options - Optional configuration
 * @param {string} options.blockType - Type of block to place (default: 'oak_planks')
 * @param {boolean} options.enableRetry - Enable retry logic for failed placements (default: true)
 * @param {boolean} options.breakOnFailure - Break immediately on failure (default: false)
 * @param {number} options.maxPlaceAttempts - Max attempts to place each block (default: 10)
 * @param {number} options.settleDelayMs - Delay to settle after placing (default: 200)
 * @param {number} options.jumpDurationMs - How long to hold jump (default: 50)
 * @param {number} options.placeRetryDelayMs - Delay between place attempts (default: 20)
 * @returns {Promise<Object>} Build statistics {success, failed, heightGained}
 */
async function buildTowerUnderneath(bot, towerHeight, args, options = {}) {
  const {
    blockType = "oak_planks",
    enableRetry = true,
    breakOnFailure = false,
    maxPlaceAttempts = 10,
    settleDelayMs = 200,
    jumpDurationMs = 50,
    placeRetryDelayMs = 20,
  } = options;

  console.log(
    `[${bot.username}] 🗼 Starting tower build: ${towerHeight} blocks`,
  );

  let success = 0;
  let failed = 0;

  // Ensure we have the blocks
  await ensureItemInHand(bot, blockType, args);

  // Get bot's starting position
  const startPos = bot.entity.position.clone();
  const startY = Math.floor(startPos.y);
  console.log(
    `[${bot.username}] 📍 Starting position: X=${startPos.x.toFixed(
      2,
    )}, Y=${startPos.y.toFixed(2)}, Z=${startPos.z.toFixed(2)}`,
  );

  // Look down ONCE before starting
  console.log(`[${bot.username}] 👇 Looking down once...`);
  await bot.look(bot.entity.yaw, -1.45, false);
  await bot.waitForTicks(10);
  await new Promise((res) => setTimeout(res, 50));

  for (let i = 0; i < towerHeight; i++) {
    console.log(`[${bot.username}] ═══════════════════════════════════════`);
    console.log(`[${bot.username}] 🧱 Building block ${i + 1}/${towerHeight}`);

    // Get reference block (the block we're standing on)
    const currentPos = bot.entity.position.clone();
    const groundPos = new Vec3(
      Math.floor(currentPos.x),
      Math.floor(currentPos.y) - 1,
      Math.floor(currentPos.z),
    );
    const groundBlock = bot.blockAt(groundPos);

    if (!groundBlock || groundBlock.name === "air") {
      console.log(`[${bot.username}] ❌ No ground block at ${groundPos}`);
      failed++;
      if (breakOnFailure) break;
      continue;
    }

    console.log(
      `[${bot.username}] 📦 Reference block: ${groundBlock.name} at ${groundPos}`,
    );

    // Target position (where the new block will be)
    const targetPos = groundPos.offset(0, 1, 0);

    // Jump and spam place attempts
    console.log(`[${bot.username}] 🦘 Jumping and spamming place...`);
    bot.setControlState("jump", true);

    // Spam place attempts immediately while jumping
    for (let attempt = 1; attempt <= maxPlaceAttempts; attempt++) {
      fastPlaceBlock(bot, groundBlock)
        .then(() =>
          console.log(`[${bot.username}] 🎯 Place fired on attempt ${attempt}`),
        )
        .catch(() => {});
      await new Promise((res) => setTimeout(res, placeRetryDelayMs));
    }
    await new Promise((res) => setTimeout(res, jumpDurationMs));
    bot.setControlState("jump", false);

    // Verify placement after jump completes
    await new Promise((res) => setTimeout(res, 50));
    const placedBlock = bot.blockAt(targetPos);
    if (placedBlock && placedBlock.name === blockType) {
      console.log(
        `[${bot.username}] ✅ Block ${i + 1} placed successfully: ${
          placedBlock.name
        } at ${targetPos}`,
      );
      success++;
    } else {
      console.log(
        `[${bot.username}] ❌ Block ${i + 1} placement failed at ${targetPos}`,
      );
      failed++;

      if (breakOnFailure) {
        console.log(`[${bot.username}] 🛑 Breaking on failure`);
        break;
      }

      if (!enableRetry) {
        console.log(`[${bot.username}] ⚠️ Continuing without retry...`);
        continue;
      }

      console.log(`[${bot.username}] ⚠️ Continuing despite failure...`);
    }

    // Settle on the new block
    console.log(`[${bot.username}] ⏳ Settling...`);
    await new Promise((res) => setTimeout(res, settleDelayMs + 100));

    // Verify height
    const newPos = bot.entity.position.clone();
    const newY = Math.floor(newPos.y);
    const heightGained = newY - startY;
    console.log(
      `[${bot.username}] 📏 New Y: ${newY} (gained ${heightGained} blocks, target: ${i + 1})`,
    );

    // If we haven't gained height and retry is enabled, retry this block
    if (enableRetry && heightGained < i + 1) {
      console.log(
        `[${bot.username}] ⚠️ Height mismatch! Expected ${
          i + 1
        }, got ${heightGained}`,
      );
      console.log(`[${bot.username}] 🔄 Retrying block ${i + 1}...`);

      // Get reference block again
      const retryCurrentPos = bot.entity.position.clone();
      const retryGroundPos = new Vec3(
        Math.floor(retryCurrentPos.x),
        Math.floor(retryCurrentPos.y) - 1,
        Math.floor(retryCurrentPos.z),
      );
      const retryGroundBlock = bot.blockAt(retryGroundPos);

      if (!retryGroundBlock || retryGroundBlock.name === "air") {
        console.log(
          `[${bot.username}] ❌ No ground block at ${retryGroundPos}`,
        );
        failed++;
        if (breakOnFailure) break;
        continue;
      }

      // Look down again
      await bot.look(bot.entity.yaw, -1.45, false);
      await new Promise((res) => setTimeout(res, 50));

      // Try one more time
      bot.setControlState("jump", true);
      for (let retry = 1; retry <= maxPlaceAttempts; retry++) {
        fastPlaceBlock(bot, retryGroundBlock).catch(() => {});
        await new Promise((res) => setTimeout(res, placeRetryDelayMs));
      }
      await new Promise((res) => setTimeout(res, jumpDurationMs));
      bot.setControlState("jump", false);
      await new Promise((res) => setTimeout(res, settleDelayMs + 100));

      // Check again
      const retryPos = bot.entity.position.clone();
      const retryY = Math.floor(retryPos.y);
      const retryHeight = retryY - startY;
      console.log(
        `[${bot.username}] 📏 After retry - Y: ${retryY}, height: ${retryHeight}`,
      );

      if (retryHeight < i + 1) {
        console.log(
          `[${bot.username}] ❌ Retry failed - ${
            breakOnFailure ? "aborting" : "continuing"
          }`,
        );
        failed++;
        if (breakOnFailure) break;
      }
    }
  }

  const finalPos = bot.entity.position.clone();
  const finalY = Math.floor(finalPos.y);
  const totalHeight = finalY - startY;

  console.log(`[${bot.username}] ═══════════════════════════════════════`);
  console.log(`[${bot.username}] 🏁 Tower build complete!`);
  console.log(`[${bot.username}]    Blocks placed: ${success}/${towerHeight}`);
  console.log(`[${bot.username}]    Failed: ${failed}/${towerHeight}`);
  console.log(`[${bot.username}]    Height gained: ${totalHeight} blocks`);
  console.log(
    `[${bot.username}]    Final position: X=${finalPos.x.toFixed(
      2,
    )}, Y=${finalPos.y.toFixed(2)}, Z=${finalPos.z.toFixed(2)}`,
  );

  return { success, failed, heightGained: totalHeight };
}

/**
 * Check if a target position has adjacent support for placement
 * A block can only be placed if at least one adjacent block exists
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} targetPos - Position to check for support
 * @param {Set<string>} placedBlocks - Set of already placed block positions (as "x,y,z" strings)
 * @returns {boolean} True if position has at least one adjacent solid block
 */
function hasAdjacentSupport(bot, targetPos, placedBlocks = new Set()) {
  // Special case: Ground level (Y <= 0) always has support from bedrock/ground
  if (targetPos.y <= 0) {
    return true;
  }

  // Check all 6 adjacent positions for solid blocks
  for (const face of CARDINALS) {
    const adjacentPos = targetPos.plus(face);
    const adjacentBlock = bot.blockAt(adjacentPos);

    // Check if there's a solid block in the world
    if (adjacentBlock && adjacentBlock.boundingBox === "block") {
      return true;
    }

    // Check if we've already placed a block at this position
    const posKey = `${adjacentPos.x},${adjacentPos.y},${adjacentPos.z}`;
    if (placedBlocks.has(posKey)) {
      return true;
    }
  }

  return false;
}

/**
 * Sort block positions by buildability
 * Ensures blocks are placed in a valid order with proper support
 * @param {Array<Vec3>} positions - Array of positions to sort
 * @param {*} bot - Mineflayer bot instance
 * @returns {Array<Vec3>} Sorted array of positions (buildable order)
 */
function sortByBuildability(positions, bot) {
  if (positions.length === 0) return [];

  const sorted = [];
  const remaining = positions.slice(); // Copy array
  const placedSet = new Set(); // Track placed positions
  let maxIterations = positions.length * 2; // Prevent infinite loops
  let iterations = 0;

  // Group positions by Y level for initial sorting
  remaining.sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y; // Bottom to top
    // Within same Y level, sort by distance to bot
    const distA = bot.entity.position.distanceTo(a);
    const distB = bot.entity.position.distanceTo(b);
    return distA - distB;
  });

  // Build in order, ensuring each block has support
  while (remaining.length > 0 && iterations < maxIterations) {
    iterations++;
    let placedThisIteration = false;

    for (let i = remaining.length - 1; i >= 0; i--) {
      const pos = remaining[i];

      // Check if this position has adjacent support
      if (hasAdjacentSupport(bot, pos, placedSet)) {
        // This block can be placed now
        sorted.push(pos);
        placedSet.add(`${pos.x},${pos.y},${pos.z}`);
        remaining.splice(i, 1);
        placedThisIteration = true;
      }
    }

    // If we couldn't place any blocks this iteration, we have a problem
    if (!placedThisIteration && remaining.length > 0) {
      console.warn(
        `[sortByBuildability] Warning: ${remaining.length} blocks have no support. ` +
          `Adding them anyway to prevent deadlock.`,
      );
      // Add remaining blocks in Y-order as fallback
      remaining.sort((a, b) => a.y - b.y);
      sorted.push(...remaining);
      break;
    }
  }

  return sorted;
}

// Track scaffolds for cleanup
const scaffoldBlocks = [];

/**
 * Calculate placement order for floor blocks (edge-to-center spiral)
 * Strategy: Place perimeter first, then work inward layer by layer
 * This ensures bots never stand on unplaced blocks
 * @param {number} width - Width of floor (default 5)
 * @param {number} depth - Depth of floor (default 5)
 * @returns {Array<{x: number, z: number, order: number}>} Ordered positions
 */
function calculateFloorPlacementOrder(width = 5, depth = 5) {
  const positions = [];
  let order = 0;

  // Work from outside edge inward (layer by layer)
  let minX = 0,
    maxX = width - 1;
  let minZ = 0,
    maxZ = depth - 1;

  while (minX <= maxX && minZ <= maxZ) {
    // Top edge (left to right)
    for (let x = minX; x <= maxX; x++) {
      positions.push({ x, z: minZ, order: order++ });
    }
    minZ++;

    // Right edge (top to bottom)
    for (let z = minZ; z <= maxZ; z++) {
      positions.push({ x: maxX, z, order: order++ });
    }
    maxX--;

    // Bottom edge (right to left)
    if (minZ <= maxZ) {
      for (let x = maxX; x >= minX; x--) {
        positions.push({ x, z: maxZ, order: order++ });
      }
      maxZ--;
    }

    // Left edge (bottom to top)
    if (minX <= maxX) {
      for (let z = maxZ; z >= minZ; z--) {
        positions.push({ x: minX, z, order: order++ });
      }
      minX++;
    }
  }

  return positions;
}

/**
 * Helper: Get perimeter position for clockwise ordering
 * @param {number} x - X coordinate
 * @param {number} z - Z coordinate
 * @returns {number} Position along perimeter
 */
function getPerimeterPosition(x, z) {
  // South wall (z=0): positions 0-4
  if (z === 0) return x;
  // East wall (x=4): positions 5-8
  if (x === 4) return 5 + (z - 1);
  // North wall (z=4): positions 9-12
  if (z === 4) return 9 + (4 - x);
  // West wall (x=0): positions 13-15
  if (x === 0) return 13 + (4 - z - 1);
  return 999; // Should never happen
}

/**
 * Calculate placement order for wall blocks
 * Strategy: Bottom-up, corners first, then edges
 * @param {Array<{x: number, y: number, z: number}>} wallBlocks - Wall block positions
 * @returns {Map<string, number>} Map of "x,y,z" -> order
 */
function calculateWallPlacementOrder(wallBlocks) {
  const orderMap = new Map();
  let order = 0;

  // Group by Y level (bottom to top)
  const byLevel = {};
  for (const block of wallBlocks) {
    const key = block.y;
    if (!byLevel[key]) byLevel[key] = [];
    byLevel[key].push(block);
  }

  // Process each level
  const levels = Object.keys(byLevel)
    .map(Number)
    .sort((a, b) => a - b);

  for (const y of levels) {
    const levelBlocks = byLevel[y];

    // Sort by distance from corners (corners first)
    // Corners are at (0,0), (4,0), (0,4), (4,4)
    const sorted = levelBlocks.slice().sort((a, b) => {
      const isCornerA = (a.x === 0 || a.x === 4) && (a.z === 0 || a.z === 4);
      const isCornerB = (b.x === 0 || b.x === 4) && (b.z === 0 || b.z === 4);

      if (isCornerA && !isCornerB) return -1;
      if (!isCornerA && isCornerB) return 1;

      // Then by perimeter position (clockwise from south-west)
      const perimeterA = getPerimeterPosition(a.x, a.z);
      const perimeterB = getPerimeterPosition(b.x, b.z);
      return perimeterA - perimeterB;
    });

    // Assign orders
    for (const block of sorted) {
      orderMap.set(`${block.x},${block.y},${block.z}`, order++);
    }
  }

  return orderMap;
}

/**
 * Calculate placement order for roof blocks
 * Strategy: Similar to floor (edge-to-center) but bots are below
 * @param {number} width - Width of roof (default 5)
 * @param {number} depth - Depth of roof (default 5)
 * @returns {Array<{x: number, z: number, order: number}>} Ordered positions
 */
function calculateRoofPlacementOrder(width = 5, depth = 5) {
  // Roof can use same strategy as floor since bots are below
  // But we might want to place from edges inward for stability
  return calculateFloorPlacementOrder(width, depth);
}

/**
 * Generate a 5x5 house blueprint with flat roof
 * Local coordinate frame: origin at south-west corner, +X=east, +Z=south, +Y=up
 * @param {Object} options - Configuration options
 * @param {Object} options.materials - Material overrides
 * @returns {Array<Object>} Array of {x, y, z, block, phase, placementOrder, data}
 */
function makeHouseBlueprint5x5(options = {}) {
  const materials = {
    floor: "cobblestone",
    walls: "cobblestone",
    door: "oak_door",
    windows: "glass_pane",
    roof: "cobblestone",
    ...options.materials,
  };

  const blueprint = [];

  // PHASE 1: FLOOR (y=0, 5x5 grid) with edge-to-center placement order
  const floorOrder = calculateFloorPlacementOrder(5, 5);
  const floorOrderMap = new Map();
  for (const pos of floorOrder) {
    floorOrderMap.set(`${pos.x},${pos.z}`, pos.order);
  }

  for (let x = 0; x < 5; x++) {
    for (let z = 0; z < 5; z++) {
      const placementOrder = floorOrderMap.get(`${x},${z}`);
      blueprint.push({
        x,
        y: 0,
        z,
        block: materials.floor,
        phase: "floor",
        placementOrder: placementOrder !== undefined ? placementOrder : 999,
        data: null,
      });
    }
  }

  // PHASE 2: WALLS (y=1 to y=3, hollow ring)
  // Collect all wall blocks first, then assign orders
  const wallBlocks = [];

  // Entrance will be at (x=2, z=0, y=1 and y=2) - 1 wide × 2 tall opening
  for (let y = 1; y <= 3; y++) {
    // South wall (z=0) - skip entrance position (2 blocks tall)
    for (let x = 0; x < 5; x++) {
      if (!(x === 2 && (y === 1 || y === 2))) {
        // Skip entrance at y=1 and y=2
        wallBlocks.push({ x, y, z: 0 });
      }
    }

    // North wall (z=4)
    for (let x = 0; x < 5; x++) {
      wallBlocks.push({ x, y, z: 4 });
    }

    // West wall (x=0, skip corners already done)
    for (let z = 1; z < 4; z++) {
      wallBlocks.push({ x: 0, y, z });
    }

    // East wall (x=4, skip corners already done)
    for (let z = 1; z < 4; z++) {
      wallBlocks.push({ x: 4, y, z });
    }
  }

  // Calculate wall placement order
  const wallOrderMap = calculateWallPlacementOrder(wallBlocks);

  // Add walls to blueprint with placement order
  for (const wall of wallBlocks) {
    const orderKey = `${wall.x},${wall.y},${wall.z}`;
    const placementOrder = wallOrderMap.get(orderKey);
    blueprint.push({
      x: wall.x,
      y: wall.y,
      z: wall.z,
      block: materials.walls,
      phase: "walls",
      placementOrder: placementOrder !== undefined ? placementOrder : 999,
      data: null,
    });
  }

  // PHASE 3: ENTRANCE - 1 block wide × 2 blocks tall opening (no door)
  // Entrance is at (x=2, z=0, y=1 and y=2)
  // No door blocks placed, creating an open entrance

  // PHASE 4: WINDOWS (glass panes at y=2)
  // Windows can be placed in any order after walls
  let windowOrder = 0;

  // South windows flanking door
  // blueprint.push({
  //   x: 1,
  //   y: 2,
  //   z: 0,
  //   block: materials.windows,
  //   phase: "windows",
  //   placementOrder: windowOrder++,
  //   data: null,
  // });
  // blueprint.push({
  //   x: 3,
  //   y: 2,
  //   z: 0,
  //   block: materials.windows,
  //   phase: "windows",
  //   placementOrder: windowOrder++,
  //   data: null,
  // });
  // // West window
  // blueprint.push({
  //   x: 0,
  //   y: 2,
  //   z: 2,
  //   block: materials.windows,
  //   phase: "windows",
  //   placementOrder: windowOrder++,
  //   data: null,
  // });
  // // East window
  // blueprint.push({
  //   x: 4,
  //   y: 2,
  //   z: 2,
  //   block: materials.windows,
  //   phase: "windows",
  //   placementOrder: windowOrder++,
  //   data: null,
  // });

  // PHASE 5: ROOF (flat roof at y=4, 5x5 grid) with edge-to-center order
  const roofOrder = calculateRoofPlacementOrder(5, 5);
  const roofOrderMap = new Map();
  for (const pos of roofOrder) {
    roofOrderMap.set(`${pos.x},${pos.z}`, pos.order);
  }

  for (let x = 0; x < 5; x++) {
    for (let z = 0; z < 5; z++) {
      const placementOrder = roofOrderMap.get(`${x},${z}`);
      blueprint.push({
        x,
        y: 4,
        z,
        block: materials.roof,
        phase: "roof",
        placementOrder: placementOrder !== undefined ? placementOrder : 999,
        data: null,
      });
    }
  }

  return blueprint;
}

/**
 * Rotate local coordinates to world coordinates
 * @param {Object} local - Local position {x, y, z}
 * @param {Vec3} origin - World origin position
 * @param {number} orientation - Rotation in degrees (0, 90, 180, 270)
 * @returns {Vec3} World position
 */
function rotateLocalToWorld(local, origin, orientation) {
  let rx = local.x;
  let rz = local.z;

  // Rotate around Y axis
  switch (orientation) {
    case 90:
      [rx, rz] = [-local.z, local.x];
      break;
    case 180:
      [rx, rz] = [-local.x, -local.z];
      break;
    case 270:
      [rx, rz] = [local.z, -local.x];
      break;
    default: // 0 degrees
      break;
  }

  return new Vec3(origin.x + rx, origin.y + local.y, origin.z + rz);
}

/**
 * Split work between two bots by X-axis
 * Alpha builds west half + center (x ≤ 2), Bravo builds east half (x ≥ 3)
 * @param {Array<Object>} targets - Array of block targets
 * @param {string} alphaBotName - Name of alpha bot
 * @param {string} bravoBotName - Name of bravo bot
 * @returns {Object} {alphaTargets, bravoTargets}
 */
function splitWorkByXAxis(targets, alphaBotName, bravoBotName) {
  const alphaTargets = [];
  const bravoTargets = [];

  for (const target of targets) {
    if (target.x <= 2) {
      alphaTargets.push({ ...target, assignedTo: alphaBotName });
    } else {
      bravoTargets.push({ ...target, assignedTo: bravoBotName });
    }
  }

  console.log(
    `[splitWork] Alpha: ${alphaTargets.length} blocks (x ≤ 2, west + center)`,
  );
  console.log(`[splitWork] Bravo: ${bravoTargets.length} blocks (x ≥ 3, east)`);

  return { alphaTargets, bravoTargets };
}

/**
 * Calculate material counts from blueprint
 * @param {Array<Object>} blueprint - Blueprint array
 * @returns {Object} Material counts {blockName: count}
 */
function calculateMaterialCounts(blueprint) {
  const counts = {};
  for (const target of blueprint) {
    counts[target.block] = (counts[target.block] || 0) + 1;
  }
  return counts;
}

/**
 * Check if there's an adjacent solid block for placement reference
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} pos - Target position
 * @returns {boolean} True if reference block exists
 */
function hasAdjacentSolidBlock(bot, pos) {
  const offsets = [
    new Vec3(0, -1, 0), // Below (preferred)
    new Vec3(1, 0, 0), // East
    new Vec3(-1, 0, 0), // West
    new Vec3(0, 0, 1), // South
    new Vec3(0, 0, -1), // North
    new Vec3(0, 1, 0), // Above
  ];

  for (const offset of offsets) {
    const checkPos = pos.plus(offset);
    const block = bot.blockAt(checkPos);
    if (block && block.name !== "air" && block.boundingBox === "block") {
      return true;
    }
  }

  return false;
}

/**
 * Place scaffold block to support target placement
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} targetPos - Target position that needs support
 * @param {Object} args - Episode args (for RCON)
 * @returns {Promise<boolean>} True if scaffold placed
 */
async function placeScaffold(bot, targetPos, args) {
  const scaffoldPos = targetPos.offset(0, -1, 0); // Place below
  const scaffoldBlock = bot.blockAt(scaffoldPos);

  // Check if already solid
  if (scaffoldBlock && scaffoldBlock.name !== "air") {
    return false;
  }

  console.log(
    `[${bot.username}] 🧱 Placing scaffold at (${scaffoldPos.x}, ${scaffoldPos.y}, ${scaffoldPos.z})`,
  );

  try {
    const placed = await placeAt(bot, scaffoldPos, "cobblestone", {
      useSneak: true,
      tries: 3,
      args: args,
    });

    if (placed) {
      scaffoldBlocks.push(scaffoldPos.clone());
      return true;
    }
  } catch (error) {
    console.log(
      `[${bot.username}] ⚠️ Scaffold placement failed: ${error.message}`,
    );
  }

  return false;
}

/**
 * Build a phase of blocks for one bot with auto-scaffolding
 * @param {*} bot - Mineflayer bot instance
 * @param {Array<Object>} targets - Array of block targets with worldPos
 * @param {Object} options - Options {args, delayMs}
 * @returns {Promise<Object>} Build statistics {success, failed}
 */
async function buildPhase(bot, targets, options = {}) {
  const { args = null, delayMs = 150, shouldAbort = () => false } = options;

  if (targets.length === 0) {
    console.log(`[${bot.username}] No blocks assigned in this phase`);
    return { success: 0, failed: 0, aborted: false };
  }

  console.log(
    `[${bot.username}] 🏗️ Building ${targets.length} blocks in phase...`,
  );

  const blockType = targets[0].block;
  const phaseName = targets[0].phase;

  console.log(
    `[${bot.username}] 📦 Block type: ${blockType}, Phase: ${phaseName}`,
  );

  const abortIfRequested = (context) => {
    try {
      if (shouldAbort()) {
        console.log(
          `[${bot.username}] 🛑 Abort requested during ${context} (${phaseName} phase)`,
        );
        return true;
      }
    } catch (abortError) {
      console.warn(
        `[${bot.username}] ⚠️ Error while checking abort signal: ${abortError.message}`,
      );
    }
    return false;
  };

  if (abortIfRequested("phase initialization")) {
    return { success: 0, failed: 0, aborted: true };
  }

  // Sort positions: Use placementOrder if available, otherwise fallback to Y-level then distance
  const botPos = bot.entity.position;
  const sorted = targets.slice().sort((a, b) => {
    // Primary sort: placementOrder (if both have it)
    if (a.placementOrder !== undefined && b.placementOrder !== undefined) {
      return a.placementOrder - b.placementOrder;
    }

    // Fallback sort: Y-level (bottom-up), then distance (near-to-far)
    if (a.worldPos.y !== b.worldPos.y) return a.worldPos.y - b.worldPos.y;
    const distA = botPos.distanceTo(a.worldPos);
    const distB = botPos.distanceTo(b.worldPos);
    return distA - distB;
  });

  let success = 0;
  let failed = 0;

  console.log(`[${bot.username}] 🔨 Starting block placement loop...`);

  for (let i = 0; i < sorted.length; i++) {
    if (abortIfRequested(`preparing block ${i + 1}/${sorted.length}`)) {
      return { success, failed, aborted: true };
    }

    const target = sorted[i];
    const pos = target.worldPos;
    let attemptCount = 0;
    const MAX_ATTEMPTS = 3; // attempt 1 = normal, attempt 2 = cardinal reposition, attempt 3 = pathfinder scaffold-up
    let placed = false;

    while (attemptCount < MAX_ATTEMPTS && !placed) {
      if (
        abortIfRequested(
          `attempt ${attemptCount + 1} for block ${i + 1}/${sorted.length}`,
        )
      ) {
        return { success, failed, aborted: true };
      }

      try {
        // Check if block already placed
        const existingBlock = bot.blockAt(pos);
        if (existingBlock && existingBlock.name !== "air") {
          // Check if it's already the CORRECT block type we want to place
          const isCorrectBlock = existingBlock.name === blockType;

          if (isCorrectBlock) {
            console.log(
              `[${bot.username}] ✅ Correct block (${blockType}) already exists at (${pos.x}, ${pos.y}, ${pos.z})`,
            );
            success++;
            placed = true;
            break;
          } else {
            // Wrong block (terrain/obstacle) - need to clear it first
            console.log(
              `[${bot.username}] ⛏️ Clearing ${existingBlock.name} at (${pos.x}, ${pos.y}, ${pos.z}) to place ${blockType}`,
            );

            try {
              await digWithTimeout(bot, existingBlock, { timeoutMs: 5000 });
              await sleep(200); // Let block break settle
              console.log(
                `[${bot.username}] ✅ Cleared ${existingBlock.name}, ready to place ${blockType}`,
              );
            } catch (digError) {
              console.log(
                `[${bot.username}] ⚠️ Failed to clear block: ${digError.message}, will attempt placement anyway`,
              );
              // Continue anyway - placement might still work or we'll retry
            }
          }
        }

        // Auto-scaffold if no reference block
        if (!hasAdjacentSolidBlock(bot, pos)) {
          console.log(
            `[${bot.username}] 🧱 No reference block at (${pos.x}, ${pos.y}, ${pos.z}), scaffolding...`,
          );
          await placeScaffold(bot, pos, args);
          await sleep(200); // Let scaffold settle
        }

        // ATTEMPT 3 ONLY: Pathfinder scaffold-up as final fallback
        if (attemptCount === 2 && !placed) {
          console.log(
            `[${bot.username}] � Attempt 3: Using pathfinder scaffold-up as final fallback...`,
          );

          try {
            // Target position: Stand on top of the block we want to place (Y+1)
            const scaffoldTarget = new Vec3(pos.x, pos.y + 1, pos.z);

            console.log(
              `[${bot.username}] 🧗 Pathfinding to scaffold up to (${scaffoldTarget.x}, ${scaffoldTarget.y}, ${scaffoldTarget.z})...`,
            );

            // Temporarily enable digging and scaffolding for upward pathfinding
            const originalMovements = bot.pathfinder.movements;
            const scaffoldMovements = new Movements(
              bot,
              require("minecraft-data")(bot.version),
            );
            scaffoldMovements.allowSprinting = false;
            scaffoldMovements.allowParkour = true;
            scaffoldMovements.canDig = true; // Enable digging obstacles
            scaffoldMovements.canPlaceOn = true; // Enable scaffolding
            scaffoldMovements.allowEntityDetection = true;

            // Set scaffolding blocks - FORCE pathfinder to use the correct block type for this phase
            const mcData = require("minecraft-data")(bot.version);

            // blockType is already set from targets[0].block (phase-specific: cobblestone/oak_planks/oak_log)
            const targetBlockItem = bot.inventory
              .items()
              .find((item) => item.name === blockType);

            if (targetBlockItem && targetBlockItem.count > 0) {
              // Force pathfinder to ONLY use the correct block type for this phase
              const targetBlockId = mcData.itemsByName[blockType]?.id; // Use itemsByName, not blocksByName!
              if (targetBlockId) {
                scaffoldMovements.scafoldingBlocks = [targetBlockId];
                console.log(
                  `[${bot.username}] 🎯 Forcing pathfinder to use ${blockType} for ${phaseName} phase scaffolding (${targetBlockItem.count} available)`,
                );
              } else {
                // Fallback: use all scaffolding blocks
                scaffoldMovements.scafoldingBlocks =
                  getScaffoldingBlockIds(mcData);
                console.log(
                  `[${bot.username}] ⚠️ Could not get block ID for ${blockType}, using default scaffolding blocks`,
                );
              }
            } else {
              // Target block not available - use any scaffolding block
              scaffoldMovements.scafoldingBlocks =
                getScaffoldingBlockIds(mcData);
              console.log(
                `[${bot.username}] ⚠️ ${blockType} not in inventory (${phaseName} phase), using any available scaffolding blocks`,
              );
            }

            bot.pathfinder.setMovements(scaffoldMovements);

            // Pathfind to stand on top of target block (range 0 = exact position)
            // The pathfinder will automatically scaffold underneath if needed
            await gotoWithTimeout(
              bot,
              new GoalNear(
                scaffoldTarget.x,
                scaffoldTarget.y,
                scaffoldTarget.z,
                0,
              ),
              { timeoutMs: 8000 },
            );

            // Restore original movements
            bot.pathfinder.setMovements(originalMovements);

            // Settling time after pathfinding
            await sleep(300); // Reduced from 500ms for faster scaffolding

            // Verify if block was placed underneath us during scaffolding
            const placedBlock = bot.blockAt(pos);
            placed = placedBlock && placedBlock.name === blockType;

            if (placed) {
              console.log(
                `[${bot.username}] ✅ Successfully scaffolded to position (pathfinder placed correct ${phaseName} block: ${blockType})!`,
              );
              success++;
            } else {
              // Check if pathfinder placed a different block type (fallback scenario)
              if (placedBlock && placedBlock.name !== "air") {
                console.log(
                  `[${bot.username}] ⚠️ Pathfinder placed ${placedBlock.name} instead of ${blockType} (${phaseName} phase fallback), will replace...`,
                );

                // Try to dig the wrong block and place correct block
                try {
                  await digWithTimeout(bot, placedBlock, { timeoutMs: 3000 });
                  await sleep(200);

                  // Now try to place the correct block
                  placed = await placeAt(bot, pos, blockType, {
                    useSneak: false,
                    tries: 2,
                    args: args,
                  });

                  if (placed) {
                    console.log(
                      `[${bot.username}] ✅ Successfully replaced ${placedBlock.name} with ${blockType} (${phaseName} phase)!`,
                    );
                    success++;
                  } else {
                    failed++;
                    console.log(
                      `[${bot.username}] ❌ Failed to replace scaffolding block (${phaseName} phase)`,
                    );
                  }
                } catch (replaceError) {
                  failed++;
                  console.log(
                    `[${bot.username}] ❌ Error replacing scaffolding (${phaseName} phase): ${replaceError.message}`,
                  );
                }
              } else {
                // Pathfinder didn't place anything - complete failure
                failed++;
                console.log(
                  `[${bot.username}] ❌ Pathfinder scaffold-up failed - no block placed (${phaseName} phase)`,
                );
              }
            }
          } catch (scaffoldError) {
            failed++;
            console.log(
              `[${bot.username}] ❌ Pathfinder scaffold-up error: ${scaffoldError.message}`,
            );
          }

          // If placed successfully, continue to next block
          if (placed) {
            continue;
          }
        }

        // Pathfind near target (reposition on retry attempts)
        const distance = bot.entity.position.distanceTo(pos);
        const shouldReposition = attemptCount > 0 || distance > 4;

        if (shouldReposition) {
          if (attemptCount > 0) {
            console.log(
              `[${bot.username}] 🔄 Attempt ${attemptCount + 1}/${MAX_ATTEMPTS}: Repositioning for block ${i + 1}/${sorted.length}`,
            );
          } else {
            console.log(
              `[${bot.username}] 🚶 Pathfinding to block ${i + 1}/${sorted.length}, distance: ${distance.toFixed(1)}`,
            );
          }

          // On retry attempts, move to cardinally adjacent positions
          if (attemptCount > 0) {
            // Define 4 cardinal positions adjacent and y+1 to the target block
            const cardinalPositions = [
              { x: pos.x + 1, y: pos.y + 1, z: pos.z, dir: "East" }, // East
              { x: pos.x - 1, y: pos.y + 1, z: pos.z, dir: "West" }, // West
              { x: pos.x, y: pos.y + 1, z: pos.z + 1, dir: "South" }, // South
              { x: pos.x, y: pos.y + 1, z: pos.z - 1, dir: "North" }, // North
            ];

            // Find the closest cardinal position to bot's current location
            const currentBotPos = bot.entity.position;
            let closestCardinal = cardinalPositions[0];
            let minDistance = currentBotPos.distanceTo(
              new Vec3(closestCardinal.x, closestCardinal.y, closestCardinal.z),
            );

            for (const cardPos of cardinalPositions) {
              const cardVec = new Vec3(cardPos.x, cardPos.y, cardPos.z);
              const dist = currentBotPos.distanceTo(cardVec);
              if (dist < minDistance) {
                minDistance = dist;
                closestCardinal = cardPos;
              }
            }

            console.log(
              `[${bot.username}] 🧭 Moving to cardinal position ${closestCardinal.dir} of target: (${closestCardinal.x}, ${closestCardinal.y}, ${closestCardinal.z})`,
            );

            // Temporarily enable digging and block placement for cardinal repositioning
            const originalMovements = bot.pathfinder.movements;
            const diggingMovements = new Movements(
              bot,
              require("minecraft-data")(bot.version),
            );
            diggingMovements.allowSprinting = false;
            diggingMovements.allowParkour = true;
            diggingMovements.canDig = true; // Enable digging for pathfinder
            diggingMovements.canPlaceOn = true; // Enable block placement for scaffolding
            diggingMovements.allowEntityDetection = true;

            // Set scaffolding blocks - FORCE pathfinder to use the correct block type for this phase
            const mcData = require("minecraft-data")(bot.version);

            // blockType is already set from targets[0].block (phase-specific: cobblestone/oak_planks/oak_log)
            const targetBlockItem2 = bot.inventory
              .items()
              .find((item) => item.name === blockType);

            if (targetBlockItem2 && targetBlockItem2.count > 0) {
              // Force pathfinder to ONLY use the correct block type for this phase
              const targetItemId = mcData.itemsByName[blockType]?.id; // Use itemsByName, not blocksByName!
              if (targetItemId) {
                diggingMovements.scafoldingBlocks = [targetItemId];
                console.log(
                  `[${bot.username}] 🎯 Cardinal reposition: Using ${blockType} for ${phaseName} phase scaffolding (${targetBlockItem2.count} available)`,
                );
              } else {
                // Fallback: use all scaffolding blocks
                diggingMovements.scafoldingBlocks =
                  getScaffoldingBlockIds(mcData);
                console.log(
                  `[${bot.username}] ⚠️ Cardinal reposition: Could not get item ID for ${blockType}, using default scaffolding blocks`,
                );
              }
            } else {
              // Target block not available - use any scaffolding block
              diggingMovements.scafoldingBlocks =
                getScaffoldingBlockIds(mcData);
              console.log(
                `[${bot.username}] ⚠️ Cardinal reposition: ${blockType} not in inventory (${phaseName} phase), using any available scaffolding blocks`,
              );
            }

            bot.pathfinder.setMovements(diggingMovements);

            // Move to exact cardinal position (range 0 = stand exactly there)
            await gotoWithTimeout(
              bot,
              new GoalNear(
                closestCardinal.x,
                closestCardinal.y,
                closestCardinal.z,
                0,
              ),
              { timeoutMs: 8000 },
            );

            // Restore original movements (disable digging)
            bot.pathfinder.setMovements(originalMovements);

            // Extra settling time after repositioning
            await sleep(500);
          } else {
            // First attempt: normal approach (distance 3)
            bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, 3));
            await sleep(Math.min(distance * 500, 5000));
            bot.pathfinder.setGoal(null);
          }
        }

        // CHECK: Is bot colliding with target block hitbox?
        // If yes, skip regular placement and go straight to repositioning
        if (attemptCount === 0 && isBotCollidingWithBlock(bot, pos)) {
          console.log(
            `[${bot.username}] ⚠️ Bot is colliding with target block at (${pos.x}, ${pos.y}, ${pos.z}), skipping regular placement and repositioning...`,
          );
          attemptCount++;
          await sleep(150);
          continue; // Skip to next iteration which will do cardinal repositioning
        }

        // STEP 1: Try normal placement
        placed = await placeAt(bot, pos, blockType, {
          useSneak: false,
          tries: 1,
          args: args,
        });

        if (placed) {
          success++;
          if ((i + 1) % 5 === 0 || i === sorted.length - 1) {
            console.log(
              `[${bot.username}] ✅ Progress: ${success}/${sorted.length} blocks placed`,
            );
          }
        } else {
          // Normal placement failed - increment attempt and retry with repositioning
          attemptCount++;
          if (attemptCount < MAX_ATTEMPTS) {
            console.log(
              `[${bot.username}] ⚠️ Failed attempt ${attemptCount}/${MAX_ATTEMPTS} at (${pos.x}, ${pos.y}, ${pos.z}), will reposition...`,
            );
            await sleep(150); // Brief pause before retry
          } else {
            failed++;
            console.log(
              `[${bot.username}] ❌ Failed all ${MAX_ATTEMPTS} attempts at (${pos.x}, ${pos.y}, ${pos.z})`,
            );
          }
        }
      } catch (error) {
        attemptCount++;
        if (attemptCount < MAX_ATTEMPTS) {
          console.log(
            `[${bot.username}] ⚠️ Error on attempt ${attemptCount}/${MAX_ATTEMPTS} at (${pos.x}, ${pos.y}, ${pos.z}): ${error.message}, retrying...`,
          );
          await sleep(150);
        } else {
          failed++;
          console.log(
            `[${bot.username}] ❌ Error after ${MAX_ATTEMPTS} attempts at (${pos.x}, ${pos.y}, ${pos.z}): ${error.message}`,
          );
        }
      }
    }

    if (delayMs > 0 && i < sorted.length - 1) {
      await sleep(delayMs);
      if (
        abortIfRequested(`post-delay after block ${i + 1}/${sorted.length}`)
      ) {
        return { success, failed, aborted: true };
      }
    }
  }

  console.log(`[${bot.username}] ✅ Placement loop complete`);
  console.log(`[${bot.username}]    ✅ Success: ${success}/${targets.length}`);
  console.log(`[${bot.username}]    ❌ Failed: ${failed}/${targets.length}`);

  return { success, failed, aborted: false };
}

/**
 * Check if bot's hitbox overlaps with target block position
 * Bot hitbox: 0.6 wide × 1.8 tall, centered at bot position
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} targetPos - Target block position
 * @returns {boolean} True if bot is standing on/inside target block
 */
function isBotCollidingWithBlock(bot, targetPos) {
  const botPos = bot.entity.position;
  const BOT_WIDTH = 0.6; // Minecraft bot width
  const BOT_HEIGHT = 1.8; // Minecraft bot height

  // Bot's AABB (Axis-Aligned Bounding Box)
  // Bot position is at feet, center of the horizontal plane
  const botMinX = botPos.x - BOT_WIDTH / 2;
  const botMaxX = botPos.x + BOT_WIDTH / 2;
  const botMinY = botPos.y;
  const botMaxY = botPos.y + BOT_HEIGHT;
  const botMinZ = botPos.z - BOT_WIDTH / 2;
  const botMaxZ = botPos.z + BOT_WIDTH / 2;

  // Target block AABB (1×1×1 cube)
  const blockMinX = targetPos.x;
  const blockMaxX = targetPos.x + 1;
  const blockMinY = targetPos.y;
  const blockMaxY = targetPos.y + 1;
  const blockMinZ = targetPos.z;
  const blockMaxZ = targetPos.z + 1;

  // Check for AABB overlap (intersection)
  const overlapX = botMaxX > blockMinX && botMinX < blockMaxX;
  const overlapY = botMaxY > blockMinY && botMinY < blockMaxY;
  const overlapZ = botMaxZ > blockMinZ && botMinZ < blockMaxZ;

  return overlapX && overlapY && overlapZ;
}

/**
 * Cleanup scaffold blocks after building
 * @param {*} bot - Mineflayer bot instance
 * @returns {Promise<void>}
 */
async function cleanupScaffolds(bot) {
  if (scaffoldBlocks.length === 0) {
    console.log(`[${bot.username}] No scaffolds to clean up`);
    return;
  }

  console.log(
    `[${bot.username}] 🧹 Cleaning up ${scaffoldBlocks.length} scaffold blocks...`,
  );

  for (const pos of scaffoldBlocks) {
    try {
      const block = bot.blockAt(pos);
      if (block && block.name === "cobblestone") {
        await digWithTimeout(bot, block, { timeoutMs: 5000 });
        await sleep(200);
      }
    } catch (error) {
      console.log(
        `[${bot.username}] ⚠️ Failed to remove scaffold at (${pos.x}, ${pos.y}, ${pos.z}): ${error.message}`,
      );
    }
  }

  scaffoldBlocks.length = 0; // Clear array
  console.log(`[${bot.username}] ✅ Scaffold cleanup complete`);
}

/**
 * Both bots exit through door and admire the house
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} doorWorldPos - World position of door
 * @param {number} orientation - House orientation (0, 90, 180, 270)
 * @param {Object} options - Options {backOff: distance}
 * @returns {Promise<void>}
 */
async function admireHouse(bot, doorWorldPos, orientation, options = {}) {
  const { backOff = 7 } = options;

  const { GoalNear } = require("mineflayer-pathfinder").goals;

  // Step 0: If bot is elevated (on roof), jump down to ground level
  const botY = bot.entity.position.y;
  const doorY = doorWorldPos.y;

  if (botY > doorY + 1.5) {
    console.log(
      `[${bot.username}] 🪂 Bot is on roof, jumping down to ground...`,
    );

    // Just pathfind to door - pathfinder will jump down automatically
    bot.pathfinder.setGoal(
      new GoalNear(doorWorldPos.x, doorY, doorWorldPos.z, 3),
    );
    await sleep(5000); // Time for jumping down
    bot.pathfinder.setGoal(null);
    await sleep(500); // Stabilize after landing

    console.log(`[${bot.username}] ✅ Reached ground level`);
  }

  console.log(`[${bot.username}] 🚪 Exiting through door...`);

  // Step 1: Pathfind through door
  bot.pathfinder.setGoal(
    new GoalNear(doorWorldPos.x, doorWorldPos.y, doorWorldPos.z, 1),
  );
  await sleep(3000);
  bot.pathfinder.setGoal(null);

  // Step 2: Pick a shared random position around the house, with bots standing side by side
  // Generate random angle (0-360°) and distance (10-20 blocks) - SHARED between both bots
  const houseCenter = doorWorldPos.offset(2, 0, 2); // Center of 5x5 house at ground level

  // Use a deterministic random based on house position so both bots get same angle
  const seed = houseCenter.x + houseCenter.z * 1000;
  const seededRandom = Math.abs(Math.sin(seed));
  const randomAngle = seededRandom * 2 * Math.PI; // Random angle in radians (shared)
  const randomDistance = 12 + Math.abs(Math.sin(seed * 2)) * 8; // Random distance 12-20 blocks (shared)

  // Calculate base position using polar coordinates
  const baseOffsetX = Math.cos(randomAngle) * randomDistance;
  const baseOffsetZ = Math.sin(randomAngle) * randomDistance;

  // Calculate perpendicular offset for side-by-side positioning (3 blocks apart)
  // Perpendicular angle is 90° offset from viewing angle
  const perpAngle = randomAngle + Math.PI / 2;
  const sideOffset = bot.username.includes("Alpha") ? -1.5 : 1.5; // Alpha left, Bravo right
  const sideOffsetX = Math.cos(perpAngle) * sideOffset;
  const sideOffsetZ = Math.sin(perpAngle) * sideOffset;

  const lookFromPos = houseCenter.offset(
    baseOffsetX + sideOffsetX,
    0,
    baseOffsetZ + sideOffsetZ,
  );

  console.log(
    `[${bot.username}] 🚶 Moving to admire position (angle: ${((randomAngle * 180) / Math.PI).toFixed(0)}°, distance: ${randomDistance.toFixed(1)} blocks, side: ${bot.username.includes("Alpha") ? "left" : "right"})...`,
  );
  bot.pathfinder.setGoal(
    new GoalNear(lookFromPos.x, lookFromPos.y, lookFromPos.z, 1),
  );
  await sleep(5000); // Extra time for potentially longer paths
  bot.pathfinder.setGoal(null);

  // Step 3: Look at house center
  const houseCenterLookTarget = houseCenter.offset(0, 2, 0); // Look at middle height of house
  console.log(`[${bot.username}] 👀 Looking at house together...`);
  await bot.lookAt(houseCenterLookTarget, false);
  await sleep(2000);

  console.log(`[${bot.username}] ✅ Admire sequence complete`);
}

/**
 * Build a bridge towards a target position using pathfinder with automatic scaffolding
 * This leverages mineflayer-pathfinder's built-in block placement capabilities
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} targetPos - Target position to build towards
 * @param {string} bridgeBlockType - Block type to use for bridge
 * @param {number} bridgeGoalDistance - Goal distance to target
 * @param {number} bridgeTimeoutMs - Timeout in milliseconds
 * @param {Object} args - Configuration arguments
 * @returns {Promise<Object>} Build statistics
 */
async function buildBridge(
  bot,
  targetPos,
  bridgeBlockType,
  bridgeGoalDistance,
  bridgeTimeoutMs,
  args,
) {
  console.log(
    `[${bot.username}] 🌉 Building bridge with pathfinder to (${targetPos.x}, ${targetPos.y}, ${targetPos.z})`,
  );

  const startPos = bot.entity.position.clone();
  const mcData = require("minecraft-data")(bot.version);

  // Calculate distance for logging
  const dx = targetPos.x - startPos.x;
  const dz = targetPos.z - startPos.z;
  const horizontalDistance = Math.sqrt(dx * dx + dz * dz);

  console.log(
    `[${bot.username}] 📐 Distance to target: ${horizontalDistance.toFixed(2)} blocks`,
  );

  // 1. Ensure we have blocks in inventory
  await ensureItemInHand(bot, bridgeBlockType, args);

  // Estimate blocks needed (distance * 1.5 for safety margin)
  const estimatedBlocks = Math.ceil(horizontalDistance * 1.5);
  console.log(
    `[${bot.username}] 📦 Estimated blocks needed: ~${estimatedBlocks}`,
  );

  // 2. Configure pathfinder movements with scaffolding enabled
  console.log(`[${bot.username}] � Configuring pathfinder with scaffolding...`);
  const movements = new Movements(bot, mcData);

  // Movement capabilities
  movements.allowSprinting = false; // No sprinting for safety at height
  movements.allowParkour = true; // Allow jumping gaps if needed
  movements.canDig = true; // Don't break existing blocks
  movements.canPlaceOn = true; // ENABLE automatic block placement
  movements.allowEntityDetection = true; // Avoid other bot
  movements.maxDropDown = 15; // Very conservative - we're high up!
  movements.infiniteLiquidDropdownDistance = true; // No water at this height

  // Configure scaffolding blocks (blocks pathfinder can place)
  // Note: Property is 'scafoldingBlocks' (one 'f') in mineflayer-pathfinder - this is intentional
  movements.scafoldingBlocks = getScaffoldingBlockIds(mcData);

  console.log(
    `[${bot.username}] ✅ Pathfinder configured with ${movements.scafoldingBlocks.length} scaffolding block types`,
  );

  // Apply movements to pathfinder
  bot.pathfinder.setMovements(movements);

  // 3. Enable sneaking for safety (prevents falling off edges)
  console.log(`[${bot.username}] 🐢 Enabling sneak mode for safety...`);
  bot.setControlState("sneak", true);
  await sleep(500); // Let sneak activate

  // 4. Set pathfinding goal to target position
  const goal = new GoalNear(
    targetPos.x,
    targetPos.y,
    targetPos.z,
    bridgeGoalDistance,
  );

  console.log(
    `[${bot.username}] 🎯 Setting pathfinder goal (within ${bridgeGoalDistance} blocks of target)`,
  );
  console.log(
    `[${bot.username}] 🚀 Starting pathfinder - will automatically place blocks as needed!`,
  );

  let blocksPlaced = 0;
  const onBlockPlaced = () => {
    blocksPlaced++;
    if (blocksPlaced % 5 === 0) {
      console.log(
        `[${bot.username}] 🧱 Pathfinder has placed ~${blocksPlaced} blocks so far...`,
      );
    }
  };

  bot.on("blockPlaced", onBlockPlaced);

  try {
    // Use gotoWithTimeout to prevent infinite pathfinding
    await gotoWithTimeout(bot, goal, {
      timeoutMs: bridgeTimeoutMs,
      stopOnTimeout: true,
    });

    const endPos = bot.entity.position.clone();
    const distanceTraveled = startPos.distanceTo(endPos);

    console.log(`[${bot.username}] 🏁 Bridge building complete!`);
    console.log(
      `[${bot.username}]    Distance traveled: ${distanceTraveled.toFixed(2)} blocks`,
    );
    console.log(
      `[${bot.username}]    Blocks placed: ~${blocksPlaced} (estimated)`,
    );
    console.log(`[${bot.username}] ✅ Successfully reached midpoint!`);

    return {
      success: true,
      blocksPlaced: blocksPlaced,
      distanceTraveled: distanceTraveled,
    };
  } catch (error) {
    const endPos = bot.entity.position.clone();
    const distanceTraveled = startPos.distanceTo(endPos);

    console.log(
      `[${bot.username}] ⚠️ Pathfinding did not complete: ${error.message}`,
    );
    console.log(
      `[${bot.username}]    Distance traveled: ${distanceTraveled.toFixed(2)} blocks`,
    );
    console.log(
      `[${bot.username}]    Blocks placed: ~${blocksPlaced} (estimated)`,
    );

    // Check if we got close enough despite the error
    const finalDistance = endPos.distanceTo(targetPos);
    if (finalDistance < bridgeGoalDistance * 2) {
      console.log(
        `[${bot.username}] ✅ Close enough to target (${finalDistance.toFixed(2)} blocks)`,
      );
      return {
        success: true,
        blocksPlaced: blocksPlaced,
        distanceTraveled: distanceTraveled,
        partialSuccess: true,
      };
    }

    return {
      success: false,
      blocksPlaced: blocksPlaced,
      distanceTraveled: distanceTraveled,
      error: error.message,
    };
  } finally {
    // Clean up
    bot.removeListener("blockPlaced", onBlockPlaced);
    bot.setControlState("sneak", false);
    console.log(`[${bot.username}] 🚶 Sneak mode disabled`);
  }
}

/**
 * Local air-like predicate used by the custom placement helpers below.
 * @param {*} block - Block to check
 * @returns {boolean} True if block is missing/air/empty-bounding-box
 */
function isAirLikeLocal(block) {
  return !block || block.name === "air" || block.boundingBox === "empty";
}

/**
 * Get maximum block reach distance for the bot given its game mode.
 * @param {*} bot - Mineflayer bot instance
 * @returns {number} Maximum reach distance in blocks
 */
function reachMax(bot) {
  return bot.game && bot.game.gameMode === 1 ? 6 : 4.5;
}

/**
 * Check whether a position is within reach, using local reach rules.
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} pos - Position to check
 * @param {number} [max=reachMax(bot)] - Maximum reach distance
 * @returns {boolean} True if the position is within reach
 */
function inReachLocal(bot, pos, max = reachMax(bot)) {
  const center = pos.offset(0.5, 0.5, 0.5);
  return bot.entity.position.distanceTo(center) <= max;
}

/**
 * Compute the center point of a specific face on a reference block.
 * @param {*} refBlock - Reference block to click/place against
 * @param {Vec3} faceVec - Face normal vector
 * @returns {Vec3} World position of the face center
 */
function faceCenterOf(refBlock, faceVec) {
  return refBlock.position.offset(
    0.5 + faceVec.x * 0.5,
    0.5 + faceVec.y * 0.5,
    0.5 + faceVec.z * 0.5,
  );
}

/**
 * Compute an appropriate tick delay between block placements for a structure size.
 * @param {number} blockCount - Number of blocks in the structure being placed
 * @returns {number} Delay in ticks between placements
 */
const getBlockPlaceDelayTicks = (blockCount) => {
  if (blockCount === 2) return 4; // tower: 0.55 seconds (15 ticks)
  if (blockCount === 4) return 4; // wall: 0.6 seconds (12 ticks) - REDUCED
  return 4; // Default: 0.55 seconds (15 ticks)
};

/**
 * Lightweight line-of-sight test from bot eye to a specific face center.
 * @param {*} bot - Mineflayer bot instance
 * @param {*} refBlock - Reference block
 * @param {Vec3} faceVec - Face normal vector
 * @returns {boolean} True if the ray is not obstructed by solid blocks
 */
function hasLineOfSightToFaceLocal(bot, refBlock, faceVec) {
  try {
    const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
    const faceCenter = faceCenterOf(refBlock, faceVec);
    const dx = faceCenter.x - eye.x;
    const dy = faceCenter.y - eye.y;
    const dz = faceCenter.z - eye.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    const step = 0.2; // blocks per step
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = eye.x + dx * t;
      const py = eye.y + dy * t;
      const pz = eye.z + dz * t;
      const bpos = new Vec3(Math.floor(px), Math.floor(py), Math.floor(pz));
      if (bpos.equals(refBlock.position)) continue; // ignore the face's own block
      const b = bot.blockAt(bpos);
      if (b && b.boundingBox === "block") return false; // obstructed
    }
    return true;
  } catch (_) {
    return true; // be permissive on error
  }
}

/**
 * Find a reference block and face that are both reachable and visible for placement.
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} targetPos - Target position where a block will be placed
 * @returns {{refBlock: *, faceVec: Vec3} | null} Placement reference or null if none found
 */
function findVisibleReachablePlaceReferenceLocal(bot, targetPos) {
  for (const face of CARDINALS) {
    const refPos = targetPos.plus(face);
    const refBlock = bot.blockAt(refPos);
    if (!refBlock) continue;
    if (refBlock.boundingBox !== "block" || refBlock.material === "noteblock")
      continue;
    const faceVec = new Vec3(-face.x, -face.y, -face.z);
    if (!inReachLocal(bot, refBlock.position)) continue;
    if (!hasLineOfSightToFaceLocal(bot, refBlock, faceVec)) continue;
    return { refBlock, faceVec };
  }
  return null;
}

/**
 * Attempt to place a block using an explicit reference block and face vector.
 * This is a low-overhead placement helper used by `placeMultipleWithDelay`.
 * @param {*} bot - Mineflayer bot instance
 * @param {Vec3} targetPos - Target position where a block should appear
 * @param {string} itemName - Item/block name to place
 * @param {*} refBlock - Reference block to place against
 * @param {Vec3} faceVec - Face vector (normal direction) to click on reference block
 * @param {Object} [options={}] - Placement options
 * @param {boolean} [options.useSneak=true] - Whether to sneak while placing
 * @param {number} [options.tries=2] - Number of placement attempts
 * @param {Object} [options.args=null] - Episode args (e.g., RCON config)
 * @returns {Promise<boolean>} True if the block is placed/confirmed
 */
async function tryPlaceAtUsingLocal(
  bot,
  targetPos,
  itemName,
  refBlock,
  faceVec,
  options = {},
) {
  const { useSneak = true, tries = 2, args = null } = options;
  // early exit if already placed
  if (!isAirLikeLocal(bot.blockAt(targetPos))) return true;
  await ensureItemInHand(bot, itemName, args);
  const sneakWas = bot.getControlState("sneak");
  if (useSneak) bot.setControlState("sneak", true);
  try {
    for (let i = 0; i < tries; i++) {
      if (!inReachLocal(bot, refBlock.position)) return false; // let caller fallback
      try {
        await bot.placeBlock(refBlock, faceVec);
      } catch (e) {
        await bot.waitForTicks(4);
        continue;
      }
      const placed = !isAirLikeLocal(bot.blockAt(targetPos));
      if (placed) return true;
      await bot.waitForTicks(4);
    }
    return !isAirLikeLocal(bot.blockAt(targetPos));
  } finally {
    if (useSneak && !sneakWas) bot.setControlState("sneak", false);
  }
}

/**
 * Place multiple blocks with delay between each placement (custom version for structureEval)
 * This version overrides the lookAt behavior to use smooth looking instead of instant snap
 * @param {*} bot - Mineflayer bot instance
 * @param {Array<Vec3>} positions - Array of positions to place blocks
 * @param {string} itemName - Name of block/item to place
 * @param {Object} options - Options for placement
 * @returns {Promise<Object>} {success: number, failed: number, placed: number}
 */
async function placeMultipleWithDelay(
  bot,
  positions,
  itemName,
  placementStandoffBlocks,
  adjacentGoalRadius,
  options = {},
) {
  const { delayTicks = 0 } = options;

  // Sort positions: bottom-up (Y), then far-to-near, then left-to-right
  // FAR-TO-NEAR ensures blocks are placed from furthest to closest,
  // preventing blocks from being placed through other unplaced blocks
  const botPos = bot.entity.position;
  const sorted = positions.slice().sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y; // Bottom first
    const distA = botPos.distanceTo(a);
    const distB = botPos.distanceTo(b);
    if (Math.abs(distA - distB) > 0.5) return distB - distA; // FAR first (reversed)
    return a.x - b.x; // Left to right
  });

  let success = 0;
  let failed = 0;

  // Override bot.lookAt to prevent camera movement during placeAt internal retries
  // We'll manually control when the bot looks (before each placement)
  const LOOK_SETTLE_DELAY_TICKS = 18; // Time to wait for smooth camera rotation to complete
  let allowLookAt = true; // Flag to control when lookAt is allowed
  const originalLookAt = bot.lookAt.bind(bot);
  bot.lookAt = async function (position, forceLook) {
    // Only allow lookAt when explicitly enabled
    if (allowLookAt) {
      // Use smooth looking and wait for it to settle
      await originalLookAt(position, false);
      await bot.waitForTicks(LOOK_SETTLE_DELAY_TICKS); // 500ms / 20 ticks/second
    }
    // When disabled: do nothing, maintain current camera angle
    // This prevents placeAt's internal retry logic from moving the camera
  };

  try {
    // Initialize pathfinder for movement
    initializePathfinder(bot, {
      allowSprinting: false,
      allowParkour: false,
      canDig: false,
      allowEntityDetection: true,
    });

    let blockIndex = 0; // Track which block we're placing
    for (const pos of sorted) {
      blockIndex++;

      try {
        // Move bot to stand ADJACENT to the block position before placing
        // This creates natural "walking along while building" behavior
        const currentBotPos = bot.entity.position.clone();

        // Calculate adjacent position with a diagonal stance (never exactly parallel)
        // For X-axis walls: move 2 blocks to the south (Z-) AND 1 block west (X-)
        // For Z-axis walls (and towers): move 2 blocks to the west (X-) AND 1 block north (Z-)
        // This diagonal offset makes at least two side faces and often the top visible at ground level.
        const adjacentPos = pos.clone();

        // Determine wall direction by checking if positions vary in X or Z
        const firstPos = sorted[0];
        const lastPos = sorted[sorted.length - 1];
        const isXAxis =
          Math.abs(lastPos.x - firstPos.x) > Math.abs(lastPos.z - firstPos.z);

        if (isXAxis) {
          // Side offset along Z-, and along-wall offset west (X-)
          adjacentPos.z -= placementStandoffBlocks; // 2 blocks south
          adjacentPos.x += -1; // 1 block west (diagonal)
        } else {
          // Side offset along X-, and along-wall offset north (Z-)
          adjacentPos.x -= placementStandoffBlocks; // 2 blocks west
          adjacentPos.z += -1; // 1 block north (diagonal)
        }

        // HARD-CODED ENFORCEMENT: Skip adjacent movement for 4th block in 4-block structures
        const skip4BlockMovement = blockIndex === 4 && sorted.length === 4;

        // Move to adjacent position if not already there and skip4BlockMovement is false
        const distanceToAdjacent = currentBotPos.distanceTo(adjacentPos);
        if (distanceToAdjacent > adjacentGoalRadius && !skip4BlockMovement) {
          console.log(
            `[${bot.username}] 🚶 Moving to adjacent position (${adjacentPos.x.toFixed(1)}, ${adjacentPos.y}, ${adjacentPos.z.toFixed(1)}) before placing at ${pos}`,
          );
          const adjacentGoal = new GoalNear(
            adjacentPos.x,
            adjacentPos.y,
            adjacentPos.z,
            adjacentGoalRadius,
          );

          try {
            await gotoWithTimeout(bot, adjacentGoal, { timeoutTicks: 60 });
          } catch (moveError) {
            console.log(
              `[${bot.username}] ⚠️ Could not move to adjacent position: ${moveError.message}`,
            );
          }
        } else if (skip4BlockMovement) {
          console.log(
            `[${bot.username}] � FORCED NO-MOVE: Skipping adjacent movement for 4th block at ${pos}`,
          );
        }

        // HARD-CODED FIX: Force 4th block to use the block directly below (top face)
        let forcedReference = null;
        if (blockIndex === 4 && sorted.length === 4) {
          // This is the 4th block in a 4-block structure (2x2 wall or 4x1 wall)
          const belowPos = pos.offset(0, -1, 0);
          const belowBlock = bot.blockAt(belowPos);
          if (belowBlock && belowBlock.boundingBox === "block") {
            forcedReference = {
              refBlock: belowBlock,
              faceVec: new Vec3(0, 1, 0), // Click the TOP face
            };
            console.log(
              `[${bot.username}] 🎯 FORCED: 4th block will use TOP face of block below at ${belowPos}`,
            );
          }
        }

        // Use forced reference if available, otherwise use normal logic
        const visibleRef =
          forcedReference || findVisibleReachablePlaceReferenceLocal(bot, pos);
        // Fallback reference if none visible from here (may trigger pathfinder later)
        const placeReference = visibleRef || findPlaceReference(bot, pos);
        if (placeReference) {
          const { refBlock, faceVec } = placeReference;

          // Calculate the specific face position to look at (not the center)
          const lookAtFacePos = refBlock.position.offset(
            0.5 + faceVec.x * 0.5,
            0.5 + faceVec.y * 0.5,
            0.5 + faceVec.z * 0.5,
          );

          // EXPLICITLY look at the reference block's face (where we'll click)
          // This also verifies line of sight - if lookAt fails, we don't have LOS
          allowLookAt = true;
          try {
            await bot.lookAt(lookAtFacePos);
            console.log(
              `[${bot.username}] 👁️ Looking at reference face at ${refBlock.position} (face: ${faceVec.x},${faceVec.y},${faceVec.z}) ${visibleRef ? "[visible+reachable]" : "[fallback]"}${skip4BlockMovement ? " [NO-MOVE]" : ""}`,
            );
          } catch (lookError) {
            console.log(
              `[${bot.username}] ⚠️ Cannot look at reference block face - no line of sight: ${lookError.message}`,
            );
          }
        } else {
          console.log(
            `[${bot.username}] ⚠️ No reference block found for position ${pos}`,
          );
        }

        // Now disable lookAt during placeAt to prevent camera resetting
        allowLookAt = false;
        // If we have a visible+reachable face, place directly using it; else fallback to robust placeAt (may pathfind)
        let placed;
        if (visibleRef) {
          placed = await tryPlaceAtUsingLocal(
            bot,
            pos,
            itemName,
            visibleRef.refBlock,
            visibleRef.faceVec,
            options,
          );
          if (!placed) {
            console.log(
              `[${bot.username}] 🔁 Visible+reachable face placement failed; falling back to robust placeAt (may pathfind)`,
            );
            placed = await placeAt(bot, pos, itemName, options);
          }
        } else {
          placed = await placeAt(bot, pos, itemName, options);
        }

        if (placed) {
          success++;
          console.log(`[${bot.username}] ✅ Placed block at ${pos}`);
        } else {
          failed++;
          console.log(`[${bot.username}] ❌ Failed to place at ${pos}`);
        }
      } catch (error) {
        failed++;
        console.log(
          `[${bot.username}] ❌ Error placing at ${pos}: ${error.message}`,
        );
      }

      // Add delay between blocks if specified
      if (delayTicks > 0) {
        await bot.waitForTicks(delayTicks);
      }
    }
  } finally {
    // Restore original lookAt behavior
    bot.lookAt = originalLookAt;
    stopPathfinder(bot);
  }

  return { success, failed, placed: success };
}

/**
 * Main building loop - bot builds assigned structure
 * @param {*} bot - Mineflayer bot instance
 * @param {Array<Vec3>} positions - Positions to build at
 * @param {string} blockType - Type of block to place
 * @param {Object} args - Configuration arguments
 * @returns {Promise<Object>} Build statistics
 */
async function buildStructure(
  bot,
  positions,
  blockType,
  placementStandoffBlocks,
  adjacentGoalRadius,
  args,
) {
  console.log(
    `[${bot.username}] 🏗️ Starting to build ${positions.length} blocks...`,
  );

  // Initialize pathfinder for movement
  initializePathfinder(bot, {
    allowSprinting: false,
    allowParkour: true,
    canDig: true,
    allowEntityDetection: true,
  });

  try {
    const result = await placeMultipleWithDelay(
      bot,
      positions,
      blockType,
      placementStandoffBlocks,
      adjacentGoalRadius,
      {
        useSneak: true,
        tries: 5,
        args: args,
        delayTicks: getBlockPlaceDelayTicks(positions.length), // Add delay between blocks
      },
    );

    console.log(`[${bot.username}] 🏁 Build complete!`);
    console.log(
      `[${bot.username}]    Success: ${result.success}/${positions.length}`,
    );
    console.log(
      `[${bot.username}]    Failed: ${result.failed}/${positions.length}`,
    );

    return result;
  } finally {
    stopPathfinder(bot);
  }
}

module.exports = {
  makeHouseBlueprint5x5,
  rotateLocalToWorld,
  splitWorkByXAxis,
  calculateMaterialCounts,
  buildPhase,
  buildBridge,
  cleanupScaffolds,
  admireHouse,
  calculateFloorPlacementOrder,
  getPerimeterPosition,
  calculateWallPlacementOrder,
  calculateRoofPlacementOrder,
  isBotCollidingWithBlock,
  placeAt,
  placeMultiple,
  isAirLike,
  inReach,
  findPlaceReference,
  ensureReachAndSight,
  fastPlaceBlock,
  buildTowerUnderneath,
  CARDINALS,
  scoreFace,
  findBestPlaceReference,
  raycastToPosition,
  isBlockObstructed,
  canSeeFace,
  isPositionSafe,
  calculateOptimalPosition,
  moveToPlacementPosition,
  hasAdjacentSupport,
  sortByBuildability,
  prepareForPlacement,
  buildStructure,
  getBlockPlaceDelayTicks,
};
