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
const DO_COOKIES_URL = "https://cdp-relay.internal/cookies";

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
  /**
   * relay_url / session / pair_code を 1 つに encode した「接続文字列」(`cdp1.<base64url>`)。
   * 拡張 popup の「接続文字列（1コピペ）」欄に貼ると 3 欄が自動入力され接続まで走る。
   * 中身は 3 値と同じ (pair_code は会話可・短命) なので会話に出してよい。
   */
  pair_string: string;
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
  const { session: s, code, expiresInSeconds } = await mintPairCode(env, session, ttlSeconds);
  const relay = relayOrigin(env);
  return {
    session: s,
    pair_code: code,
    expires_in_seconds: expiresInSeconds,
    relay_url: relay,
    pair_string: packPairString(relay, s, code),
  };
}

/**
 * session の DO に短命 pairing code を mint させる共通処理
 * (browser_pair / browser_cdp_endpoint / browser_mcp_endpoint が共有)。
 * session 省略時は `pair-xxxxxxxx` を採番する。
 */
async function mintPairCode(
  env: Env,
  session?: string,
  ttlSeconds?: number,
): Promise<{ session: string; code: string; expiresInSeconds: number }> {
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
  return { session: s, code: body.pair_code, expiresInSeconds: body.expires_in_seconds ?? 0 };
}

/**
 * relay_url / session / pair_code を 1 コピペ用の 1 文字列に pack する。
 * 形式は `cdp1.<base64url(JSON{r,s,t[,m]})>`。拡張 popup 側が同形式を decode して欄を埋める。
 * `mode` を渡すと `m` を載せ、拡張がその接続モードを自動選択する
 * ("cdp" = chrome-devtools-mcp passthrough。省略時は curated ext モード)。
 * pair_code は短命・session スコープなので会話に出してよい (RELAY_TOKEN とは別物)。
 */
