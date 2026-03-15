#!/bin/bash

# Configuration
PORT=8000
DFF_FILE="Files/HomeMenuFIFO_Frame1.dff"
TARGET_DIR="WebGLViewer/data"
JSON_OUT="$TARGET_DIR/HomeMenuFIFO_Frame1.json"
MEM_OUT="$TARGET_DIR/HomeMenuFIFO_Frame1.mem"

# CD to the root of the project
cd "$(dirname "$0")"

echo "[1] Stopping any existing servers on port $PORT..."
# Kill any process listening on the port to ensure we don't serve stale instances
lsof -ti tcp:$PORT | xargs kill -9 2>/dev/null

echo "[2] Re-extracting DFF to JSON and MEM using dolphin-tool..."
# Ensure the data directory exists
mkdir -p "$TARGET_DIR"

# Run our newly modified dolphin-tool to dump both files
./build/Binaries/dolphin-tool fifo --in "$DFF_FILE" --out "$JSON_OUT"

if [ $? -ne 0 ] || [ ! -f "$JSON_OUT" ]; then
    echo "Error: Failed to generate JSON. Did dolphin-tool compile correctly?"
    exit 1
fi

echo "[3] Starting Web Server..."
cd WebGLViewer
# Use python's built in http server
python3 -m http.server $PORT &
SERVER_PID=$!

echo "[4] Opening Browser..."
sleep 1
open "http://localhost:$PORT/"

echo "--------------------------------------------------------"
echo "Viewer is live at http://localhost:$PORT"
echo "Dolphin-tool successfully extracted fresh data."
echo "Press [CTRL+C] to stop the server."
echo "--------------------------------------------------------"

# Ensure the python server is killed when this script exits
trap "echo -e '\nStopping server...'; kill -9 $SERVER_PID 2>/dev/null" EXIT
wait $SERVER_PID
