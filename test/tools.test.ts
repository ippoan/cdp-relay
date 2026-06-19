import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import {
  browserEval,
  browserNavigate,
  browserScreenshot,
  browserStash,
  CdpToolError,
} from "../src/mcp/tools";
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

  it("browser_eval が拡張へ転送され value が返る", async () => {
    const session = "eval-" + crypto.randomUUID();
    await connectExtension(session, (method, params) => {
      if (method !== "eval") throw new Error("unexpected:" + method);
      expect(params.expression).toBe("document.title");
      return { value: "Example Domain" };
    });
    const r = await browserEval(E, session, "document.title");
    expect(r.value).toBe("Example Domain");
  });

  it("browser_eval は空 expression を弾く", async () => {
    await expect(browserEval(E, "x", "")).rejects.toThrow(/expression is required/);
  });

  it("browser_stash が eval 結果を保存し stash_url で回収できる (大きな文字列)", async () => {
    const session = "stash-" + crypto.randomUUID();
    // MCP body に載せたくない想定の大きめ文字列 (例: gzip+base64 dump)。
    const payload = "ABCDEFGHIJ".repeat(6000); // 60,000 bytes
    await connectExtension(session, (method, params) => {
      if (method !== "eval") throw new Error("unexpected:" + method);
      expect(params.expression).toBe("window.__big");
      return { value: payload };
    });
    const r = await browserStash(E, session, "window.__big");
    expect(r.size_bytes).toBe(payload.length);
    // stash_url は relayOrigin(env) (= test binding https://cdp-relay.test) で組まれ、
    // screenshot と同じ /shot/{session}/{id} 経路で回収できる。
    expect(r.stash_url).toBe(
      `https://cdp-relay.test/shot/${session}/${r.stash_url.split("/").pop()}`,
    );
    const got = await SELF.fetch(r.stash_url);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe(payload);
  });

  it("browser_stash は object 値を JSON 文字列化して保存する (content_type 指定)", async () => {
    const session = "stashobj-" + crypto.randomUUID();
    await connectExtension(session, (method) => {
      if (method !== "eval") throw new Error("unexpected");
      return { value: { a: 1, b: "two" } };
    });
    const r = await browserStash(E, session, "({a:1,b:'two'})", "application/json");
    expect(r.content_type).toBe("application/json");
    const got = await SELF.fetch(r.stash_url);
    expect(got.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(await got.text())).toEqual({ a: 1, b: "two" });
  });

  it("browser_stash は拡張未接続で extension_not_connected", async () => {
    await expect(browserStash(E, "noext-" + crypto.randomUUID(), "1")).rejects.toThrow(
      /extension_not_connected/,
    );
  });

  it("browser_stash は空 expression / session を弾く", async () => {
    await expect(browserStash(E, "x", "")).rejects.toThrow(/expression is required/);
    await expect(browserStash(E, "", "1")).rejects.toThrow(/session is required/);
  });

  it("url が http(s) でなければ弾く", async () => {
    await expect(browserNavigate(E, "x", "ftp://nope")).rejects.toThrow(CdpToolError);
  });

  it("空 session を弾く", async () => {
    await expect(browserNavigate(E, "", "https://example.com")).rejects.toThrow(/session is required/);
  });
});
