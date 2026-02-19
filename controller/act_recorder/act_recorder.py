import argparse
import array
import fcntl
import json
import os
import socket
import time
import traceback
from datetime import datetime
from pathlib import Path
from queue import Empty, Queue
from threading import Thread

import cv2
import numpy as np

HOST = ""
PORT = 8089


def process_frame_worker(frame_queue, output_path, viewer_rendering_disabled, episode_id):
    action_data = []
    frames = []
    out = None
    first_render_time = None
    episode_start_epoch = None
    render_time_is_epoch = False

    while True:
        try:
            data = frame_queue.get(timeout=5)
            if data is None:
                break

            img, pos = data
            img_count = pos.get("frame_count", 0)

            now_epoch = time.time()
            render_time = float(pos.get("renderTime", 0.0))
            if first_render_time is None:
                first_render_time = render_time
                if render_time >= 1e12:  # treat as epoch milliseconds
                    render_time_is_epoch = True
                    episode_start_epoch = render_time / 1000.0
                else:
                    episode_start_epoch = now_epoch - (render_time / 1000.0)

            if render_time_is_epoch:
                epoch_time = render_time / 1000.0
                relative_ms = render_time - first_render_time
            else:
                relative_ms = render_time - first_render_time
                epoch_time = episode_start_epoch + (relative_ms / 1000.0)

            pos["relativeTimeMs"] = relative_ms
            pos["epochTime"] = epoch_time
            pos["episode_id"] = episode_id

            pos["x"] = round(pos["x"], 3)
            pos["y"] = round(pos["y"], 3)
            pos["z"] = round(pos["z"], 3)
            pos["yaw"] = round(pos["yaw"], 3)
            pos["pitch"] = round(pos["pitch"], 3)

            pos["extra_info"] = {
                "seed": 42,
            }
            action_data.append(pos)

            if viewer_rendering_disabled:
                continue
            # Store frames for later processing
            if img is None:
                print(f"Error: Received None image at frame {img_count}")
                continue
            if not isinstance(img, np.ndarray):
                print(f"Error: Invalid image type at frame {img_count}: {type(img)}")
                continue
            if img.size == 0:
                print(f"Error: Empty image at frame {img_count}")
                continue

            frames.append(img)

        except Empty:
            continue
        except Exception as e:
            print(
                f"Error processing frame {img_count if 'img_count' in locals() else 'unknown'}:"
            )
            print(f"  Error type: {type(e).__name__}")
            print(f"  Error message: {str(e)}")
            print(f"  Data type: {type(data) if 'data' in locals() else 'unknown'}")
            if "img" in locals():
                print(f"  Image type: {type(img)}")
                print(
                    f"  Image shape: {img.shape if hasattr(img, 'shape') else 'no shape'}"
                )
            continue

    # Calculate real FPS and cap at 20
    print("Total frames processed:", len(action_data))
    if len(action_data) > 1:
        real_fps = len(action_data) / (
            (action_data[-1]["renderTime"] - action_data[0]["renderTime"]) / 1000
        )
        video_fps = min(real_fps, 20)
    else:
        real_fps = 0
        video_fps = 20

    print("Real FPS:", real_fps)
    print("Video FPS (capped at 20):", video_fps)

    # Now create video writer with calculated FPS and write all frames
    if not viewer_rendering_disabled:
        out = cv2.VideoWriter(
            f"{output_path}.mp4",
            cv2.VideoWriter_fourcc(*"mp4v"),
            video_fps,
            (640, 360),
        )

        for frame in frames:
            out.write(frame)

        # clean up
        out.release()
        print("Video saved to ", f"{output_path}.mp4")
    with open(output_path + ".json", "w") as f:
        json.dump(action_data, f)
    print("Actions saved to ", f"{output_path}.json")

    if episode_start_epoch is None:
        episode_start_epoch = time.time()
        first_render_time = 0.0
        render_time_is_epoch = False

    metadata = {
        "episode_start_epoch": episode_start_epoch,
        "first_render_time_ms": first_render_time,
        "render_time_is_epoch": render_time_is_epoch,
        "frames": len(action_data),
        "video_fps": video_fps,
        "episode_id": episode_id,
    }
    with open(output_path + "_meta.json", "w") as meta_f:
        json.dump(metadata, meta_f)


