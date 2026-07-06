# plan: chrome-devtools-mcp を cdp-relay 経由で手元 Chrome に繋ぐ (raw CDP passthrough)

CCoW の chrome-devtools-mcp から、cdp-relay を経由して手元 Chrome を **生 CDP** で
操作できるようにする。既存の curated tool (`browser_navigate` / `browser_eval` …)
とは別ルートの「透過 CDP passthrough」を追加する。

## 動機

- `chrome-devtools-mcp` は puppeteer で **browser-level の生 CDP エンドポイント**
  (`--wsEndpoint = ws://…/devtools/browser/<id>`、Target/Browser ドメイン + flatten
  session) を要求する。
- 現行 cdp-relay の拡張は `chrome.debugger` (タブ単位) で `navigate/screenshot/eval/
  cookies` の **厳選 verb** しか話さず、browser-level エンドポイントを出せない。
- → chrome-devtools-mcp の**全ツール**を手元ブラウザに効かせるには、実 Chrome の
  browser-level CDP をそのまま中継する経路が要る。

## 到達性の前提 (検証済み)

- CCoW egress は **TCP/443 の WSS のみ**到達 (UDP 封鎖、TLS は Anthropic egress
  gateway が MITM 終端)。cloudflared を CCoW 内に立てる案は却下済み (`README` / #10)。
  → 「手元 → 中継へ outbound WSS」「CCoW → 中継へ outbound WSS」で中継合流する形が唯一。
- Cloudflare は **2025-10-31 に Workers/DO の WS メッセージ上限を 1 MiB → 32 MiB に
  引き上げ**、変更理由に「Chrome Devtools Protocol メッセージの処理」を明記。生 CDP の
  大きいフレーム (フルページ screenshot / PDF / 大 response body) も 32 MiB 内なら通る。

## アーキテクチャ

```
[CCoW] npx chrome-devtools-mcp --wsEndpoint "wss://cdp-relay.ippoan.org/cdp/{session}/devtools/browser?token=<pair_code>"
  │  生 CDP WS (puppeteer connect; --wsEndpoint なので /json/version discovery は無し)
  ▼
[cdp-relay Worker + BrowserSessionDO]   session = idFromName(session)
  │  DO が 2 脚 (cdp-client / cdp-bridge) を hibernatable hold し、フレームを無加工パイプ
  ▲
  │  outbound WSS: /cdpbridge/{session}?token=<pair_code>
[手元] node bridge/cdp-bridge.mjs
  ⇅ ws://127.0.0.1:9222/devtools/browser/<id>   (実 Chrome --remote-debugging-port=9222)
```

- **client 脚** (`GET /cdp/{session}/…`): chrome-devtools-mcp (puppeteer)。DO に tag
  `cdp-client` で hold。bridge 未接続なら **503 `cdp_bridge_not_connected`** で fail-fast
  (bridge 不在のまま upgrade を返すと puppeteer 初手 `Target.setDiscoverTargets` が
  hang するため)。
- **bridge 脚** (`GET /cdpbridge/{session}`): 手元 node プロセス。DO に tag `cdp-bridge`
  で hold。bridge は実 Chrome の `/json/version` から `webSocketDebuggerUrl` を引いて
  browser-level CDP WS に繋ぎ、relay 脚との間を無加工パイプする。
- **DO は中身を解釈しない**: `webSocketMessage` で tag を見て相手脚へ `send` するだけ。
  curated な `/cmd` の in-memory 相関 (id ⇄ Promise) は通さない。片脚が閉じたら相手脚も
  畳んで、もう片側 (mcp / bridge) に切断を伝える (`teardownCdpPeer`)。

### なぜ拡張ではなく素の node bridge か

- `chrome.debugger` はタブ単位で browser-level Target/Browser ドメインを出せない
  (puppeteer の browser エンドポイントを満たせない)。
- Chrome の DevTools ポートは **Origin 付き WS upgrade を拒否**する
  (`--remote-allow-origins` が要る)。拡張の fetch/WS は `Origin: chrome-extension://…`
  を付けるので実 :9222 に繋ぎにくい。**node の WebSocket は Origin を付けない**ので
  追加フラグ無しで繋げる。
- bridge は手元で動く (CCoW ではない) ので egress gateway の TLS MITM も無関係。

## 認証

- 生 CDP = ブラウザ全権の capability。既存 `/ext` と同じ **RELAY_TOKEN / 短命 pairing
  code** で bridge 脚・client 脚の両方を edge 認証する (`edgeAuth` → DO `authorize`)。
- chrome-devtools-mcp は `--wsEndpoint` の `?token=<pair_code>` で通す (puppeteer は
  wsEndpoint を verbatim 使うので path/query が保たれる)。`--wsHeaders
  '{"Authorization":"Bearer <pair_code>"}'` でも可 (`checkToken` が両対応)。
- pairing code は `browser_pair` と同じ短命 (既定 15 分)・session スコープ。値は会話に
  出してよい (静的 RELAY_TOKEN とは別物)。

## 使い方 (CCoW 側)

1. CCoW で `browser_cdp_endpoint` tool を呼ぶ → `ws_endpoint` / `bridge_command` /
   `chrome_devtools_mcp_command` が返る。
2. 手元 Chrome を `--remote-debugging-port=9222` で起動 (ショートカット可)。
3. 手元で `bridge_command` (= `node bridge/cdp-bridge.mjs --session … --token …`) を実行。
4. CCoW で `chrome_devtools_mcp_command` (= `npx chrome-devtools-mcp@latest
   --wsEndpoint "…"`) を実行 → chrome-devtools-mcp の全ツールが手元ブラウザに効く。

## 実装したもの

| 変更 | 内容 |
|---|---|
| `src/index.ts` | `/cdpbridge/{session}` と `/cdp/{session}/…` の WS upgrade routing (edgeAuth) |
| `src/do/browser-session-do.ts` | `handleCdpLeg` (2 脚 hold) / `forwardCdp` (無加工転送) / `teardownCdpPeer`。既存 ext 脚は tag `ext` に分離 |
| `src/mcp/tools.ts` + `server.ts` | `browser_cdp_endpoint` tool (pair mint + wsEndpoint / bridge / mcp コマンド生成) |
| `bridge/cdp-bridge.mjs` | 手元で走らせる依存ゼロの CDP ブリッジ (実 :9222 ⇅ cdp-relay) |
| `test/cdp.test.ts` | passthrough の auth / 503 fail-fast / 双方向転送 / peer teardown |

## 既知の限界 / TODO

- **bridge プロセスが要る** (拡張だけでは完結しない)。将来 `cdp-agent` (MSI + Native
  Messaging) に bridge モードを畳み込めば手元セットアップを自動化できる (別 PR)。
- bridge は client 切断ごとに実 Chrome WS を張り直す (= 毎回クリーンな CDP 状態)。
  張り直しの一瞬は client が 503 になり得る (bridge の再接続は速いので実害小)。
- 32 MiB を超える単一 CDP フレームは通らない (通常の操作では出ないが、巨大な
  `Page.printToPDF` 等は理論上上限に当たる)。
