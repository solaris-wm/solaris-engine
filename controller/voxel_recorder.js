const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// Written for cells outside any loaded chunk; also the state id of air.
const AIR_STATE_ID = 0;

// Per-record header: int64 epoch (ms) + int32 origin x/y/z, all little-endian.
const HEADER_BYTES = 20;

/**
 * Read a cube of block state ids of edge length `gridSize`, centred on the
 * block containing `center`.  Cells are ordered x outermost, z innermost,
 * matching the on-disk record layout.
 *
 * @param {(x:number,y:number,z:number)=>number|null} readStateId - State id at
 *   a world cell, or null/undefined when the cell is unavailable.
 * @param {{x:number,y:number,z:number}} center - World position to centre on.
 * @param {number} gridSize - Cube edge length in blocks.
 * @returns {{origin:[number,number,number], cells:Uint16Array}}
 */
function captureCube(readStateId, center, gridSize) {
  const half = Math.floor(gridSize / 2);
  const ox = Math.floor(center.x) - half;
  const oy = Math.floor(center.y) - half;
  const oz = Math.floor(center.z) - half;
  const cells = new Uint16Array(gridSize * gridSize * gridSize);
  let i = 0;
  for (let x = 0; x < gridSize; x++) {
    for (let y = 0; y < gridSize; y++) {
      for (let z = 0; z < gridSize; z++) {
        const stateId = readStateId(ox + x, oy + y, oz + z);
        cells[i++] = stateId == null ? AIR_STATE_ID : stateId;
      }
    }
  }
  return { origin: [ox, oy, oz], cells };
}

/**
 * Serialize one capture into the uncompressed on-the-wire byte layout: int64
 * epoch + int32 origin x/y/z + uint16 cells, all little-endian.
 *
 * @param {number} epochMs - Capture time in milliseconds since the Unix epoch.
 * @param {[number,number,number]} origin - World coordinate of cube cell (0,0,0).
 * @param {Uint16Array} cells - Block state ids, x outermost / z innermost.
 * @returns {Buffer}
 */
function encodeRecord(epochMs, origin, cells) {
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeBigInt64LE(BigInt(epochMs), 0);
  header.writeInt32LE(origin[0], 8);
  header.writeInt32LE(origin[1], 12);
  header.writeInt32LE(origin[2], 16);
  const body = Buffer.from(cells.buffer, cells.byteOffset, cells.byteLength);
  return Buffer.concat([header, body]);
}

const pad = (value, length = 2) => String(value).padStart(length, "0");

// Same timestamp shape the controller uses for its other per-episode files.
function formatTimestamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Path of the gzipped voxel stream for an episode, using the controller's
 * `{timestamp}_{episode}_{bot}_instance_{id}` output naming.
 */
function voxelStreamPath(args, episodeNum, date) {
  const ts = formatTimestamp(date);
  const ep = String(episodeNum).padStart(6, "0");
  const iid = String(args.instance_id ?? 0).padStart(3, "0");
  const base = `${ts}_${ep}_${args.bot_name}_instance_${iid}_voxels`;
  return path.join(args.output_dir, `${base}.bin.gz`);
}

/** Sidecar path: ``X_voxels.bin.gz`` -> ``X_voxels_meta.json``. */
function metaPathFor(streamPath) {
  const dir = path.dirname(streamPath);
  const name = path.basename(streamPath).replace(/\.bin\.gz$/, "");
  return path.join(dir, `${name}_meta.json`);
}

/**
 * Build a recorder that captures an agent-centred cube of block state ids once
 * per interval and writes a gzipped stream plus a JSON sidecar per episode.
 *
 * @param {*} bot - Mineflayer bot instance.
 * @param {Object} args - Parsed config (voxel_grid, voxel_interval, output_dir,
 *   bot_name, instance_id, mc_version).
 * @returns {{start:(episodeNum:number)=>void, stop:()=>void}}
 */
function makeVoxelRecorder(bot, args) {
  const { Vec3 } = require("vec3");

  const gridSize = Number(args.voxel_grid);
  const intervalMs = Number(args.voxel_interval);
  const cursor = new Vec3(0, 0, 0);
  const readStateId = (x, y, z) => {
    try {
      return bot.world.getBlockStateId(cursor.set(x, y, z));
    } catch (_) {
      return null;
    }
  };

  let timer = null;
  let gzip = null;
  let streamPath = null;

  function captureOnce() {
    if (!bot.entity || !bot.world) return;
    const { origin, cells } = captureCube(readStateId, bot.entity.position, gridSize);
    gzip.write(encodeRecord(Date.now(), origin, cells));
  }

  function start(episodeNum) {
    if (timer) return;
    streamPath = voxelStreamPath(args, episodeNum, new Date());
    gzip = zlib.createGzip();
    gzip.pipe(fs.createWriteStream(streamPath));
    timer = setInterval(captureOnce, intervalMs);
    console.log(
      `[${bot.username}] Recording voxels (${gridSize}^3 @ ${intervalMs}ms) to ${streamPath}`,
    );
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    gzip.end();
    gzip = null;
    const meta = { grid_size: gridSize, mc_version: args.mc_version };
    fs.writeFileSync(metaPathFor(streamPath), JSON.stringify(meta));
    console.log(`[${bot.username}] Stopped voxel recording: ${streamPath}`);
  }

  return { start, stop };
}

module.exports = {
  captureCube,
  encodeRecord,
  voxelStreamPath,
  metaPathFor,
  makeVoxelRecorder,
};
