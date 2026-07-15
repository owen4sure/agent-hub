import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithUrlGuard, isPrivateHost } from "./urlGuard";

test("SSRF 防護:本機與非 HTTP 協定在發出請求前就擋下", async () => {
  await assert.rejects(() => fetchWithUrlGuard("http://127.0.0.1:9/secret"), /內部網路/);
  await assert.rejects(() => fetchWithUrlGuard("file:///etc/passwd"), /只允許 http\/https/);
});

test("SSRF 防護:額外的保留／文件／multicast 網段與 IPv6 mapped 私網也要擋", async () => {
  for (const host of ["192.0.0.8", "198.18.0.1", "198.51.100.9", "203.0.113.7", "224.0.0.1", "255.255.255.255", "[::ffff:c0a8:101]", "[2001:db8::1]"]) {
    assert.equal(await isPrivateHost(host), true, host);
  }
});
