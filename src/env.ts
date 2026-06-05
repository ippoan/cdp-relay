/**
 * Worker / DO の binding と設定値。
 *
 * 設定値は wrangler.toml の [vars] で渡し、ここで数値化する (ハードコードしない)。
 * RELAY_TOKEN は secret (拡張 WS と MCP の唯一の関門)。
 */
export interface Env {
  BROWSER_DO: DurableObjectNamespace;

  // ─── secret ───
  /** 拡張 (/ext) と MCP (/mcp) の shared secret。未設定なら全 reject (fail-closed)。 */
  RELAY_TOKEN?: string;

  // ─── 設定値 (文字列 vars。未設定なら下の default) ───
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
