import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 這台機器的上層也有 package-lock，明確鎖定本 repo；直接用 __dirname 避免動態 path.join
  // 讓 Turbopack 的檔案追蹤誤以為整個專案都可能被執行期讀取。
  turbopack: { root: __dirname },
  // proxy.ts 會讓 Next.js 緩衝 request body，預設只留 10MB。對話附件用 base64 JSON 傳輸，
  // 20MB 原始檔會膨脹到約 26.7MB；30MB 足以容納檔案與 JSON 開銷。
  experimental: {
    proxyClientMaxBodySize: "30mb",
  },
  async headers() {
    const securityHeaders = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      // Webhook／表單／簽核 token 都在 URL；離開頁面時絕不能透過 Referer 洩漏完整網址。
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
    ];
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
