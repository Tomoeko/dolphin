#!/bin/bash
# High-performance bulk dump of intermediate draw call states from Dolphin
# Optimized O(N) single-pass capture.

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 <fifo_log.dff>"
    exit 1
fi

FIFO_LOG=$1
OUTPUT_DIR="WebGLViewer/data/draw_calls"

# Robust path detection for dolphin-tool
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DOLPHIN_TOOL="$PROJECT_ROOT/build/Binaries/dolphin-tool"

if [ ! -f "$DOLPHIN_TOOL" ]; then
    DOLPHIN_TOOL="./build/Binaries/dolphin-tool"
fi

if [ ! -f "$DOLPHIN_TOOL" ]; then
    echo "Error: dolphin-tool not found. Please build it first."
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "Starting high-speed single-pass bulk capture from $FIFO_LOG..."
# Run one single pass to capture ALL draw calls
"$DOLPHIN_TOOL" fifo screenshot -i "$FIFO_LOG" -b Software --bulk-dir "$OUTPUT_DIR"

echo -e "\nDone! Snapshots saved to $OUTPUT_DIR"
