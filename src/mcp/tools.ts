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

/** DO 内部の /cmd は実際の host を使わない (idFromName で stub を引くため固定で良い)。 */
const DO_CMD_URL = "https://cdp-relay.internal/cmd";

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
