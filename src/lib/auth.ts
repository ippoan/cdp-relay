/**
 * shared secret (RELAY_TOKEN) の検証。
 *
 * CDP は無認証なので RELAY_TOKEN が唯一の関門 (漏れたら任意 JS eval = ブラウザ
 * 乗っ取り)。比較は constant-time で行い、未設定時は fail-closed (= スキップしない)。
 */
import type { Env } from "../env";

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
export async function checkToken(req: Request, env: Env): Promise<TokenCheck> {
  const configured = env.RELAY_TOKEN;
  if (!configured || configured === "") return "not_configured";

  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("token") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  const fromHeader = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const presented = fromQuery || fromHeader;

  if (!presented) return "missing_token";
  return (await timingSafeEqual(presented, configured)) ? "ok" : "bad_token";
}
