import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import {
  browserCdpEndpoint,
  browserCookies,
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

  it("browser_stash は 1MiB 超を chunk 分割保存し単一 stash_url で全量回収できる", async () => {
    const session = "stashbig-" + crypto.randomUUID();
    // 1MiB(=MAX_STASH_BYTES) を超える payload → DO 内部で複数行に分割保存される。
    const payload = "x".repeat(1024 * 1024 + 123_456); // ~1.12 MiB → 2 parts
    await connectExtension(session, (method) => {
      if (method !== "eval") throw new Error("unexpected:" + method);
      return { value: payload };
    });
    const r = await browserStash(E, session, "window.__huge");
    expect(r.size_bytes).toBe(payload.length);
    expect(r.n_parts).toBe(2); // ceil(1.12MiB / 1MiB)
    // 回収は連結配信されるので単一 curl 相当 (SELF.fetch) で全量が戻る。
    const got = await SELF.fetch(r.stash_url);
    expect(got.status).toBe(200);
    const text = await got.text();
    expect(text.length).toBe(payload.length);
    expect(text).toBe(payload);
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

  it("browser_stash は active な content_type (text/html) を弾く (stored XSS 防止)", async () => {
    const session = "stashbad-" + crypto.randomUUID();
    // content_type 検証は eval 往復より前なので handler は呼ばれないが、拡張は接続済み
    // でないと先に extension_not_connected で落ちるため繋いでおく。
    await connectExtension(session, () => ({ value: "<script>alert(1)</script>" }));
    await expect(
      browserStash(E, session, "'<script>alert(1)</script>'", "text/html"),
    ).rejects.toThrow(/unsupported_content_type/);
  });

  it("browser_cookies が Network.getCookies を転送し cookies_url で回収できる", async () => {
    const session = "cookies-" + crypto.randomUUID();
    const cookies = [
      { name: "JSESSIONID", value: "ABC123", domain: "www.etc-meisai.jp", httpOnly: true },
      { name: "csrf", value: "xyz", domain: "www.etc-meisai.jp" },
    ];
    await connectExtension(session, (method, params) => {
      if (method !== "cookies") throw new Error("unexpected:" + method);
      // urls (対象 origin 絞り) がそのまま拡張へ渡ること。
      expect(params.urls).toEqual(["https://www.etc-meisai.jp"]);
      return { cookies };
    });
    const r = await browserCookies(E, session, ["https://www.etc-meisai.jp"]);
    // cookie 生値は戻り値に載らず、回収 URL だけが返る (context に session token を残さない)。
    expect(r).not.toHaveProperty("cookies");
    expect(r.content_type).toBe("application/json; charset=utf-8");
    expect(r.cookies_url).toBe(
      `https://cdp-relay.test/shot/${session}/${r.cookies_url.split("/").pop()}`,
    );
    const got = await SELF.fetch(r.cookies_url);
    expect(got.status).toBe(200);
    expect(JSON.parse(await got.text())).toEqual({ cookies });
  });

  it("browser_cookies は拡張が cookies を返さなくても空配列で保存する", async () => {
    const session = "cookies-empty-" + crypto.randomUUID();
    await connectExtension(session, () => ({})); // cookies フィールド無し
    const r = await browserCookies(E, session, ["https://x.example"]);
    const got = await SELF.fetch(r.cookies_url);
    expect(JSON.parse(await got.text())).toEqual({ cookies: [] });
  });

  it("browser_cookies は urls 空 / session 空を弾く", async () => {
    await expect(browserCookies(E, "s", [])).rejects.toThrow(/urls is required/);
    await expect(browserCookies(E, "", ["https://x"])).rejects.toThrow(/session is required/);
  });

  it("browser_cookies は拡張未接続で extension_not_connected", async () => {
    await expect(
      browserCookies(E, "noext-" + crypto.randomUUID(), ["https://x.example"]),
    ).rejects.toThrow(/extension_not_connected/);
  });

  it("browser_cookies DO は不正 body / urls 空を弾く (tool を迂回した防御)", async () => {
    const session = "cookies-do-" + crypto.randomUUID();
    await connectExtension(session, () => ({ cookies: [] }));
    const stub = E.BROWSER_DO.get(E.BROWSER_DO.idFromName(session));
    const bad = await stub.fetch("https://cdp-relay.internal/cookies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("bad_request");
    const noUrls = await stub.fetch("https://cdp-relay.internal/cookies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: [] }),
    });
    expect(noUrls.status).toBe(400);
    expect(((await noUrls.json()) as { error: string }).error).toBe("urls_required");
  });

  it("browser_cookies は拡張エラーを 502 相当で伝播する", async () => {
    const session = "cookies-err-" + crypto.randomUUID();
    await connectExtension(session, () => {
      throw new Error("Network.getCookies failed");
    });
    await expect(browserCookies(E, session, ["https://x.example"])).rejects.toThrow(
      /Network.getCookies failed/,
    );
  });

  it("browser_cookies は拡張無応答で cdp_timeout", async () => {
    const session = "cookies-to-" + crypto.randomUUID();
    const res = await SELF.fetch(`${BASE}/ext/${session}?token=${TOKEN}`, {
      headers: { Upgrade: "websocket" },
    });
    res.webSocket!.accept(); // 受けても応答しない
    await new Promise((r) => setTimeout(r, 50));
    await expect(browserCookies(E, session, ["https://x.example"])).rejects.toThrow(/cdp_timeout/);
  });

  it("url が http(s) でなければ弾く", async () => {
    await expect(browserNavigate(E, "x", "ftp://nope")).rejects.toThrow(CdpToolError);
  });

  it("空 session を弾く", async () => {
    await expect(browserNavigate(E, "", "https://example.com")).rejects.toThrow(/session is required/);
  });
});

describe("browser_cdp_endpoint (chrome-devtools-mcp passthrough)", () => {
  it("wsEndpoint / bridge / mcp コマンド + CDP mode の pair_string を返す", async () => {
    const session = "cdpep-" + crypto.randomUUID();
    const r = await browserCdpEndpoint(E, session, 600);
    expect(r.session).toBe(session);
    expect(r.pair_code).toMatch(/^[0-9a-f]{64}$/);
    expect(r.expires_in_seconds).toBe(600);
    // wsEndpoint は wss + /cdp/{session}/devtools/browser?token=pair_code。
    expect(r.ws_endpoint).toBe(
      `wss://cdp-relay.test/cdp/${session}/devtools/browser?token=${r.pair_code}`,
    );
    expect(r.chrome_devtools_mcp_command).toContain(`--wsEndpoint "${r.ws_endpoint}"`);
    expect(r.bridge_command).toContain(`--session ${session} --token ${r.pair_code}`);
    // pair_string は cdp1.… で decode すると mode=cdp を含む (拡張が CDP mode を自動選択)。
    expect(r.pair_string).toMatch(/^cdp1\./);
    let b64 = r.pair_string.slice(5).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
    expect(decoded).toMatchObject({ s: session, t: r.pair_code, m: "cdp" });
  });

  it("session 省略時は pair-xxxxxxxx を採番する", async () => {
    const r = await browserCdpEndpoint(E);
    expect(r.session).toMatch(/^pair-[0-9a-f]{8}$/);
  });
});
