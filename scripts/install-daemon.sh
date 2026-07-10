#!/bin/bash
# 讓 Agent Hub 隨開機常駐(用 launchd)，這樣排程才會準時觸發，不用手動 npm run dev。
set -euo pipefail

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
NEXT_BIN="$WORKDIR/node_modules/.bin/next"
PLIST_LABEL="com.agenthub.engine"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

if [ ! -x "$NEXT_BIN" ]; then
  echo "❌ 找不到 $NEXT_BIN，請先在 $WORKDIR 執行過 npm install"
  exit 1
fi

echo "▶ 建置正式版 (npm run build)…"
cd "$WORKDIR"
npm run build

echo "▶ 確認 Playwright 瀏覽器已安裝(第一次跑會下載，之後很快)…"
npx playwright install chromium

if lsof -i :3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "❌ port 3000 已經被別的程式佔用，常駐服務跑不起來會一直重試、看起來像是「打不開」。"
  echo "   請先關掉佔用 3000 的程式(可用「lsof -i :3000」查是誰)，再重跑這個安裝腳本。"
  exit 1
fi

echo "▶ 產生 launchd 設定檔…"
sed \
  -e "s#__NODE_BIN__#$NODE_BIN#g" \
  -e "s#__NEXT_BIN__#$NEXT_BIN#g" \
  -e "s#__WORKDIR__#$WORKDIR#g" \
  -e "s#__NODE_DIR__#$NODE_DIR#g" \
  "$WORKDIR/scripts/com.agenthub.engine.plist.template" > "$PLIST_DEST"

echo "▶ 載入常駐服務…"
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo "✅ 完成！Agent Hub 已常駐，開機會自動啟動：http://localhost:3000"
echo "   log 在 $WORKDIR/data/engine.log"
echo "   若要移除常駐，執行 scripts/uninstall-daemon.sh"
