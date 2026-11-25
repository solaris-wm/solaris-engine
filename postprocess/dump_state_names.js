// Dump {blockStateId: blockName} for a Minecraft version using minecraft-data.
// Used to colour the voxel renderer (and as the state-id -> block-type map).
//   node dump_state_names.js <version> > state_names.json
const version = process.argv[2] || "1.21";
const mc = require("minecraft-data")(version);
const out = {};
for (const b of mc.blocksArray) {
  for (let s = b.minStateId; s <= b.maxStateId; s++) out[s] = b.name;
}
process.stdout.write(JSON.stringify(out));
