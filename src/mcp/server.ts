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
 *   - browser_eval(session, expression) … JS 式を評価して値 (text/DOM 等) を返す
 *   - browser_stash(session, expression) … JS 式の結果を保存し回収用 stash_url を返す
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
import {
  browserEval,
  browserNavigate,
  browserPair,
  browserScreenshot,
  browserStash,
  CdpToolError,
} from "./tools";

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
        "browser_pair",
        {
          description:
            "手元 Chrome の MV3 拡張をこの session にペアリングするための短命 pairing code を発行する。" +
            "返り値の `pair_string` (cdp1.… の 1 文字列) を拡張 popup の「接続文字列（1コピペ）」欄に貼るだけで " +
            "Relay URL / Session / Token が自動入力され接続まで走る (3 欄個別貼りも従来通り可)。" +
            "接続すると その session の DO に拡張 WS が合流し、以降 browser_navigate / browser_screenshot / browser_eval / browser_stash が使える。" +
            "pair_code は短命 (既定 15 分) で session 単位。静的 RELAY_TOKEN を人手で調べる代わりに使う。",
          inputSchema: {
            session: z
              .string()
              .optional()
              .describe("ペアリング先 session 名。省略時はランダム採番 (pair-xxxxxxxx)"),
            ttl_seconds: z
              .number()
              .optional()
              .describe("pair_code の有効秒数 (既定 900、最大 86400)"),
          },
        },
        async ({ session, ttl_seconds }: { session?: string; ttl_seconds?: number }) => {
          try {
            return ok(await browserPair(env, session, ttl_seconds));
          } catch (e) {
            return fail(e);
          }
        },
      );

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

      server.registerTool(
        "browser_eval",
        {
          description:
            "手元 Chrome の現在ページで JavaScript 式を評価し結果値を返す。" +
            "text 取得は `document.body.innerText`、特定要素は `document.querySelector('sel')?.innerText` 等。" +
            "PNG と違い値は小さいので shot_url ではなく { value } を直接返す。" +
            "拡張が未接続なら extension_not_connected エラー。",
          inputSchema: {
            session: z.string().describe("拡張接続の session 名"),
            expression: z.string().describe("評価する JavaScript 式"),
          },
        },
        async ({ session, expression }: { session: string; expression: string }) => {
          try {
            return ok(await browserEval(env, session, expression));
          } catch (e) {
            return fail(e);
          }
        },
      );

      server.registerTool(
        "browser_stash",
        {
          description:
            "手元 Chrome で JavaScript 式を評価し、結果 (文字列) を一時保存して回収用 URL を返す。" +
            "browser_eval と違い結果値を MCP body に載せないので、localStorage dump や gzip+base64 等の " +
            "大きな値を Claude の context を経由させず `curl -o /tmp/out.txt <stash_url>` でコンテナに落とせる " +
            "(context 経由 + Write だと長大な base64 を逐語再生できず壊れる)。stash_url は短命 (既定 5 分) / " +
            "無認証 (予測不能 id)。文字列以外を返す式は JSON 文字列化して保存する。" +
            "**大きな値 (1MiB 超) は DO 内部で自動 chunk 分割保存され、stash_url の GET が連結配信するので " +
            "回収は単一 URL の `curl -o` 1 回で済む** (手動 substr 分割は不要、最大 64MiB)。" +
            "拡張未接続なら extension_not_connected。",
          inputSchema: {
            session: z.string().describe("拡張接続の session 名"),
            expression: z
              .string()
              .describe("評価する JavaScript 式 (大きな文字列/JSON を返すこと)"),
            content_type: z
              .string()
              .optional()
              .describe("保存時の Content-Type (既定 text/plain; charset=utf-8)"),
          },
        },
        async ({
          session,
          expression,
          content_type,
        }: {
          session: string;
          expression: string;
          content_type?: string;
        }) => {
          try {
            return ok(await browserStash(env, session, expression, content_type));
          } catch (e) {
            return fail(e);
          }
        },
      );
    },
  });

  return handler(request, env);
}
