#!/bin/bash

# Defaults
BASE_DATA_DIR="output"
NUM_PLAYERS=2
PLAYERS=(alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu)

# Parse CLI args
while [[ $# -gt 0 ]]; do
    case $1 in
        --output-dir)
            BASE_DATA_DIR="$2"
            shift 2
            ;;
        --num-players)
            NUM_PLAYERS="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo "  --output-dir DIR   Base data directory (default: output)"
            echo "  --num-players N    Players per instance (default: 2)"
            echo "  -h, --help         Show this help"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Use --help for usage"
            exit 1
            ;;
    esac
done

BASE_DATA_COLLECTION_DIR=$BASE_DATA_DIR/data_collection/eval
# Set time to "day" at beginning of all eval episodes
EVAL_TIME_SET_DAY=${EVAL_TIME_SET_DAY:-1}

# List of eval episode types to run
# structureNoPlaceEval is used for debugging, but not part of the eval dataset
EVAL_TYPES=("rotationEval" "translationEval" "structureEval" "turnToLookEval" "turnToLookOppositeEval" "bothLookAwayEval" "oneLooksAwayEval")

for BATCH_NAME in "${EVAL_TYPES[@]}"; do
    echo "=========================================="
    echo "Running eval: $BATCH_NAME"
    echo "=========================================="

    BATCH_DIR="$BASE_DATA_COLLECTION_DIR/$BATCH_NAME"

    # Set default config values
    NUM_FLATLAND_WORLD=2
    NUM_NORMAL_WORLD=0
    NUM_EPISODES=16

    # Override config for turnToLookEval and turnToLookOppositeEval: use 1 normal worldinstance with fixed seed
    if [ "$BATCH_NAME" == "turnToLookEval" ] || [ "$BATCH_NAME" == "turnToLookOppositeEval" ]; then
        NUM_FLATLAND_WORLD=0
        NUM_NORMAL_WORLD=1
        NUM_EPISODES=32
    fi

    COMPOSE_DIR=$BATCH_DIR/compose_configs

    CAMERA_OUTPUT_BASES=()
    CAMERA_DATA_BASES=()
    for ((p=0; p<NUM_PLAYERS; p++)); do
        CAMERA_OUTPUT_BASES+=("$BATCH_DIR/camera/output_${PLAYERS[p]}")
        CAMERA_DATA_BASES+=("$BATCH_DIR/camera/data_${PLAYERS[p]}")
    done

    python3 generate_compose.py \
        --compose_dir $COMPOSE_DIR \
        --base_port 25590 \
        --base_rcon_port 25600 \
        --act_recorder_port 8110 \
        --coord_port 8120 \
        --data_dir "$BATCH_DIR/data" \
        --output_dir "$BATCH_DIR/output" \
        --num_players $NUM_PLAYERS \
        --camera_output_bases "${CAMERA_OUTPUT_BASES[@]}" \
        --camera_data_bases "${CAMERA_DATA_BASES[@]}" \
        --smoke_test 0 \
        --num_flatland_world $NUM_FLATLAND_WORLD \
        --num_normal_world $NUM_NORMAL_WORLD \
        --num_episodes $NUM_EPISODES \
        --episode_types $BATCH_NAME \
        --viewer_rendering_disabled 1 \
        --gpu_mode egl \
        --eval_time_set_day $EVAL_TIME_SET_DAY #\
        #--flatland_world_disable_structures 1  # This is manually enabled for only structureEval to avoid confusing background structures 

    python3 orchestrate.py start --build --compose-dir "$COMPOSE_DIR" --logs-dir "$BATCH_DIR/logs" --num-players $NUM_PLAYERS
    python3 orchestrate.py status --compose-dir "$COMPOSE_DIR" --logs-dir "$BATCH_DIR/logs" --num-players $NUM_PLAYERS
    python3 orchestrate.py logs --compose-dir "$COMPOSE_DIR" --tail 20 --logs-dir "$BATCH_DIR/logs" --num-players $NUM_PLAYERS
    python3 orchestrate.py stop --compose-dir "$COMPOSE_DIR" --num-players $NUM_PLAYERS
    # Fix Docker root-owned file permissions so re-runs and postprocessing work
    docker run --rm -v "$(pwd)/$BATCH_DIR:/workspace" alpine chown -R "$(id -u):$(id -g)" /workspace
    python3 orchestrate.py postprocess --compose-dir "$COMPOSE_DIR" --workers 32 --output-dir "$BATCH_DIR/aligned" --num-players $NUM_PLAYERS

    echo ""
    echo "Completed eval: $BATCH_NAME"
    echo ""
done

echo "=========================================="
echo "All eval episodes completed!"
echo "=========================================="

python3 postprocess/prepare_eval_datasets.py --source-dir $BASE_DATA_COLLECTION_DIR --destination-dir $BASE_DATA_DIR/datasets/eval

# echo "Annotating some of the videos"
# python3 postprocess/annotate_video_batch.py $BASE_DATA_DIR/datasets/eval
