import { describe, it, expect } from "vitest";
import { timingSafeEqual, checkToken, checkMcpJwt } from "../src/lib/auth";
import type { Env } from "../src/env";

describe("timingSafeEqual", () => {
  it("同一文字列で true", async () => {
    expect(await timingSafeEqual("abc123", "abc123")).toBe(true);
  });
  it("1 文字違いで false", async () => {
    expect(await timingSafeEqual("abc123", "abc124")).toBe(false);
  });
  it("長さが違っても false (長さをリークしない)", async () => {
    expect(await timingSafeEqual("abc", "abcdef")).toBe(false);
  });
  it("空文字同士は true", async () => {
    expect(await timingSafeEqual("", "")).toBe(true);
  });
});

describe("checkToken", () => {
  const env = { RELAY_TOKEN: "secret" } as Env;

  it("?token= 一致で ok", async () => {
    expect(await checkToken(new Request("https://x/ext/s?token=secret"), env)).toBe("ok");
  });
  it("Authorization: Bearer 一致で ok", async () => {
    const req = new Request("https://x/mcp", { headers: { Authorization: "Bearer secret" } });
    expect(await checkToken(req, env)).toBe("ok");
  });
  it("query が header より優先される", async () => {
    const req = new Request("https://x/ext/s?token=secret", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(await checkToken(req, env)).toBe("ok");
  });
  it("不一致で bad_token", async () => {
    expect(await checkToken(new Request("https://x/ext/s?token=wrong"), env)).toBe("bad_token");
  });
  it("提示なしで missing_token", async () => {
    expect(await checkToken(new Request("https://x/ext/s"), env)).toBe("missing_token");
  });
  it("RELAY_TOKEN 未設定なら not_configured (fail-closed)", async () => {
    expect(await checkToken(new Request("https://x/ext/s?token=secret"), {} as Env)).toBe("not_configured");
  });
});

describe("checkMcpJwt (/mcp の MCP-JWT 認証)", () => {
  const SECRET = "test-mcp-jwt-secret"; // vitest.config.ts の MCP_JWT_SECRET と一致
  const env = { MCP_JWT_SECRET: SECRET, MCP_JWT_AUDIENCE: "*" } as Env;

  function b64url(bytes: Uint8Array): string {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  }
  async function mintJwt(secret: string, claims: Record<string, unknown>): Promise<string> {
    const enc = new TextEncoder();
    const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const payload = b64url(enc.encode(JSON.stringify(claims)));
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${payload}`)));
    return `${header}.${payload}.${b64url(sig)}`;
  }
  function bearer(jwt: string): Request {
    return new Request("https://x/mcp", { method: "POST", headers: { Authorization: `Bearer ${jwt}` } });
  }
  const validClaims = (): Record<string, unknown> => ({
    sub: "u1",
    github_login: "alice",
    scope: "mcp.read mcp.write",
    aud: "github-mcp-server-rs",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  it("正しく署名された MCP-JWT は ok (aud は * で不問)", async () => {
    expect(await checkMcpJwt(bearer(await mintJwt(SECRET, validClaims())), env)).toBe("ok");
  });
  it("署名鍵が違うと bad_token", async () => {
    expect(await checkMcpJwt(bearer(await mintJwt("wrong-secret", validClaims())), env)).toBe("bad_token");
  });
  it("期限切れは bad_token", async () => {
    const jwt = await mintJwt(SECRET, { ...validClaims(), exp: Math.floor(Date.now() / 1000) - 100 });
    expect(await checkMcpJwt(bearer(jwt), env)).toBe("bad_token");
  });
  it("github_login 欠落は bad_token", async () => {
    const c = validClaims();
    delete c.github_login;
    expect(await checkMcpJwt(bearer(await mintJwt(SECRET, c)), env)).toBe("bad_token");
  });
  it("Bearer 無しは missing_bearer", async () => {
    expect(await checkMcpJwt(new Request("https://x/mcp", { method: "POST" }), env)).toBe("missing_bearer");
  });
  it("MCP_JWT_SECRET 未設定は not_configured (fail-closed)", async () => {
    expect(await checkMcpJwt(bearer(await mintJwt(SECRET, validClaims())), {} as Env)).toBe("not_configured");
  });
});
