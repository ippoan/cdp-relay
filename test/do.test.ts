import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

const BASE = "https://cdp-relay.test";
const TOKEN = "test-token"; // vitest.config.ts の RELAY_TOKEN と一致

describe("edge routing / auth gate", () => {
  it("GET / は説明ページ (HTML)", async () => {
    const res = await SELF.fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("GET /health は { ok: true }", async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("未知パスは 404", async () => {
    expect((await SELF.fetch(`${BASE}/nope`)).status).toBe(404);
  });

  it("/ext は token 無しで 401", async () => {
    const res = await SELF.fetch(`${BASE}/ext/s1`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(401);
  });

  it("/ext は token 不正で 401", async () => {
    const res = await SELF.fetch(`${BASE}/ext/s1?token=wrong`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(401);
  });

  it("/ext は Upgrade ヘッダ無しで 426", async () => {
    const res = await SELF.fetch(`${BASE}/ext/s1?token=${TOKEN}`);
    expect(res.status).toBe(426);
  });

  it("/ext は token 正 + Upgrade ありで 101", async () => {
    const res = await SELF.fetch(`${BASE}/ext/s1?token=${TOKEN}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it("/mcp は token 無しで 401 + RFC 9728 challenge (auth-staging/cdp-relay を指す)", async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    const wa = res.headers.get("WWW-Authenticate") ?? "";
    expect(wa).toContain("resource_metadata=");
    expect(wa).toContain("auth-staging.ippoan.org/.well-known/oauth-protected-resource/cdp-relay");
  });
});

describe("screenshot 一時保存 / 配信 (/shot)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("PUT /shot で保存 → shot_url GET で同じ PNG が返る", async () => {
    const session = "shot-" + crypto.randomUUID();
    const put = await SELF.fetch(`${BASE}/shot/${session}?token=${TOKEN}`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: PNG,
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { shot_url: string; id: string; size_bytes: number };
    expect(body.size_bytes).toBe(PNG.length);
    // RELAY_ORIGIN (test binding = https://cdp-relay.test) を origin にする。
    expect(body.shot_url).toBe(`https://cdp-relay.test/shot/${session}/${body.id}`);

    const got = await SELF.fetch(body.shot_url);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    // defense-in-depth: 常に download 扱い + CSP で active 配信を封じる。
    expect(got.headers.get("content-disposition")).toBe("attachment");
    expect(got.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
  });

  it("PUT /shot は token 必須 (401)", async () => {
    const res = await SELF.fetch(`${BASE}/shot/s2`, { method: "PUT", body: PNG });
    expect(res.status).toBe(401);
  });

  it("空 body の PUT は 400", async () => {
    const res = await SELF.fetch(`${BASE}/shot/s3?token=${TOKEN}`, {
      method: "PUT",
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);
  });

  it("存在しない shot id は 404", async () => {
    const res = await SELF.fetch(`${BASE}/shot/s4/does-not-exist`);
    expect(res.status).toBe(404);
  });
});
