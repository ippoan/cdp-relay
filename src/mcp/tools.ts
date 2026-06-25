/**
 * MCP ツールの純粋ロジック。
 *
 * MCP SDK / transport から切り離してここに置くことで、workers-pool テストでは
 * SDK (ajv が JSON module を require して pool loader を壊す) を読み込まずに
 * 実 DO 相手にロジックを検証できる。SDK 配線は `server.ts` 側の薄い 1 枚。
 *
 * 各 tool は `BROWSER_DO.get(idFromName(session))` で session の DO を引き、
 * 内部 `/cmd` に CDP コマンドを POST する (拡張へ WS 転送 → 応答が往復で返る)。
 */
import type { Env } from "../env";

export class CdpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpToolError";
  }
}

/** DO 内部 endpoint は実際の host を使わない (idFromName で stub を引くため固定で良い)。 */
const DO_CMD_URL = "https://cdp-relay.internal/cmd";
const DO_PAIR_URL = "https://cdp-relay.internal/pair";
const DO_STASH_URL = "https://cdp-relay.internal/stash";

/** RELAY_ORIGIN を公開 origin に正規化する (空なら本番 custom domain)。 */
function relayOrigin(env: Env): string {
  const o = env.RELAY_ORIGIN;
  return o && o !== "" ? o.replace(/\/+$/, "") : "https://cdp-relay.ippoan.org";
}

