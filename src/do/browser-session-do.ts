/**
 * BrowserSessionDO — 1 session = 1 DO (idFromName(session))。
 *
 * 手元 Chrome の MV3 拡張が張る WS を hibernatable に hold し、MCP tool が投入する
 * CDP コマンドを id 相関で往復させ、screenshot を SQLite に一時保存・配信する:
 *
 *   GET  /ext/{session}        … 拡張の WS upgrade (hibernatable hold)。pair/relay-token を検証
 *   POST /cmd                  … (internal) MCP tool → DO の CDP コマンド投入口。WS へ転送し応答を待つ
 *   POST /pair                 … (internal) browser_pair tool → 短命 pairing code を mint
 *   PUT  /shot/{session}       … 拡張が screenshot(PNG) を投入。shot_url を返す
 *   GET  /shot/{session}/{id}  … screenshot 一時配信 (予測不能 id、TTL 付き)
 *
 * /ext と /shot PUT の認証は「RELAY_TOKEN 一致 (edge で検証済み) または この DO が
 * 発行した有効な pairing code」。edge は `X-Relay-Auth` ヘッダで結果を伝える
 * (relay-token = RELAY_TOKEN 一致済 / pair = ?token= を pairing code として要検証)。
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

/** pairing code TTL の上限 (秒)。tool が過大な ttl_seconds を渡しても clamp する。 */
const MAX_PAIR_TTL_SECONDS = 86_400;

/** 32 byte (256-bit) の高エントロピー hex を返す (pairing code 用)。 */
function randomCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
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
    // pair flow: browser_pair が mint する短命 pairing code。hibernate を跨ぐので
    // in-memory ではなく SQLite に保存する (mint した instance と /ext 接続を捌く
    // instance が別でも引けるように)。
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS pairings(
        code TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );`,
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // 拡張の WS upgrade。
    if (path.startsWith("/ext/") && req.headers.get("Upgrade") === "websocket") {
      return this.handleExt(req);
    }
    // MCP tool → CDP コマンド投入 (internal、edge では公開しない)。
    if (path.endsWith("/cmd") && req.method === "POST") {
      return this.handleCmd(req);
    }
    // browser_pair tool → 短命 pairing code を mint (internal、edge では公開しない)。
    if (path.endsWith("/pair") && req.method === "POST") {
      return this.handlePair(req);
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

  // ─── 認証 (relay-token / pair code) ─────────────────────────────────────────

  /**
   * /ext + /shot PUT の認可。edge が付ける `X-Relay-Auth` を信頼する:
   *   - relay-token … edge で RELAY_TOKEN と constant-time 一致済み (DO は素通り)
   *   - pair        … ?token= を pairing code として DO が権威的に検証する
   * DO は public に到達できない (Worker からのみ fetch される) ので header は信頼可。
   */
  private authorize(req: Request): boolean {
    const kind = req.headers.get("X-Relay-Auth");
    if (kind === "relay-token") return true;
    if (kind === "pair") {
      const token = new URL(req.url).searchParams.get("token") ?? "";
      return this.validPairCode(token);
    }
    return false;
  }

  /** pairing code が未失効で存在するか。expired 行はついでに掃除する。 */
  private validPairCode(token: string): boolean {
    // pairing code は 256-bit ランダムなので PK 等価比較で timing 懸念は実害無し
    // (短い秘密の RELAY_TOKEN は edge 側で constant-time 比較している)。
    if (token === "") return false;
    const now = Date.now();
    this.sql.exec("DELETE FROM pairings WHERE expires_at < ?", now);
    const rows = this.sql
      .exec("SELECT code FROM pairings WHERE code = ? AND expires_at > ?", token, now)
      .toArray();
    return rows.length > 0;
  }

  // ─── pair flow: pairing code の mint (/pair) ────────────────────────────────

  private async handlePair(req: Request): Promise<Response> {
    let body: { ttl_seconds?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }
    const requested =
      typeof body.ttl_seconds === "number" && Number.isFinite(body.ttl_seconds)
        ? body.ttl_seconds
        : settings(this.env).pairTtlSeconds;
    const ttl = Math.min(Math.max(Math.floor(requested), 1), MAX_PAIR_TTL_SECONDS);

    const code = randomCode();
    const now = Date.now();
    const expiresAt = now + ttl * 1000;
    // session 単位で 1 code をアクティブに保つ (mint し直すと旧 code は失効)。
    this.sql.exec("DELETE FROM pairings");
    this.sql.exec(
      "INSERT INTO pairings(code, created_at, expires_at) VALUES (?, ?, ?)",
      code,
      now,
      expiresAt,
    );
    return json({ pair_code: code, expires_in_seconds: ttl, expires_at: expiresAt });
  }

  // ─── 拡張 WS (hibernatable) ─────────────────────────────────────────────────

  /** 1 session = 1 拡張接続。既存接続があれば閉じて最後勝ちにする。 */
  private handleExt(req: Request): Response {
    if (!this.authorize(req)) return json({ error: "unauthorized" }, 401);
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
    if (!this.authorize(req)) return json({ error: "unauthorized" }, 401);
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
