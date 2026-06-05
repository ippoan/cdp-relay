/**
 * Worker / DO の binding と設定値。
 *
 * 設定値は wrangler.toml の [vars] で渡し、ここで数値化する (ハードコードしない)。
 * secret は RELAY_TOKEN (拡張 WS /ext + /shot PUT) と MCP_JWT_SECRET (/mcp の
 * MCP-JWT 検証) の 2 系統。
 */
/** CF Secrets Store binding (`secrets_store_secrets`)。`.get()` で値を取る。 */
export type SecretsStoreBinding = { get(): Promise<string> };

export interface Env {
  BROWSER_DO: DurableObjectNamespace;

  // ─── secrets (CF Secrets Store binding。本番は .get()、テストは plain string inject) ───
  /**
   * 拡張 WS (/ext) + screenshot 投入 (/shot PUT) の shared secret。ブラウザ拡張は
   * MCP-JWT を mint できないので shared secret で受ける。未設定なら fail-closed。
   */
  RELAY_TOKEN?: SecretsStoreBinding | string;
  /**
   * /mcp (Claude Code) の MCP-JWT 検証鍵。auth-worker が MCP-JWT を署名する
   * INTERNAL_SHARED_SECRET と同値を bind する (ref-files-worker と同方式)。これで
   * /mcp は ippoan 標準の MCP-JWT 認証になり hook の自動 attach に乗る。
   */
  MCP_JWT_SECRET?: SecretsStoreBinding | string;

  // ─── 設定値 (文字列 vars。未設定なら下の default) ───
  /** /mcp で受理する MCP-JWT の aud。"*" で aud 不問 (connector が可変 aud を mint)。 */
  MCP_JWT_AUDIENCE?: string;
  /**
   * 401 の WWW-Authenticate が指す auth-worker origin (RFC 9728 resource_metadata)。
   * claude.ai connector がここから AS を auto-discover して OAuth/DCR する。ippoan
   * auth-worker は staging 運用なので既定 auth-staging。
   */
  AUTH_WORKER_ORIGIN?: string;
  /** /cmd 1 往復のタイムアウト (ms)。 */
  CMD_TIMEOUT_MS?: string;
  /** screenshot 一時保存の TTL (秒)。 */
  SHOT_TTL_SECONDS?: string;
  /** shot_url を組み立てる公開オリジン。空ならリクエスト元。 */
  RELAY_ORIGIN?: string;
}

export interface Settings {
  /** /cmd 1 往復のタイムアウト (ms)。 */
  cmdTimeoutMs: number;
  /** screenshot 一時保存の TTL (秒)。 */
  shotTtlSeconds: number;
}

const DEFAULTS: Settings = {
  cmdTimeoutMs: 30_000,
  shotTtlSeconds: 300,
};

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function settings(env: Env): Settings {
  return {
    cmdTimeoutMs: num(env.CMD_TIMEOUT_MS, DEFAULTS.cmdTimeoutMs),
    shotTtlSeconds: num(env.SHOT_TTL_SECONDS, DEFAULTS.shotTtlSeconds),
  };
}
