const TEAM_NAME = "solaris_hidden_tags";

async function hideNameTags(rcon, playerNames) {
  try {
    await rcon.send(`team remove ${TEAM_NAME}`);
  } catch (err) {
    // Team may not exist on first run — safe to ignore
  }

  await rcon.send(`team add ${TEAM_NAME}`);
  await rcon.send(`team modify ${TEAM_NAME} nametagVisibility never`);

  for (const name of playerNames) {
    await rcon.send(`team join ${TEAM_NAME} ${name}`);
  }
}

async function restoreNameTags(rcon) {
  try {
    await rcon.send(`team remove ${TEAM_NAME}`);
  } catch (err) {
    console.error(
      `Failed to remove team ${TEAM_NAME} during restore:`,
      err?.message || err,
    );
  }
}

module.exports = {
  hideNameTags,
  restoreNameTags,
  TEAM_NAME,
};
