import net from "node:net";

// Next.js dev/start 和 next build 共用 .next。服務還在跑時覆寫 build 產物，
// 舊進程會繼續回傳舊 HTML，但對應 chunk 已被新 build 刪掉，造成 ChunkLoadError。
// 只信任目前這個 shell 的 PORT——如果 Agent Hub 是在「另一個」session 用不同 PORT 啟動的，
// 這裡偵測不到，屬於已知限制(專案內所有腳本/文件都預設單一 port，沒有把自訂 PORT 當正式支援的功能)。
const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : 3000;
if (rawPort && (!Number.isInteger(port) || port <= 0 || port >= 65536)) {
  console.warn(`⚠️ PORT 環境變數「${rawPort}」不是合法的連接埠，已忽略並改用 3000 檢查。`);
}
const checkPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000;

function portIsListening() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: checkPort });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const unavailable = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", unavailable);
    socket.once("timeout", unavailable);
  });
}

// 給知道自己在幹嘛的呼叫端(如 install-daemon.sh 已經自己停過常駐服務)跳過這道檢查的逃生口
if (!process.env.AGENT_HUB_SKIP_PORT_CHECK && (await portIsListening())) {
  console.error(
    `\n❌ 不能在 ${checkPort} 埠的 Agent Hub 還運行時直接 build。\n` +
    "   這會覆寫正在使用的 .next chunk，導致流程頁崩潰。\n" +
    "   請先停止 Agent Hub，build 完再重新啟動。\n",
  );
  process.exit(1);
}
