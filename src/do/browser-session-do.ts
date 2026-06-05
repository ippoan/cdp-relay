/**
 * BrowserSessionDO — 1 session = 1 DO (idFromName(session))。
 *
 * 手元 Chrome の MV3 拡張が張る WS を hibernatable に hold し、MCP tool が投入する
 * CDP コマンドを id 相関で往復させ、screenshot を SQLite に一時保存・配信する:
 *
 *   GET  /ext/{session}        … 拡張の WS upgrade (hibernatable hold)。token は edge で検証済み
 *   POST /cmd                  … (internal) MCP tool → DO の CDP コマンド投入口。WS へ転送し応答を待つ
 *   PUT  /shot/{session}       … 拡張が screenshot(PNG) を投入。shot_url を返す
 *   GET  /shot/{session}/{id}  … screenshot 一時配信 (予測不能 id、TTL 付き)
 *
 * pending Map は in-memory。DO は /cmd の Promise を待っている間アクティブなので
 * (in-flight request 中は hibernate されない)、WS 往復は同一インスタンスで閉じる。
 */
import { Env, settings } from "../env";

type ShotRow = {
  id: string;
  created_at: number;
  content_type: string;
  bytes: ArrayBuffer;
};

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class BrowserSessionDO {
  private readonly sql: SqlStorage;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS shots(
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        bytes BLOB NOT NULL
      );`,
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // 拡張の WS upgrade。
    if (path.startsWith("/ext/") && req.headers.get("Upgrade") === "websocket") {
      return this.handleExt();
    }
    // MCP tool → CDP コマンド投入 (internal、edge では公開しない)。
    if (path.endsWith("/cmd") && req.method === "POST") {
      return this.handleCmd(req);
    }
    // screenshot 投入 (拡張) / 配信 (Claude が curl)。
    if (req.method === "PUT" && /^\/shot\/[^/]+\/?$/.test(path)) {
      return this.handleShotPut(req);
    }
    if (req.method === "GET" && /^\/shot\/[^/]+\/[^/]+\/?$/.test(path)) {
      return this.handleShotGet(path);
    }
    return text("not found", 404);
  }

  // ─── 拡張 WS (hibernatable) ─────────────────────────────────────────────────

  /** 1 session = 1 拡張接続。既存接続があれば閉じて最後勝ちにする。 */
  private handleExt(): Response {
    for (const old of this.ctx.getWebSockets()) {
      try {
        old.close(1000, "replaced");
      } catch {
        /* already closed */
      }
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]); // hibernation 管理下に置く
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ─── MCP → CDP コマンド投入 (/cmd) ──────────────────────────────────────────

  private async handleCmd(req: Request): Promise<Response> {
    const ws = this.ctx.getWebSockets()[0];
    if (!ws) return json({ error: "extension_not_connected" }, 503);

    let body: { method?: unknown; params?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    const method = body.method;
    if (typeof method !== "string" || method === "") {
      return json({ error: "method_required" }, 400);
    }
    const params = body.params ?? {};

    const id = this.nextId++;
    const timeoutMs = settings(this.env).cmdTimeoutMs;

    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("cdp_timeout"));
        }, timeoutMs);
        this.pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error("ws_send_failed"));
        }
      });
      return json({ ok: true, result });
    } catch (e) {
      const msg = (e as Error).message;
      const status = msg === "cdp_timeout" ? 504 : 502;
      return json({ error: msg }, status);
    }
  }

  // ─── WS hibernation lifecycle ───────────────────────────────────────────────

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let parsed: { id?: unknown; result?: unknown; error?: unknown };
    try {
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return; // 不正な frame は黙殺
    }
    if (typeof parsed.id !== "number") return;
    const p = this.pending.get(parsed.id);
    if (!p) return;
    this.pending.delete(parsed.id);
    if (parsed.error !== undefined && parsed.error !== null) {
      p.reject(new Error(String(parsed.error)));
    } else {
      p.resolve(parsed.result);
    }
  }

  async webSocketClose(): Promise<void> {
    this.rejectAllPending("extension_disconnected");
  }

  async webSocketError(): Promise<void> {
    this.rejectAllPending("extension_ws_error");
  }

  /** 拡張切断時に in-flight /cmd を全て reject して hang を防ぐ。 */
  private rejectAllPending(reason: string): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new Error(reason));
    }
  }

  // ─── screenshot 一時保存 / 配信 ─────────────────────────────────────────────

  private async handleShotPut(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/shot\/([^/]+)/);
    const session = m ? m[1] : "";

    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) return json({ error: "empty_body" }, 400);
    const contentType = req.headers.get("Content-Type") || "image/png";

    const now = Date.now();
    const ttlMs = settings(this.env).shotTtlSeconds * 1000;
    // 古い shot を掃除 (alarm 無しでも肥大化しない)。
    this.sql.exec("DELETE FROM shots WHERE created_at < ?", now - ttlMs);

    const id = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO shots(id, created_at, content_type, bytes) VALUES (?, ?, ?, ?)",
      id,
      now,
      contentType,
      bytes,
    );

    const configured = this.env.RELAY_ORIGIN;
    const origin = configured && configured !== "" ? configured.replace(/\/+$/, "") : url.origin;
    return json({
      shot_url: `${origin}/shot/${session}/${id}`,
      id,
      content_type: contentType,
      size_bytes: bytes.length,
    });
  }

  private handleShotGet(path: string): Response {
    const m = path.match(/^\/shot\/[^/]+\/([^/]+)/);
    const id = m ? m[1] : "";
    const rows = this.sql.exec<ShotRow>("SELECT * FROM shots WHERE id = ?", id).toArray();
    if (rows.length === 0) return text("not found", 404);

    const row = rows[0];
    const ttlMs = settings(this.env).shotTtlSeconds * 1000;
    if (row.created_at < Date.now() - ttlMs) {
      this.sql.exec("DELETE FROM shots WHERE id = ?", id);
      return text("expired", 410);
    }

    return new Response(new Uint8Array(row.bytes), {
      headers: {
        "Content-Type": row.content_type,
        // 一時 URL。共有はせず短命キャッシュのみ。
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
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
