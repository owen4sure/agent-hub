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

cd "$WORKDIR"

# 先停掉可能已經在跑的舊常駐服務，再 build——build 會覆寫 .next，舊進程還在跑的話
# 會出現「頁面用的 chunk 被砍掉」的 ChunkLoadError(npm run build 的 prebuild 檢查也會擋下來)。
# 這步讓「重跑這支腳本升級已安裝的常駐服務」可以直接動，不用使用者自己手動停。
if [ -f "$PLIST_DEST" ]; then
  echo "▶ 偵測到已安裝的常駐服務，先停掉再重新建置…"
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  for _ in $(seq 1 10); do
    lsof -i :3000 -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

echo "▶ 建置正式版 (npm run build)…"
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
