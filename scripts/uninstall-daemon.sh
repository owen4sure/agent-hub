#!/bin/bash
set -euo pipefail

PLIST_DEST="$HOME/Library/LaunchAgents/com.agenthub.engine.plist"

if [ -f "$PLIST_DEST" ]; then
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  rm "$PLIST_DEST"
  echo "✅ 已移除常駐服務"
else
  echo "目前沒有安裝常駐服務"
fi
