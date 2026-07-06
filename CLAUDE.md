# CLAUDE.md

CCoW の隔離コンテナから手元 Chrome を CDP 操作する DO+WS リレー (MV3 拡張 +
Cloudflare Worker+DO + stateless MCP)。

このリポジトリで Claude Code セッションを動かす時の作業ガイド。共通項は
[ippoan/claude-md](https://github.com/ippoan/claude-md) の `CLAUDE.md.template` に従う。
詳細 (アーキテクチャ・経緯・gotcha) は `cdp-relay-map` skill を参照。

## まず読むもの

- [`README.md`](./README.md) — アーキテクチャ / エンドポイント / 拡張ロード手順 / security
- 引継ぎ issue [ippoan/mcp-cf-workers#28](https://github.com/ippoan/mcp-cf-workers/issues/28) — 設計の根拠

## secret

- **secret を会話 / log / tool param に出さない**。`secret-inject` skill で `RELAY_TOKEN` を投入。

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
