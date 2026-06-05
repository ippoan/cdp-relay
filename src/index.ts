/**
 * cdp-relay Worker エントリ。
 *
 * 役割は薄い: token を検証し、request を session (= idFromName) で BrowserSessionDO に
 * 振り分けるだけ。CDP の往復 / screenshot 保存はすべて DO 側にある。
 *
 *   POST /mcp                  … MCP ツール。MCP-JWT 認証 (ref-files と同方式、RELAY_TOKEN ではない)
 *   GET  /ext/{session}        … 拡張の WS upgrade。token (?token=) 必須
 *   PUT  /shot/{session}       … 拡張が screenshot を投入。token 必須
 *   GET  /shot/{session}/{id}  … screenshot 一時配信 (予測不能 id ゆえ token 不要)
 *   GET  /health               … ヘルスチェック
 *   GET  /                     … 説明ページ
 *
 * /cmd は edge では公開しない (MCP tool だけが DO stub 経由で内部的に叩く)。
 */
import { Env } from "./env";
import { checkToken, TokenCheck, checkMcpJwt, McpJwtCheck } from "./lib/auth";

export { BrowserSessionDO } from "./do/browser-session-do";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" || path === "") return landingPage();
    if (path === "/health") return json({ ok: true });

    if (path === "/mcp") {
      // /mcp は ippoan 標準の MCP-JWT 認証 (ref-files と同方式)。RELAY_TOKEN ではない。
      const gate = await requireMcpJwt(req, env);
      if (gate) return gate;
      // MCP SDK (+ ajv) は重く workers-pool テスト loader とも相性が悪いので、
      // /mcp が叩かれた時だけ遅延ロードする。
      const { handleMcp } = await import("./mcp/server");
      return handleMcp(req, env);
    }

    // /ext/{session} — 拡張の WS upgrade。
    const ext = path.match(/^\/ext\/([^/]+)\/?$/);
    if (ext) {
      if (req.headers.get("Upgrade") !== "websocket") {
        return text("expected websocket upgrade", 426);
      }
      const gate = await requireToken(req, env);
      if (gate) return gate;
      return routeToDo(env, ext[1], req);
    }

    // /shot/{session}            PUT (token) — 拡張が screenshot 投入
    // /shot/{session}/{id}       GET (no token) — Claude が curl で取得
    const shot = path.match(/^\/shot\/([^/]+)(?:\/([^/]+))?\/?$/);
    if (shot) {
      const session = shot[1];
      const shotId = shot[2];
      if (req.method === "PUT" && !shotId) {
        const gate = await requireToken(req, env);
        if (gate) return gate;
        return routeToDo(env, session, req);
      }
      if (req.method === "GET" && shotId) {
        // 予測不能 id を知る者だけが取れる (ui-preview の無認証配信と同じ思想)。
        return routeToDo(env, session, req);
      }
      return text("method not allowed", 405);
    }

    return text("not found", 404);
  },
};

/** session を idFromName で DO に引き、request をそのまま委譲する。 */
function routeToDo(env: Env, session: string, req: Request): Promise<Response> {
  const id = env.BROWSER_DO.idFromName(session);
  return env.BROWSER_DO.get(id).fetch(req);
}

/** RELAY_TOKEN gate (/ext + /shot PUT)。ok なら null、NG なら Response を返す。 */
async function requireToken(req: Request, env: Env): Promise<Response | null> {
  const r: TokenCheck = await checkToken(req, env);
  if (r === "ok") return null;
  if (r === "not_configured") return json({ error: "relay_token_not_configured" }, 503);
  if (r === "missing_token") return json({ error: "missing_token" }, 401);
  return json({ error: "unauthorized" }, 401);
}

/** MCP-JWT gate (/mcp)。ok なら null、NG なら Response (401 は WWW-Authenticate 付き)。 */
async function requireMcpJwt(req: Request, env: Env): Promise<Response | null> {
  const r: McpJwtCheck = await checkMcpJwt(req, env);
  if (r === "ok") return null;
  if (r === "not_configured") return json({ error: "mcp_jwt_secret_not_configured" }, 500);
  return new Response(JSON.stringify({ error: "unauthorized", reason: r }), {
    status: 401,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "WWW-Authenticate": 'Bearer realm="MCP"',
    },
  });
}

function landingPage(): Response {
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>cdp-relay</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font: 14px/1.7 system-ui, sans-serif; }
    main { padding: 24px; max-width: 760px; }
    h1 { font-size: 18px; }
    code { font-family: ui-monospace, monospace; background: #8881; padding: 1px 5px; border-radius: 3px; }
    table { border-collapse: collapse; margin: 12px 0; }
    th, td { border: 1px solid #8884; padding: 4px 10px; text-align: left; }
  </style>
</head>
<body>
  <main>
    <h1>cdp-relay</h1>
    <p>CCoW の隔離コンテナから手元 Chrome を CDP 操作する DO+WS リレー。
       手元 Chrome に MV3 拡張をロードし、session 名 + token を合わせて接続する。</p>
    <table>
      <tr><th>メソッド / パス</th><th>役割</th></tr>
      <tr><td><code>POST /mcp</code></td><td>MCP (browser_navigate / browser_screenshot)。MCP-JWT 認証</td></tr>
      <tr><td><code>GET /ext/{session}</code></td><td>拡張の WS upgrade。<code>?token=</code> 必須</td></tr>
      <tr><td><code>PUT /shot/{session}</code></td><td>拡張が screenshot を投入。token 必須</td></tr>
      <tr><td><code>GET /shot/{session}/{id}</code></td><td>screenshot 一時配信 (予測不能 id)</td></tr>
      <tr><td><code>GET /health</code></td><td>ヘルスチェック</td></tr>
    </table>
  </main>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
