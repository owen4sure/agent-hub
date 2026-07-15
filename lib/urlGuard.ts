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
  let v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  // URL/Node 可能把 ::ffff:192.168.1.1 正規化成 ::ffff:c0a8:101；先還原成 IPv4 再套同一份規則。
  if (ip.toLowerCase().startsWith("::ffff:") && !net.isIPv4(v4)) {
    const groups = v4.split(":");
    if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) {
      const high = Number.parseInt(groups[0], 16);
      const low = Number.parseInt(groups[1], 16);
      v4 = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
  }
  if (net.isIPv4(v4)) {
    const [a, b, c] = v4.split(".").map(Number);
    return (
      a === 0 || // 0.0.0.0/8
      a === 10 || // 10/8
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT(含部分雲內部服務)
      (a === 169 && b === 254) || // link-local(雲端 metadata 169.254.169.254 就在這段)
      (a === 172 && b >= 16 && b <= 31) || // 172.16/12
      (a === 192 && b === 168) || // 192.168/16
      (a === 192 && b === 0) || // 192.0.0/24 IETF protocol assignments + TEST-NET-1
      (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast（已廢止）
      (a === 198 && (b === 18 || b === 19)) || // benchmark networks
      (a === 198 && b === 51 && c === 100) || // TEST-NET-2
      (a === 203 && b === 0 && c === 113) || // TEST-NET-3
      a >= 224 // multicast + reserved + limited broadcast
    );
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    return (
      low === "::" ||
      low === "::1" || // loopback
      low.startsWith("fc") || low.startsWith("fd") || // fc00::/7 ULA
      low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb") || // fe80::/10 link-local
      low.startsWith("ff") || // multicast
      low.startsWith("2001:db8:") || // 文件用網段，不該成為服務目的地
      low.startsWith("2001:0:") || // Teredo transition（可封裝 IPv4）
      low.startsWith("2002:") // 6to4 transition（可封裝 IPv4）
    );
  }
  // 不是合法 IP 字面值(這函式只該收 IP)——保守當內部擋掉
  return true;
}

// 只快取「要擋」的結果，不快取公開 IP。安全結果即使只快取 60 秒，DNS rebinding 仍可在這 60 秒內
// 把同一網域改指到 127.0.0.1/metadata；擋截結果短暫留著最多只是安全的 false positive。
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
  if (result) lookupCache.set(host, { result, at: Date.now() });
  else lookupCache.delete(host);
  if (lookupCache.size > 500) lookupCache.clear(); // 粗略防無限長大
  return result;
}

/**
 * Node fetch 的 redirect:"follow" 會在背後直接跟 30x，呼叫方沒機會檢查下一跳是否進入內網。
 * 這個共用函式強制每一跳都重新驗主機，節點不得自己寫「只驗第一跳」的半套版本。
 */
export async function fetchWithUrlGuard(rawUrl: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let current: URL;
  try { current = new URL(rawUrl); } catch { throw new Error(`網址格式不正確：${rawUrl}`); }
  let requestInit = { ...init, redirect: "manual" as const };
  for (let hop = 0; ; hop++) {
    if (!/^https?:$/.test(current.protocol)) throw new Error(`只允許 http/https 網址：${current.href}`);
    if (!privateUrlsAllowed() && (await isPrivateHost(current.hostname))) {
      throw new Error(`不允許連線內部網路位址(${current.hostname})`);
    }
    const response = await fetch(current.href, requestInit);
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (hop >= maxRedirects) throw new Error(`轉址次數超過 ${maxRedirects} 次`);
    const next = new URL(location, current);
    await response.body?.cancel().catch(() => {});
    // 原生 fetch 在跨站轉址時不會把帳密標頭送到新站；手動跟轉址也必須維持同樣保護。
    // 否則使用者打有 Authorization 的 API，只要對方回 302 就能把憑證導去第三方網站。
    if (next.origin !== current.origin) {
      const headers = new Headers(requestInit.headers);
      for (const key of ["authorization", "proxy-authorization", "cookie", "host"]) headers.delete(key);
      requestInit = { ...requestInit, headers };
    }
    current = next;
    // 跟瀏覽器/fetch 語意一致：303，以及 POST 的 301/302，下一跳改成 GET。
    const method = String(requestInit.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      const headers = new Headers(requestInit.headers);
      headers.delete("content-length");
      headers.delete("content-type");
      requestInit = { ...requestInit, method: "GET", body: undefined, headers };
    }
  }
}
