set -e

# Defaults
BASE_DATA_DIR="output"
NUM_BATCHES=2
NUM_FLAT_WORLD=1
NUM_NORMAL_WORLD=1
NUM_EPISODES=2
DATASET_NAME="duet"
FILTER_WATER_EPISODES=true
# Disable Advancements tracking and popups via spigot.yml
DISABLE_ADVANCEMENTS=true

# Parse CLI args
while [[ $# -gt 0 ]]; do
  case $1 in
    --output-dir)
      BASE_DATA_DIR="$2"
      shift 2
      ;;
    --num-batches)
      NUM_BATCHES="$2"
      shift 2
      ;;
    --num-flat-world)
      NUM_FLAT_WORLD="$2"
      shift 2
      ;;
    --num-normal-world)
      NUM_NORMAL_WORLD="$2"
      shift 2
      ;;
    --num-episodes)
      NUM_EPISODES="$2"
      shift 2
      ;;
    --dataset-name)
      DATASET_NAME="$2"
      shift 2
      ;;
    --filter-water-episodes)
      FILTER_WATER_EPISODES="$2"
      shift 2
      ;;
    --disable-advancements)
      DISABLE_ADVANCEMENTS="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [OPTIONS]"
      echo "  --output-dir DIR       Base data directory (default: output)"
      echo "  --num-batches N        Number of batches (default: 2)"
      echo "  --num-flat-world N     Number of flat worlds per batch (default: 1)"
      echo "  --num-normal-world N   Number of normal worlds per batch (default: 1)"
      echo "  --num-episodes N       Number of episodes (default: 2)"
      echo "  --dataset-name NAME    Dataset name (default: duet)"
      echo "  --filter-water-episodes true|false  Filter water episodes (default: true)"
      echo "  --disable-advancements true|false   Disable advancement pop-ups (default: true)"
      echo "  -h, --help             Show this help"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Use --help for usage"
      exit 1
      ;;
  esac
done

TOTAL_INSTANCES=$((NUM_FLAT_WORLD + NUM_NORMAL_WORLD))
if [[ $TOTAL_INSTANCES -gt 4 ]]; then
  echo "Error: total instances ($TOTAL_INSTANCES) exceeds the NVENC limit of 8 simultaneous encoding sessions per GPU." >&2
  echo "  NUM_FLAT_WORLD=$NUM_FLAT_WORLD + NUM_NORMAL_WORLD=$NUM_NORMAL_WORLD = $TOTAL_INSTANCES" >&2
  echo "  Please reduce the number of total instances to 4 or fewer." >&2
  exit 1
fi

BASE_DATA_COLLECTION_DIR=$BASE_DATA_DIR/data_collection/train
for ((i=0; i<NUM_BATCHES; i++)); do
    BATCH_NAME="batch_$i"
    BATCH_DIR="$BASE_DATA_COLLECTION_DIR/$BATCH_NAME"
    COMPOSE_DIR="$BATCH_DIR/compose_configs"

    python3 generate_compose.py \
        --compose_dir "$COMPOSE_DIR" \
        --base_port 25590 \
        --base_rcon_port 25600 \
        --act_recorder_port 8110 \
        --coord_port 8120 \
        --data_dir "$BATCH_DIR/data" \
        --output_dir "$BATCH_DIR/output" \
        --camera_output_alpha_base "$BATCH_DIR/camera/output_alpha" \
        --camera_output_bravo_base "$BATCH_DIR/camera/output_bravo" \
        --camera_data_alpha_base "$BATCH_DIR/camera/data_alpha" \
        --camera_data_bravo_base "$BATCH_DIR/camera/data_bravo" \
        --smoke_test 0 \
        --num_flatland_world $NUM_FLAT_WORLD \
        --num_normal_world $NUM_NORMAL_WORLD \
        --num_episodes $NUM_EPISODES \
        --eval_time_set_day 0 \
        --viewer_rendering_disabled 1 \
        --gpu_mode egl \
        --disable_advancements "$DISABLE_ADVANCEMENTS"

    python3 orchestrate.py start --build --compose-dir "$COMPOSE_DIR" --logs-dir "$BATCH_DIR/logs"
    python3 orchestrate.py status --compose-dir "$COMPOSE_DIR" --logs-dir "$BATCH_DIR/logs"
    python3 orchestrate.py logs --compose-dir "$COMPOSE_DIR" --tail 20 --logs-dir "$BATCH_DIR/logs"
    python3 orchestrate.py stop --compose-dir "$COMPOSE_DIR"
    # Fix Docker root-owned file permissions so re-runs and postprocessing work
    docker run --rm -v "$(pwd)/$BATCH_DIR:/workspace" alpine chown -R "$(id -u):$(id -g)" /workspace
    python3 orchestrate.py postprocess --compose-dir "$COMPOSE_DIR" --workers 32 --output-dir "$BATCH_DIR/aligned"
done

if [[ "$FILTER_WATER_EPISODES" == "true" ]]; then
  echo "Detecting water episodes"
  python3 postprocess/detect_water_episodes_batch.py --base-path $BASE_DATA_COLLECTION_DIR --num-workers 8 --out-path $BASE_DATA_COLLECTION_DIR/water_episodes.json
fi

echo "Preparing train dataset"
python3 postprocess/prepare_train_dataset.py --source-dir $BASE_DATA_COLLECTION_DIR --destination-dir $BASE_DATA_DIR/datasets/$DATASET_NAME

if [[ "$FILTER_WATER_EPISODES" == "true" ]]; then
  echo "Filtering train dataset"
  python3 postprocess/filter_dataset.py --episodes-json $BASE_DATA_COLLECTION_DIR/water_episodes.json $BASE_DATA_DIR/datasets/$DATASET_NAME
fi

echo "Splitting train dataset"
python3 postprocess/split_train_test.py $BASE_DATA_DIR/datasets/$DATASET_NAME 

echo "Annotating some of the test split videos"
python3 postprocess/annotate_video_batch.py $BASE_DATA_DIR/datasets/$DATASET_NAME
