/**
 * 認証 helper。endpoint ごとに方式が違う:
 *   - /ext (ブラウザ拡張 WS) + /shot PUT → shared secret RELAY_TOKEN (constant-time)
 *   - /mcp (Claude Code)             → MCP-JWT (HS256、MCP_JWT_SECRET で検証、ref-files と同方式)
 * CDP は無認証なのでこれらが唯一の関門。未設定時は fail-closed (= スキップしない)。
 *
 * crypto primitives (timingSafeEqual / HS256 verify / resolveSecret) は
 * `@ippoan/mcp-cf-workers` の `./auth` export を消費する (Refs ippoan/mcp-cf-workers#46
 * — 手動 sync コピーの解消)。ローカル検証戦略そのもの (introspect round-trip 回避)
 * は本 repo の設計判断として維持。
 */
import {
  timingSafeEqual,
  resolveSecret,
  verifyHs256Jwt,
  Hs256JwtError,
  type Hs256BaseClaims,
} from "@ippoan/mcp-cf-workers/auth";
import type { Env } from "../env";

// RELAY_TOKEN 比較に使う constant-time 比較 (長さも秘匿)。index.ts / テストが
// 本 module 経由で参照するため re-export する。
export { timingSafeEqual };

/** auth-worker が mint する MCP-JWT の claim 形 (github_login が正規 identity)。 */
export interface McpJwtClaims extends Hs256BaseClaims {
  sub: string;
  github_login: string;
  scope: string;
  aud: string;
}

export type TokenCheck = "ok" | "not_configured" | "missing_token" | "bad_token";

/**
 * request が提示する token (?token= か Authorization: Bearer) を RELAY_TOKEN と
 * 照合する。query を優先する (ブラウザの WebSocket API は custom header を付けら
 * れないため拡張は ?token= を使う。MCP クライアントは header を使える)。
 */
export async function checkToken(req: Request, env: Env): Promise<TokenCheck> {
  const configured = (await resolveSecret(env.RELAY_TOKEN)) ?? "";
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
 * MCP_JWT_AUDIENCE (既定 "*" = aud 不問 — connector が可変 aud を mint し、
 * shared secret 署名が auth-worker 由来を既に証明しているため)。
 * sub / github_login の必須チェックは validateClaims hook で行う。
 */
export async function checkMcpJwt(req: Request, env: Env): Promise<McpJwtCheck> {
  const header = req.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return "missing_bearer";
  const token = header.slice("Bearer ".length).trim();
  if (!token) return "missing_bearer";

  const secret = await resolveSecret(env.MCP_JWT_SECRET);
  if (!secret) return "not_configured";

  const audience =
    env.MCP_JWT_AUDIENCE && env.MCP_JWT_AUDIENCE !== "" ? env.MCP_JWT_AUDIENCE : "*";
  try {
    await verifyHs256Jwt<McpJwtClaims>(token, secret, {
      audience,
      validateClaims: (c) =>
        typeof c.sub === "string" &&
        c.sub.length > 0 &&
        typeof c.github_login === "string" &&
        c.github_login.length > 0,
    });
    return "ok";
  } catch (e) {
    if (e instanceof Hs256JwtError) return "bad_token";
    throw e;
  }
}
