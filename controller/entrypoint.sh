#!/usr/bin/env bash
set -euo pipefail

DISPLAY=${DISPLAY:-:99}
export DISPLAY
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp}

rm -f "/tmp/.X${DISPLAY##*:}-lock" 2>/dev/null || true

echo "[entrypoint] Starting Xvfb on ${DISPLAY} ..."
Xvfb "${DISPLAY}" -screen 0 1280x720x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!

cleanup() {
  echo "[entrypoint] Stopping Xvfb (${XVFB_PID})"
  kill "${XVFB_PID}" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for the display to come up
for i in {1..100}; do
  if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
    echo "[entrypoint] Xvfb is up"
    break
  fi
  sleep 0.1
done

echo "[entrypoint] GLX sanity check:"
glxinfo -B || true  # don't hard-fail; just print if available

echo "[entrypoint] Launching app..."
echo "[entrypoint] Bot config: ${BOT_NAME:-Alpha} <-> ${OTHER_BOT_NAME:-Bravo}, Ports: ${COORD_PORT:-8093}/${OTHER_COORD_PORT:-8094}, Instance: ${INSTANCE_ID:-0}"
exec node controller/main.js \
  --bot_name "${BOT_NAME:-Alpha}" \
  --other_bot_name "${OTHER_BOT_NAME:-Bravo}" \
  --act_recorder_host "${ACT_RECORDER_HOST:-127.0.0.1}" \
  --act_recorder_port "${ACT_RECORDER_PORT:-8091}" \
  --coord_port "${COORD_PORT:-8093}" \
  --other_coord_host "${OTHER_COORD_HOST:-127.0.0.1}" \
  --other_coord_port "${OTHER_COORD_PORT:-8094}" \
  --bot_rng_seed "${BOT_RNG_SEED:-}" \
  --episodes_num "${EPISODES_NUM:-1}" \
  --start_episode_id "${EPISODE_START_ID:-0}" \
  --host "${MC_HOST:-127.0.0.1}" \
  --port "${MC_PORT:-25565}" \
  --rcon_host "${RCON_HOST:-127.0.0.1}" \
  --rcon_port "${RCON_PORT:-25575}" \
  --rcon_password "${RCON_PASSWORD:-research}" \
  --bootstrap_wait_time "${BOOTSTRAP_WAIT_TIME:-0}" \
  --enable_camera_wait "${ENABLE_CAMERA_WAIT:-1}" \
  --camera_ready_retries "${CAMERA_READY_RETRIES:-30}" \
  --camera_ready_check_interval "${CAMERA_READY_CHECK_INTERVAL:-2000}" \
  --walk_timeout "${WALK_TIMEOUT:-5}" \
  --teleport "${TELEPORT:-0}" \
  --teleport_radius "${TELEPORT_RADIUS:-5}" \
  --mc_version "${MC_VERSION:-1.21}" \
  --viewer_rendering_disabled "${VIEWER_RENDERING_DISABLED:-0}" \
  --viewer_recording_interval "${VIEWER_RECORDING_INTERVAL:-50}" \
  --smoke_test "${SMOKE_TEST:-0}" \
  --world_type "${WORLD_TYPE:-flat}" \
  --instance_id "${INSTANCE_ID:-0}" \
  --output_dir "${OUTPUT_DIR:-/output}" \
  --eval_time_set_day "${EVAL_TIME_SET_DAY:-0}"
