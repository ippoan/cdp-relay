/**
 * MCP transport 配線。
 *
 * @ippoan/mcp-cf-workers の `createWorkerMcp` (stateless Streamable HTTP) に
 * ツールを登録するだけの薄い 1 枚。実ロジックは `./tools` の純粋関数に置き、
 * ここはそれを MCP ツールとして公開するアダプタに徹する。
 *
 * 提供ツール:
 *   - browser_navigate(session, url) … 手元 Chrome を url に遷移させる
 *   - browser_screenshot(session)    … viewport を撮って shot_url を返す
 *
 * 設計判断 (なぜ stateless + 自前 DO で durable McpAgent ではないか): tool セットは
 * 固定なので listChanged 不要。durable の McpAgent は WS transport を内部で握るため
 * 「拡張用の別 WS (/ext)」を同居させにくい (Refs ippoan/mcp-cf-workers#28 / #6 / #12)。
 *
 * SDK (+ ajv) は workers-pool テスト loader と相性が悪いため、このモジュールは
 * `index.ts` から `/mcp` 到達時のみ遅延 import される。ロジックは `tools.ts` を直接テスト。
 */
import { createWorkerMcp } from "@ippoan/mcp-cf-workers";
import { z } from "zod";
import type { Env } from "../env";
import { browserNavigate, browserScreenshot, CdpToolError } from "./tools";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function fail(e: unknown): ToolResult {
  const message = e instanceof CdpToolError ? e.message : String(e);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** `/mcp` に mount する stateless ハンドラ。 */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const handler = createWorkerMcp<Env>({
    name: "cdp-relay",
    version: "0.1.0",
    registerTools: (server) => {
      server.registerTool(
        "browser_navigate",
        {
          description:
            "手元 Chrome (cdp-relay MV3 拡張が接続している session) を指定 URL に遷移させる。" +
            "url は http:// または https:// で始まること。拡張が Page.navigate を実行し、" +
            "load 完了後に { url } を返す。拡張が未接続なら extension_not_connected エラー。",
          inputSchema: {
            session: z.string().describe("拡張接続の session 名 (pair flow で手元に渡したもの)"),
            url: z.string().describe("遷移先 URL (http(s) のみ)"),
          },
        },
        async ({ session, url }: { session: string; url: string }) => {
          try {
            return ok(await browserNavigate(env, session, url));
          } catch (e) {
            return fail(e);
          }
        },
      );

      server.registerTool(
        "browser_screenshot",
        {
          description:
            "手元 Chrome の現在の viewport を PNG で撮る。PNG 本体は MCP に載せず " +
            "(token 浪費回避)、{ shot_url } だけを返す。取得は `curl -o /tmp/shot.png <shot_url>` → Read。" +
            "shot_url は短命 (既定 5 分)。拡張が未接続なら extension_not_connected エラー。",
          inputSchema: {
            session: z.string().describe("拡張接続の session 名"),
          },
        },
        async ({ session }: { session: string }) => {
          try {
            return ok(await browserScreenshot(env, session));
          } catch (e) {
            return fail(e);
          }
        },
      );
    },
  });

  return handler(request, env);
}
