import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * vitest を workerd 上 (@cloudflare/vitest-pool-workers) で動かす。
 *
 * wrangler.toml は **読み込まない** (`wrangler.configPath` を使わない): wrangler.toml の
 * `secrets_store_secrets` (RELAY_TOKEN) を load すると miniflare が Secrets Store を
 * 解決しようとして "Secret not found" になるため。代わりに DO / vars / secret を
 * miniflare options に直書きし、RELAY_TOKEN は **plain string binding** として inject
 * する (本番は CF Secrets Store binding、テストは string — HealthConnectReaderWorker と
 * 同方式。src/lib/auth.ts の resolveRelayToken が両形を解決する)。
 */
export default defineWorkersConfig({
  test: {
    coverage: {
      // v8 coverage は vitest-pool-workers (workerd isolate) と相性が悪い。
      // istanbul はソースレベル instrument なので workerd 内まで通る。
      provider: "istanbul",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      // src/env.ts は型/設定のみ。src/mcp/server.ts は MCP SDK 配線で、SDK が
      // ajv の JSON-module require で workers-pool loader を壊すため pool では
      // 踏めない (ロジックは src/mcp/tools.ts を直接テスト)。
      exclude: ["src/env.ts", "src/mcp/server.ts"],
    },
    poolOptions: {
      workers: {
        // SQLite-backed DO の per-test 隔離ストレージは sqlite-shm/wal の
        // stack-frame pop に失敗する既知問題があるため無効化する。各テストは
        // ユニークな session (idFromName) を採番するのでテスト間で干渉しない。
        isolatedStorage: false,
        // worker entry (wrangler.toml は読まない、上の doc 参照)。
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2025-05-01",
          compatibilityFlags: ["nodejs_compat"],
          // BrowserSessionDO は ctx.storage.sql を使うので SQLite-backed で起こす。
          durableObjects: {
            BROWSER_DO: { className: "BrowserSessionDO", useSQLite: true },
          },
          bindings: {
            // テスト用 token (test 側の TOKEN 定数と一致させる)。本番は CF Secrets
            // Store binding だが、テストでは plain string を inject する。
            RELAY_TOKEN: "test-token",
            // /mcp の MCP-JWT 検証鍵 (test 側で同値で JWT を mint する)。
            MCP_JWT_SECRET: "test-mcp-jwt-secret",
            MCP_JWT_AUDIENCE: "*",
            // timeout テストを高速化 (本番 default は 30s)。
            CMD_TIMEOUT_MS: "300",
            SHOT_TTL_SECONDS: "300",
            // shot_url を予測可能にする配信オリジン。
            RELAY_ORIGIN: "https://cdp-relay.test",
          },
        },
      },
    },
  },
});
