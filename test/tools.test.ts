import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { browserNavigate, browserScreenshot, CdpToolError } from "../src/mcp/tools";
import type { Env } from "../src/env";

// MCP の SDK 配線 (server.ts) は ajv の JSON-module require で workers-pool loader を
// 壊すため、ここではツールの純粋ロジック (tools.ts) を実 DO 相手に直接テストする。
const E = env as unknown as Env;
const BASE = "https://cdp-relay.test";
const TOKEN = "test-token";

/** 拡張役の WS を /ext/{session} に張り、method→handler の結果で応答させる。 */
async function connectExtension(
  session: string,
  handler: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>,
): Promise<WebSocket> {
  const res = await SELF.fetch(`${BASE}/ext/${session}?token=${TOKEN}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  ws.addEventListener("message", async (e) => {
    const { id, method, params } = JSON.parse(e.data as string);
    try {
      ws.send(JSON.stringify({ id, result: await handler(method, params) }));
    } catch (err) {
      ws.send(JSON.stringify({ id, error: String((err as Error).message) }));
    }
  });
  // DO が WS を accept (getWebSockets に反映) するまで少し待つ。
  await new Promise((r) => setTimeout(r, 50));
  return ws;
}

describe("MCP tools (/cmd 往復)", () => {
  it("拡張未接続なら extension_not_connected", async () => {
    await expect(
      browserNavigate(E, "noext-" + crypto.randomUUID(), "https://example.com"),
    ).rejects.toThrow(/extension_not_connected/);
  });

  it("browser_navigate が拡張へ転送され結果が返る", async () => {
    const session = "nav-" + crypto.randomUUID();
    await connectExtension(session, (method, params) => {
      if (method === "navigate") return { url: params.url };
      throw new Error("unexpected:" + method);
    });
    const r = await browserNavigate(E, session, "https://example.com/");
    expect(r.url).toBe("https://example.com/");
  });

  it("browser_screenshot が shot_url を返す (拡張が /shot に PUT)", async () => {
    const session = "shot-" + crypto.randomUUID();
    await connectExtension(session, async (method) => {
      if (method !== "screenshot") throw new Error("unexpected");
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const put = await SELF.fetch(`${BASE}/shot/${session}?token=${TOKEN}`, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: png,
      });
      const body = (await put.json()) as { shot_url: string };
      return { shot_url: body.shot_url };
    });
    const r = await browserScreenshot(E, session);
    expect(r.shot_url).toContain(`/shot/${session}/`);
    const got = await SELF.fetch(r.shot_url);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
  });

  it("拡張が error を返すと CdpToolError に伝播する", async () => {
    const session = "err-" + crypto.randomUUID();
    await connectExtension(session, () => {
      throw new Error("debugger_detached");
    });
    await expect(browserNavigate(E, session, "https://example.com")).rejects.toThrow(
      /debugger_detached/,
    );
  });

  it("拡張が応答しないと cdp_timeout (CMD_TIMEOUT_MS=300)", async () => {
    const session = "to-" + crypto.randomUUID();
    const res = await SELF.fetch(`${BASE}/ext/${session}?token=${TOKEN}`, {
      headers: { Upgrade: "websocket" },
    });
    res.webSocket!.accept(); // メッセージを受けても応答しない
    await new Promise((r) => setTimeout(r, 50));
    await expect(browserScreenshot(E, session)).rejects.toThrow(/cdp_timeout/);
  });

  it("url が http(s) でなければ弾く", async () => {
    await expect(browserNavigate(E, "x", "ftp://nope")).rejects.toThrow(CdpToolError);
  });

  it("空 session を弾く", async () => {
    await expect(browserNavigate(E, "", "https://example.com")).rejects.toThrow(/session is required/);
  });
});
