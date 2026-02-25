// Movement and behavior constants
const MIN_WALK_DISTANCE = 3;
const MAX_WALK_DISTANCE = 4;
const MIN_BOTS_DISTANCE = 10;
const MAX_BOTS_DISTANCE = 15;
const DEFAULT_CAMERA_SPEED_DEGREES_PER_SEC = 60;
const JUMP_PROBABILITY = 0.25;
const MIN_JUMP_DURATION_SEC = 1;
const MAX_JUMP_DURATION_SEC = 3;
const MIN_SLEEP_BETWEEN_ACTIONS_SEC = 0.2;
const MAX_SLEEP_BETWEEN_ACTIONS_SEC = 0.5;

// Landable block types for random position generation
const LANDABLE_BLOCKS = [
  "dirt",
  "stone",
  "sand",
  "grass_block",
  "snow",
  "gravel",
  "sandstone",
  "red_sand",
  "terracotta",
  "mycelium",
  "end_stone",
  "nether_bricks",
  "blackstone",
  "polished_blackstone_bricks",
  "cracked_polished_blackstone_bricks",
  "netherrack",
];

module.exports = {
  MIN_WALK_DISTANCE,
  MAX_WALK_DISTANCE,
  MIN_BOTS_DISTANCE,
  MAX_BOTS_DISTANCE,
  DEFAULT_CAMERA_SPEED_DEGREES_PER_SEC,
  JUMP_PROBABILITY,
  MIN_JUMP_DURATION_SEC,
  MAX_JUMP_DURATION_SEC,
  MIN_SLEEP_BETWEEN_ACTIONS_SEC,
  MAX_SLEEP_BETWEEN_ACTIONS_SEC,
  LANDABLE_BLOCKS,
};
