# Defaults
BASE_DATA_DIR="output2"
NUM_BATCHES=2
NUM_FLAT_WORLD=1
NUM_NORMAL_WORLD=1
NUM_EPISODES=2
DATASET_NAME="duet"

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
    -h|--help)
      echo "Usage: $0 [OPTIONS]"
      echo "  --output-dir DIR       Base data directory (default: output2)"
      echo "  --num-batches N        Number of batches (default: 2)"
      echo "  --num-flat-world N     Number of flat worlds per batch (default: 1)"
      echo "  --num-normal-world N   Number of normal worlds per batch (default: 1)"
      echo "  --num-episodes N       Number of episodes (default: 2)"
      echo "  --dataset-name NAME    Dataset name (default: duet)"
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
        --gpu_mode egl

    python3 orchestrate.py start --build --compose-dir "$COMPOSE_DIR" --logs-dir "$BATCH_DIR/logs"
    python3 orchestrate.py status --compose-dir "$COMPOSE_DIR" --logs-dir "$BATCH_DIR/logs"
    python3 orchestrate.py logs --compose-dir "$COMPOSE_DIR" --tail 20 --logs-dir "$BATCH_DIR/logs"
    python3 orchestrate.py stop --compose-dir "$COMPOSE_DIR"
    python3 orchestrate.py postprocess --compose-dir "$COMPOSE_DIR" --workers 32 --comparison-video --output-dir "$BATCH_DIR/aligned"
done

echo "Preparing train dataset"
python3 postprocess/prepare_train_dataset.py --source-dir $BASE_DATA_COLLECTION_DIR --destination-dir $BASE_DATA_DIR/datasets/$DATASET_NAME

echo "Splitting train dataset"
python3 postprocess/split_train_test.py $BASE_DATA_DIR/datasets/$DATASET_NAME 

echo "Annotating some of the test split videos"
python3 postprocess/annotate_video_batch.py $BASE_DATA_DIR/datasets/$DATASET_NAME
