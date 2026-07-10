import dns from "node:dns/promises";
import net from "node:net";

/**
 * SSRF 防護：判斷一個主機名/IP 是不是「內部位址」(loopback/私有網段/link-local/雲端 metadata)。
 *
 * 為什麼需要：fetch-url 這類「AI 幫你打開網址」的功能，若部署在雲端 VM 上被貼進
 * http://169.254.169.254/...(AWS/GCP/Azure 的 metadata 端點)，chromium 會把該 VM 的
 * 雲端臨時憑證整頁抓回來連截圖一起回傳——完整讀取型 SSRF。內網管理介面(192.168.x.x)同理。
 *
 * 自家內網有合法需求的使用者可設環境變數 AGENT_HUB_ALLOW_PRIVATE_URLS=1 整個關閉此防護。
 */
export function privateUrlsAllowed(): boolean {
  return process.env.AGENT_HUB_ALLOW_PRIVATE_URLS === "1";
}

function isPrivateIp(ip: string): boolean {
  // IPv4-mapped IPv6(::ffff:10.0.0.1)先剝殼再照 IPv4 判斷
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split(".").map(Number);
    return (
      a === 0 || // 0.0.0.0/8
      a === 10 || // 10/8
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT(含部分雲內部服務)
      (a === 169 && b === 254) || // link-local(雲端 metadata 169.254.169.254 就在這段)
      (a === 172 && b >= 16 && b <= 31) || // 172.16/12
      (a === 192 && b === 168) // 192.168/16
    );
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    return (
      low === "::" ||
      low === "::1" || // loopback
      low.startsWith("fc") || low.startsWith("fd") || // fc00::/7 ULA
      low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb") // fe80::/10 link-local
    );
  }
  // 不是合法 IP 字面值(這函式只該收 IP)——保守當內部擋掉
  return true;
}

// TTL(不是永久快取)：DNS-rebinding 攻擊的手法正是「第一次解析到公開 IP 通過檢查，
// 之後把同一個網域改指到內部位址」——快取若沒有過期時間，第一次查到的「安全」判定會被
// 永遠信任，之後 DNS 換了也不會重查，SSRF 防護形同虛設(踩過的安全漏洞)。60 秒短 TTL：
// 一般網頁請求的時間跨度內仍有省查詢的效果，但攻擊者改 DNS 後最多 60 秒就會被重新驗證到。
const DNS_CACHE_TTL_MS = 60_000;
const lookupCache = new Map<string, { result: boolean; at: number }>();

/** 主機名是否解析到內部位址。解析失敗保守回 true(擋掉)——打不開的東西擋了也無妨。 */
export async function isPrivateHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase(); // URL 裡的 IPv6 帶方括號
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  const cached = lookupCache.get(host);
  if (cached !== undefined && Date.now() - cached.at < DNS_CACHE_TTL_MS) return cached.result;
  let result: boolean;
  try {
    const addrs = await dns.lookup(host, { all: true });
    // 任何一個解析結果落在內部網段就整個擋(攻擊者可以在 DNS 回應裡混一筆內部 IP)
    result = addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address));
  } catch {
    result = true;
  }
  lookupCache.set(host, { result, at: Date.now() });
  if (lookupCache.size > 500) lookupCache.clear(); // 粗略防無限長大
  return result;
}
