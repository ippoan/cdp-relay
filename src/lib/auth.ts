/**
 * 認証 helper。endpoint ごとに方式が違う:
 *   - /ext (ブラウザ拡張 WS) + /shot PUT → shared secret RELAY_TOKEN (constant-time)
 *   - /mcp (Claude Code)             → MCP-JWT (HS256、MCP_JWT_SECRET で検証、ref-files と同方式)
 * CDP は無認証なのでこれらが唯一の関門。未設定時は fail-closed (= スキップしない)。
 */
import type { Env, SecretsStoreBinding } from "../env";
import { verifyMcpJwt, JwtVerifyError } from "./jwt";

/**
 * 2 文字列を constant-time で比較する。
 *
 * Workers には timingSafeEqual が無いので、両者を HMAC-SHA256 で固定長 (32B) に
 * してから XOR 比較する。これで長さ差・値差のどちらもタイミングからリークしない
 * (鍵は固定文言で良い — 目的は長さ秘匿のための撹拌であって MAC ではない)。
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode("cdp-relay-token-compare"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [ma, mb] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  const va = new Uint8Array(ma);
  const vb = new Uint8Array(mb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export type TokenCheck = "ok" | "not_configured" | "missing_token" | "bad_token";

/**
 * request が提示する token (?token= か Authorization: Bearer) を RELAY_TOKEN と
 * 照合する。query を優先する (ブラウザの WebSocket API は custom header を付けら
 * れないため拡張は ?token= を使う。MCP クライアントは header を使える)。
 */
/** CF Secrets Store binding (.get()) か plain string (test) から secret 値を解決する。 */
async function resolveSecret(value: SecretsStoreBinding | string | undefined): Promise<string> {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : ((await value.get()) ?? "");
}

export async function checkToken(req: Request, env: Env): Promise<TokenCheck> {
  const configured = await resolveSecret(env.RELAY_TOKEN);
  if (configured === "") return "not_configured";

  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("token") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  const fromHeader = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const presented = fromQuery || fromHeader;

  if (!presented) return "missing_token";
  return (await timingSafeEqual(presented, configured)) ? "ok" : "bad_token";
}

export type McpJwtCheck = "ok" | "not_configured" | "missing_bearer" | "bad_token";

/**
 * /mcp 用 MCP-JWT 検証。`Authorization: Bearer <jwt>` を MCP_JWT_SECRET
 * (= auth-worker 署名鍵 INTERNAL_SHARED_SECRET) で HS256 検証する。aud は
 * MCP_JWT_AUDIENCE (既定 "*" = aud 不問)。ref-files-worker と同方式。
 */
export async function checkMcpJwt(req: Request, env: Env): Promise<McpJwtCheck> {
  const header = req.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return "missing_bearer";
  const token = header.slice("Bearer ".length).trim();
  if (!token) return "missing_bearer";

  const secret = await resolveSecret(env.MCP_JWT_SECRET);
  if (secret === "") return "not_configured";

  const audience =
    env.MCP_JWT_AUDIENCE && env.MCP_JWT_AUDIENCE !== "" ? env.MCP_JWT_AUDIENCE : "*";
  try {
    await verifyMcpJwt(token, secret, audience);
    return "ok";
  } catch (e) {
    if (e instanceof JwtVerifyError) return "bad_token";
    throw e;
  }
}
