#!/usr/bin/env bash
# MemOS ↔ gbrain Bridge — 每日同步包装脚本
set -euo pipefail

export PATH="$HOME/.bun/bin:$PATH"
export GBRAIN_HOME="$HOME/gbrain"
export MEMOS_HOME="$HOME/.hermes/memos-plugin"

LOG_FILE="$MEMOS_HOME/logs/bridge-sync.log"
mkdir -p "$(dirname "$LOG_FILE")"

exec >> "$LOG_FILE" 2>&1

echo "[$(date -Iseconds)] Bridge sync started"

if ! python3 "$MEMOS_HOME/scripts/memos-to-gbrain-bridge.py" >> "$LOG_FILE" 2>&1; then
    echo "[$(date -Iseconds)] Bridge sync FAILED"
    exit 1
fi

echo "[$(date -Iseconds)] Bridge sync completed"
