# CLAUDE.md

CCoW の隔離コンテナから手元 Chrome を CDP 操作する DO+WS リレー (MV3 拡張 +
Cloudflare Worker+DO + stateless MCP)。

このリポジトリで Claude Code セッションを動かす時の作業ガイド。共通項は
[ippoan/claude-md](https://github.com/ippoan/claude-md) の `CLAUDE.md.template` に従う。

## まず読むもの

- [`README.md`](./README.md) — アーキテクチャ / エンドポイント / 拡張ロード手順 / security
- 引継ぎ issue [ippoan/mcp-cf-workers#28](https://github.com/ippoan/mcp-cf-workers/issues/28) — 設計の根拠

## 構成

| path | 役割 |
|---|---|
| `src/index.ts` | Worker エントリ。token 検証 + session (idFromName) で DO へ振り分け |
| `src/do/browser-session-do.ts` | `BrowserSessionDO`。拡張 WS hold + `/cmd` 往復 + `/shot` 保存配信 |
| `src/mcp/tools.ts` | MCP ツールの純粋ロジック (`browser_navigate` / `browser_screenshot` / `browser_eval`) |
| `src/mcp/server.ts` | `createWorkerMcp` 配線 (`/mcp` 到達時のみ遅延 import) |
| `src/lib/auth.ts` | `RELAY_TOKEN` の constant-time 検証 |
| `src/env.ts` | binding + 設定値 (vars から数値化) |
| `extension/` | MV3 拡張 (manifest / background SW / popup)。手元 Chrome に load する |

## 設計上の要点 (触る前に)

- **session = `idFromName(session)`**。拡張 (`/ext/{session}`) と MCP tool が同じ session 名を
  使えば同じ DO に集まる。ui-preview の `idFromString`/`newUniqueId` とは異なる。
- **stateless MCP + 自前 DO** を採用 (durable `McpAgent` ではない)。tool 固定 = `listChanged`
  不要。durable は WS transport を内部で握り「拡張用の別 WS」を同居させにくい (issue #28)。
- **fail-closed**: `RELAY_TOKEN` 未設定なら全 reject。CDP は無認証なので token が唯一の関門。
- `/cmd` の pending Map は in-memory で良い。/cmd の Promise 待ち中は DO がアクティブなので
  WS 往復は同一インスタンスで閉じる (hibernate しない)。
- **secret を会話 / log / tool param に出さない**。`secret-inject` skill で `RELAY_TOKEN` を投入。
- **CCoW 内で cloudflared (cf tunnel) を立てて公開 URL から繋ぐ案は却下済み** (#10)。cloudflared は edge に UDP/TCP 7844 で接続するが CCoW egress は TCP/443 のみ。`HTTPS_PROXY` 経由の edge 接続も未対応。「拡張 → WSS/443 → Worker+DO」の dial-out 形が唯一通る。

## ビルド / テスト

PR を出す前に手元で green に:

```sh
npm run typecheck
npm test
```

CCoW / ローカルで GitHub Packages read token が無い時は `npm install ../mcp-cf-workers` で
clone を file: link してから (`package-lock.json` は commit しない = `.gitignore` 済み)。

CI (`.github/workflows/ci.yml`) は `main` への PR ごとに ci-workflows の `frontend-ci.yml`
(project_type: worker, npm_scope:'@ippoan') で同じことを回す。

## GitHub 自動化 (重要)

- **`main` に直 push しない。** PR を作る。
- PR / commit は `Refs #N` を使う (`Closes/Fixes/Resolves` は禁止 — auto-close 防止)。
- `mcp__github__enable_pr_auto_merge` を reflex で呼ばない (user 明示指示時のみ)。
- PR 作成後は同じ turn で `mcp__github__subscribe_pr_activity` を呼び CI を watch する。

---

_共通項を直すときは [`ippoan/claude-md`](https://github.com/ippoan/claude-md) の
`CLAUDE.md.template` を更新すること。_