def recvall(sock, count):
    buf = b""
    total_received = 0
    while count:
        try:
            newbuf = sock.recv(count)
            if not newbuf:
                return None
            received = len(newbuf)
            total_received += received
            buf += newbuf
            count -= received
        except socket.error as e:
            return None
    return buf


def recvint(sock):
    return int.from_bytes(recvall(sock, 4), byteorder="little")


def get_recv_buffer_used(sock):
    buf = array.array("i", [0])
    fcntl.ioctl(sock.fileno(), 0x541B, buf)  # FIONREAD
    return buf[0]


argparser = argparse.ArgumentParser(description="Act recorder script")
argparser.add_argument("--name", type=str, required=True, help="minecraft bot name")
argparser.add_argument(
    "--start_id",
    type=int,
    default=0,
    help="Starting number for incremental file naming",
)
argparser.add_argument("--port", type=int, default=8089, help="Port number")
argparser.add_argument(
    "--viewer_rendering_disabled",
    type=int,
    choices=[0, 1],
    default=0,
    help="Disable rendering in the viewer (0 = enabled, 1 = disabled)",
)

argparser.add_argument("--output_path", type=str, required=True, help="output path")
argparser.add_argument(
    "--instance_id",
    type=int,
    required=True,
    help="Instance ID for distinguishing parallel runs",
)

args = argparser.parse_args()
print("args.viewer_rendering_disabled", bool(args.viewer_rendering_disabled))
PORT = args.port


if not os.path.exists(args.output_path):
    os.makedirs(args.output_path)
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
print(f"Socket created at {PORT} for {args.name}")

s.bind((HOST, PORT))
print("Socket bind complete")
s.listen(10)
print("Socket now listening")

while True:
    try:
        conn, addr = s.accept()
    except socket.timeout:
        print("No connection received within 60 seconds, exiting...")
        s.close()
        exit(1)

    # conn.settimeout(10)
    conn.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024 * 1024)  # 1MB
    print("Socket connected")

    # On a fresh connection, read the first message as the episode header
    try:
        header_len = recvint(conn)
    except Exception:
        header_len = 0
    if header_len == 0:
        print("No header received (length=0). Closing connection.")
        conn.close()
        continue
    header_data = recvall(conn, header_len)
    if header_data is None:
        print("Error receiving episode header; closing connection")
        conn.close()
        continue
    try:
        header = json.loads(header_data.decode("utf-8"))
        episode_id = int(header.get("episode", 0))
    except Exception as e:
        print(f"Failed to parse episode header: {e}")
        conn.close()
        continue

    print(f"Episode ID: {episode_id}")
    # Now that we have the episode id, start the processing thread
    frame_queue = Queue()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = (
        f"{args.output_path}/{timestamp}_{episode_id:06d}_{args.name}_instance_{args.instance_id:03d}"
    )

    processor = Thread(
        target=process_frame_worker,
        args=(frame_queue, output_path, bool(args.viewer_rendering_disabled), episode_id),
    )
    processor.daemon = True
    processor.start()

    img_count = 0
    retcode = 0
    try:
        while True:
            t0 = time.time()
            try:
                pos_length = recvint(conn)
            except Exception as e:
                pos_length = 0
            if pos_length == 0:
                print(f"recv 0 length, normal end. episode_id: {episode_id}")
                retcode = 0
                break

            pos_data = recvall(conn, pos_length)
            if pos_data is None:
                print("Error receiving position data")
                retcode = 1
                break
            print("pos data: ", pos_data.decode("utf-8"))
            pos = json.loads(pos_data.decode("utf-8"))
            pos["frame_count"] = img_count
            pos["episode_id"] = episode_id
            if args.viewer_rendering_disabled:
                img = None
            else:
                length = recvint(conn)
                if length == 0:
                    print("ERROR! recv 0 image length")
                    retcode = 1
                    break

                stringData = recvall(conn, int(length))
                if stringData is None:
                    print("[Error] Received None instead of valid image data")
                    retcode = 1
                    break
                img = cv2.imdecode(
                    np.frombuffer(stringData, dtype=np.uint8), cv2.IMREAD_UNCHANGED
                )

            img_count += 1
            try:
                frame_queue.put((img, pos))
            except Queue.Full:
                print("Queue full, dropping frame")
            continue

    except socket.timeout:
        print("Socket timeout")
        retcode = 1
    except Exception as e:
        print(f"Error: {e}")
        traceback.print_exc()
        retcode = 1
    finally:
        frame_queue.put(None)
        processor.join()
        conn.close()