/** ランダムな session 名 (pair-xxxxxxxx)。browser_pair で session 省略時に採番。 */
function randomSession(): string {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return "pair-" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** session の DO に CDP コマンドを 1 往復投げ、result を返す。 */
async function sendCommand(
  env: Env,
  session: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (typeof session !== "string" || session === "") {
    throw new CdpToolError("session is required");
  }
  const id = env.BROWSER_DO.idFromName(session);
  const stub = env.BROWSER_DO.get(id);
  const res = await stub.fetch(DO_CMD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const body = (await res.json()) as { ok?: boolean; result?: unknown; error?: string };
  if (!res.ok || body.error) {
    throw new CdpToolError(body.error ?? `cmd_failed_${res.status}`);
  }
  return body.result;
}

export interface NavigateResult {
  url: string;
}

/** session の拡張に navigate を指示する。url は http(s) のみ許可。 */
export async function browserNavigate(env: Env, session: string, url: string): Promise<NavigateResult> {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new CdpToolError("url must start with http:// or https://");
  }
  return (await sendCommand(env, session, "navigate", { url })) as NavigateResult;
}

export interface PairResult {
  /** ペアリング先 session 名 (省略時に採番されたものを含む)。popup の Session 欄に入れる。 */
  session: string;
  /** 拡張 popup の Token 欄に貼る短命 pairing code。 */
  pair_code: string;
  /** pair_code の有効秒数。 */
  expires_in_seconds: number;
  /** popup の Relay URL 欄に入れる公開 origin。 */
  relay_url: string;
}

/**
 * 手元 Chrome の拡張をこの session にペアリングするための短命 pairing code を発行する。
 * 静的 RELAY_TOKEN を人手で調べる代わりに、Claude が code を発行して手元に渡す
 * (pair flow)。session を省略すると `pair-xxxxxxxx` を採番する。返り値の値を popup の
 * Relay URL / Session / Token に貼って「接続」すれば、その session の DO に拡張 WS が合流する。
 */
export async function browserPair(
  env: Env,
  session?: string,
  ttlSeconds?: number,
): Promise<PairResult> {
  const s = typeof session === "string" && session.trim() !== "" ? session.trim() : randomSession();
  const id = env.BROWSER_DO.idFromName(s);
  const stub = env.BROWSER_DO.get(id);
  const reqBody: Record<string, unknown> = {};
  if (typeof ttlSeconds === "number") reqBody.ttl_seconds = ttlSeconds;
  const res = await stub.fetch(DO_PAIR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  const body = (await res.json()) as {
    pair_code?: string;
    expires_in_seconds?: number;
    error?: string;
  };
  if (!res.ok || !body.pair_code) {
    throw new CdpToolError(body.error ?? `pair_failed_${res.status}`);
  }
  return {
    session: s,
    pair_code: body.pair_code,
    expires_in_seconds: body.expires_in_seconds ?? 0,
    relay_url: relayOrigin(env),
  };
}

export interface ScreenshotResult {
  shot_url: string;
}

/**
 * session の拡張に viewport screenshot を撮らせる。
 * PNG 本体は MCP body に載せず (token 浪費回避)、拡張が DO の /shot に PUT した
 * shot_url だけが返る。Claude は `curl -o shot.png <shot_url>` で取得して Read する。
 */
export async function browserScreenshot(env: Env, session: string): Promise<ScreenshotResult> {
  return (await sendCommand(env, session, "screenshot", {})) as ScreenshotResult;
}

export interface EvalResult {
  /** Runtime.evaluate の returnByValue 結果。JSON 化可能な値 (文字列/数値/object 等) か null。 */
  value: unknown;
}

/**
 * session の拡張に JavaScript 式を Runtime.evaluate させ、結果値を返す。
 * text 取得は `document.body.innerText`、特定要素は querySelector の innerText 等。
 * PNG と違い値は小さいので /shot upload はせず { value } を直接返す。
 */
export async function browserEval(env: Env, session: string, expression: string): Promise<EvalResult> {
  if (typeof expression !== "string" || expression === "") {
    throw new CdpToolError("expression is required");
  }
  return (await sendCommand(env, session, "eval", { expression })) as EvalResult;
}

export interface StashResult {
  /** eval 結果を保存した一時 URL。`curl -o out.txt <stash_url>` で回収する (短命・無認証)。 */
  stash_url: string;
  /** 保存した byte 数。 */
  size_bytes: number;
  /** 保存時の Content-Type。 */
  content_type: string;
  /**
   * DO 内部での chunk 分割数。MAX_STASH_BYTES(1MiB) 超は複数行に分割保存されるが、
   * stash_url の GET 側が連結配信するので **回収は 1 回の curl で済む** (情報目的の値)。
   */
  n_parts: number;
}

/**
 * session の拡張で JS 式を評価し、結果文字列を DO に保存して回収用 URL を返す。
 * browser_eval と違い結果値そのものは MCP body に載せない。localStorage dump など
 * 大きな値を Claude の context を経由させずに `curl` でコンテナへ落とすための経路
 * (context に載せて Write で書き戻すと長大な base64 を逐語再生できず壊れるため)。
 * 取得は `curl -o /tmp/out.txt <stash_url>` (screenshot と同じく短命 / 無認証 / 予測不能 id)。
 * stash_url の組み立ては DO ではなくここで行う (RELAY_ORIGIN="" 時に DO の内部 origin を
 * 避けるため、公開 origin = relayOrigin(env) で組む)。
 */
export async function browserStash(
  env: Env,
  session: string,
  expression: string,
  contentType?: string,
): Promise<StashResult> {
  if (typeof session !== "string" || session === "") {
    throw new CdpToolError("session is required");
  }
  if (typeof expression !== "string" || expression === "") {
    throw new CdpToolError("expression is required");
  }
  const id = env.BROWSER_DO.idFromName(session);
  const stub = env.BROWSER_DO.get(id);
  const reqBody: Record<string, unknown> = { expression };
  if (typeof contentType === "string" && contentType !== "") reqBody.content_type = contentType;
  const res = await stub.fetch(DO_STASH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  const body = (await res.json()) as {
    id?: string;
    size_bytes?: number;
    content_type?: string;
    n_parts?: number;
    error?: string;
  };
  if (!res.ok || !body.id) {
    throw new CdpToolError(body.error ?? `stash_failed_${res.status}`);
  }
  return {
    stash_url: `${relayOrigin(env)}/shot/${encodeURIComponent(session)}/${body.id}`,
    size_bytes: body.size_bytes ?? 0,
    content_type: body.content_type ?? "text/plain; charset=utf-8",
    n_parts: body.n_parts ?? 1,
  };
}
