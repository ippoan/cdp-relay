import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * vitest を workerd 上 (@cloudflare/vitest-pool-workers) で動かす。
 * wrangler.toml をそのまま読ませて DO binding / migration / vars を共有し、
 * テスト用に RELAY_TOKEN を固定 + タイムアウトを短縮 + shot 配信オリジンを固定する。
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
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          compatibilityDate: "2025-05-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            // テスト用 token (test 側の TOKEN 定数と一致させる)。
            RELAY_TOKEN: "test-token",
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
