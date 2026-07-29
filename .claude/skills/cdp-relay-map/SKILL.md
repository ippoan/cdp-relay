---
name: cdp-relay-map
generated-from: cdp-relay:ee686eb15e124afbc380581f7f638901b40356fc
paths: [src/, extension/]
description: ippoan/cdp-relay (CCoW の隔離コンテナから手元 Chrome を CDP 操作する DO+WS リレー: MV3 拡張 + Cloudflare Worker+DO + stateless MCP) の構造ナビゲーション。session=idFromName の設計・stateless MCP を採用した経緯・fail-closed な RELAY_TOKEN 検証・browser_cookies による login 委譲 (credential を CCoW egress gateway の TLS MITM から守る手法) をまとめる。トリガー:「cdp-relay」「browser_cookies」「login 委譲」「CDP リレー」「BrowserSessionDO」「idFromName」「stateless MCP」「拡張 WS」「cdp-relay-map」等。
---

## CLAUDE.md から移設 (2026-07-06)

## 構成

| path | 役割 |
|---|---|
| `src/index.ts` | Worker エントリ。token 検証 + session (idFromName) で DO へ振り分け |
| `src/do/browser-session-do.ts` | `BrowserSessionDO`。拡張 WS hold + `/cmd` 往復 + `/shot` 保存配信 |
| `src/mcp/tools.ts` | MCP ツールの純粋ロジック (`browser_navigate` / `browser_screenshot` / `browser_eval` / `browser_stash` / `browser_cookies`) |
| `src/mcp/server.ts` | `createWorkerMcpV2` 配線 (MCP 2026-07-28 + legacy 両対応、`/mcp` 到達時のみ遅延 import。handler は module-scope 生成、inputSchema は `z.object` の Standard Schema) |
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

## login 委譲 (`browser_cookies`) — credential を CCoW に通さない検証

`browser_cookies` (CDP `Network.getCookies`) は「**login は手元ブラウザ、認証後の
操作は CCoW**」を成立させる tool (Refs ohishi-exp/dtako-scraper#22)。動機は
**CCoW の egress が Anthropic egress gateway で TLS MITM 終端される**こと — CCoW
コンテナから外部サイトへ TLS 接続すると証明書の issuer が
`O=Anthropic, CN=Egress Gateway SDS Issuing CA` になり (実測)、login POST の
credential は gateway 内で平文復号される。よって **credential を CCoW から送る限り
どの経路でも gateway を平文で通る**。

回避策: login (credential を使う部分) を手元ブラウザにやらせ、login 後の cookie
だけを CCoW が借りる。credential は「手元ブラウザ → サイト」= 手元マシンの egress
だけを通り、CCoW / gateway を一切通らない。

- **cookie は生値を tool 戻り値に載せない** — session capability (hijack 可) なので
  `browser_stash` と同じく shots に保存して `cookies_url` (= `/shot/{session}/{id}`)
  だけ返す。回収は `curl -o /tmp/cookies.json <cookies_url>`。
- **`urls` 必須** — 対象 origin に絞り、手元の全 cookie を吸い上げない。
- **検証範囲の限界**: この方式で検証できるのは「cookie での認証後操作」だけ。
  login 実装自体 (form/hidden/POST チェーン) は検証されない。login は最も壊れやすい
  箇所なので「認証後のみ検証、login は別途」と正直に扱うこと (手元 run / devtools
  Network 観察で別途検証)。
- `document.cookie` (eval) では HttpOnly cookie (JSESSIONID 等) が取れないため
  `Network.getCookies` が要る。cookie は揮発状態の read なので env vault 化とは別
  カテゴリ (何も at-rest 保存しない)。
