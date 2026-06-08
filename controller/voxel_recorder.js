const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// Written for cells outside any loaded chunk; also the state id of air.
const AIR_STATE_ID = 0;

// Per-record header: int64 epoch (ms) + int32 origin x/y/z, all little-endian.
const HEADER_BYTES = 20;

/**
 * Capture a cube of block state ids of edge length `gridSize`, centred on the
 * block containing `center`.  Resolves each overlapping chunk column once
 * (`world.getColumn`) and reads its cells -- far cheaper than a per-cell world
 * lookup.  Cells are ordered x outermost, z innermost, matching the on-disk
 * record layout.
 *
 * @param {*} world - prismarine-world sync World (provides `getColumn`).
 * @param {{x:number,y:number,z:number}} center - World position to centre on.
 * @param {number} gridSize - Cube edge length in blocks.
 * @returns {{origin:[number,number,number], cells:Uint16Array}}
 */
function captureCube(world, center, gridSize) {
  const half = Math.floor(gridSize / 2);
  const ox = Math.floor(center.x) - half;
  const oy = Math.floor(center.y) - half;
  const oz = Math.floor(center.z) - half;
  const g = gridSize;
  const cells = new Uint16Array(g * g * g);
  const pos = { x: 0, y: 0, z: 0 };
  const cxMin = ox >> 4, cxMax = (ox + g - 1) >> 4;
  const czMin = oz >> 4, czMax = (oz + g - 1) >> 4;
  for (let cx = cxMin; cx <= cxMax; cx++) {
    const wxLo = Math.max(ox, cx * 16);
    const wxHi = Math.min(ox + g - 1, cx * 16 + 15);
    for (let cz = czMin; cz <= czMax; cz++) {
      const wzLo = Math.max(oz, cz * 16);
      const wzHi = Math.min(oz + g - 1, cz * 16 + 15);
      const col = world.getColumn(cx, cz);
      for (let wx = wxLo; wx <= wxHi; wx++) {
        pos.x = wx & 15; // chunk-local x (getBlockStateId expects posInChunk coords)
        const lxg = (wx - ox) * g;
        for (let wy = oy; wy < oy + g; wy++) {
          pos.y = wy;
          const base = (lxg + (wy - oy)) * g - oz;
          for (let wz = wzLo; wz <= wzHi; wz++) {
            pos.z = wz & 15; // chunk-local z
            cells[base + wz] = col ? col.getBlockStateId(pos) : AIR_STATE_ID;
          }
        }
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
  const gridSize = Number(args.voxel_grid);
  const intervalMs = Number(args.voxel_interval);

  let timer = null;
  let gzip = null;
  let streamPath = null;

  function captureOnce() {
    if (!bot.entity || !bot.world) return;
    const { origin, cells } = captureCube(bot.world, bot.entity.position, gridSize);
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
