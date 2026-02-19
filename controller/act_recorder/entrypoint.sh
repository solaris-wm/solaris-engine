#!/usr/bin/env bash
set -euo pipefail
exec python3 controller/act_recorder/act_recorder.py --port $PORT --name $NAME --output_path /output --instance_id $INSTANCE_ID --start_id $EPISODE_START_ID --viewer_rendering_disabled $VIEWER_RENDERING_DISABLED