function packPairString(relay: string, session: string, code: string, mode?: string): string {
  const payload: Record<string, string> = { r: relay, s: session, t: code };
  if (mode) payload.m = mode;
  const json = JSON.stringify(payload);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return "cdp1." + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** relayOrigin(env) を wss:// (ws://) base に正規化する (cdp passthrough の wsEndpoint 用)。 */
function relayWssBase(env: Env): string {
  const o = relayOrigin(env);
  if (o.startsWith("https://")) return "wss://" + o.slice("https://".length);
  if (o.startsWith("http://")) return "ws://" + o.slice("http://".length);
  return o;
}

export interface CdpEndpointResult {
  /** ペアリング先 session 名 (省略時に採番されたもの)。bridge / mcp で同じ値を使う。 */
  session: string;
  /** bridge 脚 / client 脚の両方を通す短命 pairing code (= wsEndpoint / bridge に渡す token)。 */
  pair_code: string;
  /** pair_code の有効秒数。 */
  expires_in_seconds: number;
  /** cdp-relay の公開 origin。 */
  relay_url: string;
  /** chrome-devtools-mcp の `--wsEndpoint` にそのまま渡す値 (token を ?token= に埋め込み済み)。 */
  ws_endpoint: string;
  /** 手元で走らせる bridge 起動コマンド (Chrome を --remote-debugging-port=9222 で起動済み前提)。 */
  bridge_command: string;
  /** CCoW でそのまま叩ける chrome-devtools-mcp 起動コマンド。 */
  chrome_devtools_mcp_command: string;
  /**
   * cdp-relay MV3 拡張の「接続文字列（1コピペ）」欄に貼る 1 文字列 (`cdp1.…`、mode=cdp)。
   * これを貼ると拡張が **CDP passthrough モード**で接続し、手元の `node bridge` が不要になる
   * (拡張の Service Worker が実 Chrome :9222 ⇄ cdp-relay を直接パイプする)。
   * この場合 Chrome は
   * `--remote-debugging-port=9222 --remote-allow-origins=chrome-extension://<拡張 id>` で起動する
   * (この起動フラグは拡張 popup が CDP passthrough ON 時にコピー可能な形で表示。`*` は全 origin
   * 許可 = デバッグポート乗っ取りに繋がるため使わない)。
   */
  pair_string: string;
}

/**
 * chrome-devtools-mcp を cdp-relay 経由で手元 Chrome に繋ぐための一式を発行する。
 *
 * 現行の curated tool (browser_navigate/eval/…) が chrome.debugger のタブ単位 CDP を
 * 厳選 verb で叩くのに対し、こちらは **生 CDP passthrough**: 手元 bridge が実 Chrome の
 * browser-level CDP (`--remote-debugging-port=9222`) を cdp-relay の `/cdpbridge/{session}`
 * に outbound WSS で繋ぎ、CCoW の chrome-devtools-mcp は `--wsEndpoint`
 * (`wss://…/cdp/{session}/devtools/browser?token=…`) で client 脚として合流する。DO は 2 脚を
 * 無加工でパイプするだけ。これで chrome-devtools-mcp の全ツールが手元ブラウザに効く。
 *
 * pair_code は browser_pair と同じ短命 (既定 15 分)・session スコープの capability。
 * bridge 脚・client 脚の両方の認証に使う。手順:
 *   1. 手元 Chrome を `--remote-debugging-port=9222` で起動
 *   2. 手元で bridge_command を実行
 *   3. CCoW で chrome_devtools_mcp_command を実行
 */
export async function browserCdpEndpoint(
  env: Env,
  session?: string,
  ttlSeconds?: number,
): Promise<CdpEndpointResult> {
  const { session: s, code, expiresInSeconds } = await mintPairCode(env, session, ttlSeconds);
  const relay = relayOrigin(env);
  const wsEndpoint = `${relayWssBase(env)}/cdp/${encodeURIComponent(s)}/devtools/browser?token=${encodeURIComponent(code)}`;
  return {
    session: s,
    pair_code: code,
    expires_in_seconds: expiresInSeconds,
    relay_url: relay,
    ws_endpoint: wsEndpoint,
    bridge_command: `node bridge/cdp-bridge.mjs --session ${s} --token ${code}`,
    chrome_devtools_mcp_command: `npx chrome-devtools-mcp@latest --wsEndpoint "${wsEndpoint}"`,
    pair_string: packPairString(relay, s, code, "cdp"),
  };
}

export interface McpEndpointResult {
  /** ペアリング先 session 名 (省略時に採番されたもの)。bridge / シムで同じ値を使う。 */
  session: string;
  /** bridge 脚 / client 脚の両方を通す短命 pairing code。 */
  pair_code: string;
  /** pair_code の有効秒数。 */
  expires_in_seconds: number;
  /** cdp-relay の公開 origin。 */
  relay_url: string;
  /** CCoW 側シム (`mcp-stdio-shim.mjs --url`) に渡す client 脚 WS URL (token 埋め込み済み)。 */
  ws_endpoint: string;
  /** 手元で走らせる bridge 起動コマンド (Chrome を --remote-debugging-port=9222 + 非デフォルト --user-data-dir で起動済み前提)。 */
  bridge_command: string;
  /** repo clone が無い手元マシン向け: raw 1 ファイルを curl して起動する bootstrap コマンド (#83)。 */
  bootstrap_command: string;
  /**
   * 拡張 popup の「接続文字列（1コピペ）」欄に貼る 1 文字列 (`cdp1.…`、mode=mcp)。
   * cdp-agent (MSI) 導入済みなら、貼ると popup に「MCP bridge 起動」ボタンが出て
   * nmhost 経由で bridge が起動する (node clone 不要。npx は必要)。
   */
  pair_string: string;
  /** CCoW でそのまま叩ける MCP server 登録コマンド (次 session から有効)。 */
  claude_mcp_add_command: string;
}

/**
 * MCP passthrough (Refs #81) の一式を発行する。生 CDP passthrough (`browser_cdp_endpoint`)
 * が 1 ツール呼び出し = CDP 4〜5 往復 (太平洋横断 ~236ms/往復 → warm ~1.1s) なのに対し、
 * こちらは chrome-devtools-mcp を **手元で** spawn し MCP JSON-RPC (1 ツール = 1 往復) だけを
 * relay するので ~0.3s/call (約 4 倍)。
 *
 * 手順:
 *   1. 手元 Chrome を `--remote-debugging-port=9222 --user-data-dir=<非デフォルト>` で起動
 *      (Chrome 136+ はデフォルト profile への debug port を無視する)
 *   2. 手元で bridge_command (`node bridge/cdp-bridge.mjs --mcp …`) を実行
 *      (node 必須 — 拡張 SW はプロセスを spawn できないため拡張だけでは完結しない)
 *   3. CCoW で claude_mcp_add_command を実行 (次 session から chrome-devtools-mcp の
 *      全ツールが手元ブラウザに効く)
 */
export async function browserMcpEndpoint(
  env: Env,
  session?: string,
  ttlSeconds?: number,
): Promise<McpEndpointResult> {
  const { session: s, code, expiresInSeconds } = await mintPairCode(env, session, ttlSeconds);
  const relay = relayOrigin(env);
  const wsEndpoint = `${relayWssBase(env)}/mcppipe/${encodeURIComponent(s)}?token=${encodeURIComponent(code)}`;
  return {
    session: s,
    pair_code: code,
    expires_in_seconds: expiresInSeconds,
    relay_url: relay,
    ws_endpoint: wsEndpoint,
    bridge_command: `node bridge/cdp-bridge.mjs --mcp --session ${s} --token ${code}`,
    bootstrap_command:
      `curl -O https://raw.githubusercontent.com/ippoan/cdp-relay/main/bridge/cdp-bridge.mjs && ` +
      `node cdp-bridge.mjs --mcp --session ${s} --token ${code}`,
    pair_string: packPairString(relay, s, code, "mcp"),
    claude_mcp_add_command: `claude mcp add chrome-local -- node bridge/mcp-stdio-shim.mjs --url "${wsEndpoint}"`,
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

export interface CookiesResult {
  /**
   * cookie 配列 (`{ cookies: [...] }` JSON) を保存した一時 URL。
   * `curl -o /tmp/cookies.json <cookies_url>` で回収する (短命・予測不能 id)。
   * cookie 生値は MCP body に載せない (session hijack token を context に残さないため)。
   */
  cookies_url: string;
  /** 保存した byte 数。 */
  size_bytes: number;
  /** 保存時の Content-Type (application/json)。 */
  content_type: string;
}

/**
 * 手元 Chrome の cookie を **対象 origin (urls) に絞って** 取得し、DO に保存して
 * 回収用 URL を返す (Network.getCookies なので HttpOnly な JSESSIONID も取れる)。
 *
 * 用途 (Refs ohishi-exp/dtako-scraper#22): 手元ブラウザでサイトに login した後の
 * session cookie を CCoW 側が借り、login (credential を使う部分) をスキップして
 * 認証後の操作を回す。credential は「手元ブラウザ → サイト」= 手元マシンの egress
 * だけを通り、CCoW / Anthropic egress gateway を一切通らない (= gateway の TLS MITM
 * 終端で credential が平文復号される問題を回避する)。
 *
 * cookie は credential より下位 tier (session capability、失効する) だが hijack 可
 * なので、生値は戻り値に載せず stash と同じ id 回収経路に固定する。urls は必須
 * (対象 origin に絞り、手元の全 cookie を吸い上げない)。
 */
export async function browserCookies(
  env: Env,
  session: string,
  urls: string[],
): Promise<CookiesResult> {
  if (typeof session !== "string" || session === "") {
    throw new CdpToolError("session is required");
  }
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new CdpToolError("urls is required (etc-meisai.jp 等の対象 origin に絞ること)");
  }
  const id = env.BROWSER_DO.idFromName(session);
  const stub = env.BROWSER_DO.get(id);
  const res = await stub.fetch(DO_COOKIES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
  });
  const body = (await res.json()) as {
    id?: string;
    size_bytes?: number;
    content_type?: string;
    error?: string;
  };
  if (!res.ok || !body.id) {
    throw new CdpToolError(body.error ?? `cookies_failed_${res.status}`);
  }
  return {
    cookies_url: `${relayOrigin(env)}/shot/${encodeURIComponent(session)}/${body.id}`,
    size_bytes: body.size_bytes ?? 0,
    content_type: body.content_type ?? "application/json; charset=utf-8",
  };
}
