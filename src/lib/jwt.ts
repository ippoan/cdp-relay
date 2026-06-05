/**
 * 最小 HS256 MCP-JWT verifier — auth-worker が mint する形 (`src/lib/mcp-jwt.ts`)
 * に対応する。Web Crypto 自己完結で node 依存なし (ref-files-worker の
 * `src/lib/jwt.ts` と同実装)。/mcp の Claude Code 認証に使う。
 *
 * 検証する claim:
 *   - alg を HS256 に pin (header.alg を constant-time 比較)
 *   - signature を HMAC-SHA256 で再計算し constant-time 比較
 *   - aud ∈ expectedAudience (単値 or comma 区切り allowlist / string[])。`"*"`
 *     が含まれると aud check 自体を無効化する (= 任意 aud を受理)。claude.ai
 *     connector が可変 aud を mint し、shared secret 署名が auth-worker 由来を
 *     既に証明しているため。
 *   - exp > now (30s skew)
 *   - nbf <= now (30s skew、present 時のみ)
 *
 * 失敗は全経路 `JwtVerifyError` の coarse reason で返す (wire 応答が "bad
 * signature" と "expired" を message で区別できないようにする)。
 */

const SKEW_SECONDS = 30;

export interface McpJwtClaims {
  sub: string;
  github_login: string;
  scope: string;
  aud: string;
  exp: number;
  nbf?: number;
  iat?: number;
  iss?: string;
}

export class JwtVerifyError extends Error {
  constructor(public readonly reason: string) {
    super("jwt_verify_failed");
    this.name = "JwtVerifyError";
  }
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyMcpJwt(
  token: string,
  secret: string,
  expectedAudience: string | readonly string[],
): Promise<McpJwtClaims> {
  const allowedAudiences = (
    Array.isArray(expectedAudience) ? expectedAudience : String(expectedAudience).split(",")
  )
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtVerifyError("shape");
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(b64urlToString(headerB64));
  } catch {
    throw new JwtVerifyError("header_parse");
  }
  if (header.alg !== "HS256") throw new JwtVerifyError("alg");

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, signingInput));
  const actual = b64urlToBytes(sigB64);
  if (!constantTimeEqual(expected, actual)) throw new JwtVerifyError("signature");

  let claims: McpJwtClaims;
  try {
    claims = JSON.parse(b64urlToString(payloadB64));
  } catch {
    throw new JwtVerifyError("payload_parse");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < now) {
    throw new JwtVerifyError("expired");
  }
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_SECONDS > now) {
    throw new JwtVerifyError("not_yet_valid");
  }
  // `"*"` = 任意 aud を受理。shared HS256 secret が auth-worker 由来を既に証明して
  // おり、正規の identity は aud ではなく github_login。connector は可変 aud を
  // mint する (RFC 8707 resource URL か、無ければ ecosystem default
  // `github-mcp-server-rs`) ので固定 aud を pin すると正当な token を弾く。
  const anyAudience = allowedAudiences.includes("*");
  if (!anyAudience && (typeof claims.aud !== "string" || !allowedAudiences.includes(claims.aud))) {
    throw new JwtVerifyError("audience");
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new JwtVerifyError("sub");
  }
  if (typeof claims.github_login !== "string" || claims.github_login.length === 0) {
    throw new JwtVerifyError("github_login");
  }

  return claims;
}
