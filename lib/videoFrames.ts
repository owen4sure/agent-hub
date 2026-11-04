/**
 * 把螢幕錄影抽成幾張關鍵畫面（**在瀏覽器裡做，影片本身不會離開這台電腦**）。
 *
 * 為什麼需要這個功能(使用者原話)：「有時候可能有些步驟很難說清楚，可以用錄影的方式呈現，
 * 但是又怕他理解不了」。所以設計目標刻意不是「錄影自動變成流程」——那才是他擔心的東西。
 * 這裡只做一件事：讓錄影變成**對話裡的一個附件**，跟他已經在用的截圖、Excel 檔一樣，
 * AI 拿它當說明材料去理解意圖，最後仍然是畫出流程圖、由他按「套用到畫布」。
 * 理解錯的代價因此趨近於零——他看到圖不對，補一句話就好。
 *
 * **為什麼在瀏覽器端抽而不是傳到伺服器用 ffmpeg**：
 * ①一段 30 秒的螢幕錄影動輒 20-60MB，走既有的 base64 上傳管線會直接撞上限；
 *  抽完只剩幾張 JPEG，小到可以走既有的圖片路徑。
 * ②不需要 ffmpeg。這個專案是開源給別人自架的，多一個系統相依就多一個「在他機器上壞掉」的理由。
 * ③影片原檔根本不用離開瀏覽器——螢幕錄影裡什麼都可能錄到，能不落地就不落地。
 *
 * 只在瀏覽器端使用(用到 document/HTMLVideoElement)，不要從伺服器端模組匯入。
 */

export interface VideoFrame {
  /** base64(不含 data: 前綴)，JPEG */
  b64: string;
  /** 這一格在影片中的時間，例如 "0:07" */
  timeLabel: string;
  seconds: number;
}

export interface VideoFrameResult {
  frames: VideoFrame[];
  durationSec: number;
  /** 因為畫面幾乎沒變而被跳過的張數(讓畫面可以誠實說明「不是漏抽，是那段沒變化」) */
  skippedStill: number;
}

export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".webm"];

export function isVideoFile(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  const name = file.name.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 縮到 32x32 灰階當指紋，用來判斷「這一格跟上一格幾乎一樣」。 */
function fingerprint(canvas: HTMLCanvasElement): number[] {
  const small = document.createElement("canvas");
  small.width = 32;
  small.height = 32;
  const ctx = small.getContext("2d");
  if (!ctx) return [];
  ctx.drawImage(canvas, 0, 0, 32, 32);
  const { data } = ctx.getImageData(0, 0, 32, 32);
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    out.push((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000);
  }
  return out;
}

function nearlyIdentical(a: number[], b: number[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  // 平均每個像素差 3 階以內就算「畫面沒變」(游標移動、閃爍游標不算變化)
  return diff / a.length < 3;
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("影片跳轉失敗")); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, 4_000); // 卡住就跳過這一格，不要整批失敗
    function cleanup() {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    }
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = time;
  });
}

/**
 * 抽出最多 maxFrames 張畫面。
 * 平均取樣而不是偵測場景變化：螢幕錄影的「重要時刻」不見得伴隨大幅畫面變動
 * (例如只是在某一格輸入文字)，用平均取樣＋跳過完全沒變的畫面反而更穩。
 */
export async function extractVideoFrames(file: File, maxFrames = 8): Promise<VideoFrameResult> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("讀取影片超過 20 秒，可能是這個格式瀏覽器打不開")), 20_000);
      video.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(); }, { once: true });
      video.addEventListener("error", () => { clearTimeout(timer); reject(new Error("這個影片格式瀏覽器打不開")); }, { once: true });
    });

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration <= 0) throw new Error("讀不到影片長度");

    const canvas = document.createElement("canvas");
    canvas.width = Math.min(video.videoWidth || 1280, 1280);
    canvas.height = Math.round((canvas.width / (video.videoWidth || 1280)) * (video.videoHeight || 720));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("瀏覽器無法建立畫布");

    const count = Math.max(2, Math.min(maxFrames, Math.ceil(duration / 3)));
    const frames: VideoFrame[] = [];
    let lastPrint: number[] = [];
    let skippedStill = 0;

    for (let i = 0; i < count; i++) {
      // 兩端各留一點：影片最開頭常是還沒開始動作的畫面，最後一格 seek 到結尾容易抓到黑畫面
      const t = duration * ((i + 0.5) / count);
      await seek(video, t);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const print = fingerprint(canvas);
      if (nearlyIdentical(print, lastPrint)) { skippedStill++; continue; }
      lastPrint = print;
      const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
      frames.push({ b64: dataUrl.split(",")[1] ?? "", timeLabel: formatTime(t), seconds: t });
    }

    return { frames: frames.filter((f) => f.b64.length > 0), durationSec: duration, skippedStill };
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }
}
