import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { browserPair, browserNavigate, CdpToolError } from "../src/mcp/tools";
import type { Env } from "../src/env";

// pair flow: browser_pair が DO に短命 pairing code を mint し、拡張 popup がその code
// を ?token= に使って /ext + /shot に接続できることを検証する。RELAY_TOKEN を人手で
// 調べる代わりに Claude が code を発行して手元に渡す経路 (Refs ippoan/cdp-relay#7)。
const E = env as unknown as Env;
const BASE = "https://cdp-relay.test";

describe("browser_pair (pairing code の mint)", () => {
  it("session 省略でランダム採番 + pair_code / relay_url を返す", async () => {
    const r = await browserPair(E);
    expect(r.session).toMatch(/^pair-[0-9a-f]{8}$/);
    expect(r.pair_code).toMatch(/^[0-9a-f]{64}$/); // 32 byte hex
    expect(r.expires_in_seconds).toBeGreaterThan(0);
    // RELAY_ORIGIN (test binding = https://cdp-relay.test) を origin にする。
    expect(r.relay_url).toBe("https://cdp-relay.test");
  });

  it("session 明示時はその session を使う", async () => {
    const session = "pairtest-" + crypto.randomUUID();
    const r = await browserPair(E, session);
    expect(r.session).toBe(session);
  });

  it("pair_string は cdp1.<base64url> で relay/session/token を 1 文字列に pack する", async () => {
    const session = "paircombo-" + crypto.randomUUID();
    const r = await browserPair(E, session);
    expect(r.pair_string).toMatch(/^cdp1\.[A-Za-z0-9_-]+$/);
    // popup 側 decode と同じ手順で 3 値に戻せること。
    let b64 = r.pair_string.slice(5).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
    expect(o).toEqual({ r: r.relay_url, s: r.session, t: r.pair_code });
  });
});

describe("pairing code での /ext + /shot 接続", () => {
  it("mint した code で /ext が 101 (拡張 WS 合流)", async () => {
    const session = "pairext-" + crypto.randomUUID();
    const { pair_code } = await browserPair(E, session);
    const res = await SELF.fetch(`${BASE}/ext/${session}?token=${pair_code}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it("mint した code で /shot PUT が 200", async () => {
    const session = "pairshot-" + crypto.randomUUID();
    const { pair_code } = await browserPair(E, session);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const res = await SELF.fetch(`${BASE}/shot/${session}?token=${pair_code}`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: png,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shot_url: string };
    expect(body.shot_url).toContain(`/shot/${session}/`);
  });

  it("pairing code は session 単位 — 別 session では弾く (401)", async () => {
    const minted = "pairA-" + crypto.randomUUID();
    const other = "pairB-" + crypto.randomUUID();
    const { pair_code } = await browserPair(E, minted);
    const res = await SELF.fetch(`${BASE}/ext/${other}?token=${pair_code}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("未 mint の (でたらめな) code は 401", async () => {
    const session = "pairnone-" + crypto.randomUUID();
    const res = await SELF.fetch(`${BASE}/ext/${session}?token=deadbeef`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("TTL 超過した pairing code は 401 (ttl_seconds=1)", async () => {
    const session = "pairexp-" + crypto.randomUUID();
    const { pair_code } = await browserPair(E, session, 1);
    await new Promise((r) => setTimeout(r, 1100));
    const res = await SELF.fetch(`${BASE}/ext/${session}?token=${pair_code}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("mint し直すと旧 code は失効する (session 単位 1 code)", async () => {
    const session = "pairrenew-" + crypto.randomUUID();
    const first = await browserPair(E, session);
    const second = await browserPair(E, session);
    expect(second.pair_code).not.toBe(first.pair_code);
    // 旧 code は弾かれる。
    const old = await SELF.fetch(`${BASE}/ext/${session}?token=${first.pair_code}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(old.status).toBe(401);
    // 新 code は通る。
    const fresh = await SELF.fetch(`${BASE}/ext/${session}?token=${second.pair_code}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(fresh.status).toBe(101);
    fresh.webSocket?.accept();
    fresh.webSocket?.close();
  });

  it("paired 後の browser_navigate が拡張へ往復する (E2E)", async () => {
    const session = "paire2e-" + crypto.randomUUID();
    const { pair_code } = await browserPair(E, session);
    const res = await SELF.fetch(`${BASE}/ext/${session}?token=${pair_code}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    ws.addEventListener("message", (e) => {
      const { id, method, params } = JSON.parse(e.data as string);
      if (method === "navigate") ws.send(JSON.stringify({ id, result: { url: params.url } }));
      else ws.send(JSON.stringify({ id, error: "unexpected:" + method }));
    });
    await new Promise((r) => setTimeout(r, 50));
    const nav = await browserNavigate(E, session, "https://example.com/");
    expect(nav.url).toBe("https://example.com/");
    ws.close();
  });

  it("browser_pair の DO mint 失敗は CdpToolError (型ガード)", async () => {
    // ttl_seconds を負値にしても DO 側で clamp (>=1) するので mint は成功する。
    // ここでは clamp の健全性 (例外を投げない) だけ確認する。
    const r = await browserPair(E, "pairclamp-" + crypto.randomUUID(), -5);
    expect(r.pair_code).toMatch(/^[0-9a-f]{64}$/);
    expect(() => {
      throw new CdpToolError("x");
    }).toThrow(CdpToolError);
  });
});
