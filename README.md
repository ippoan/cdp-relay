# cdp-relay

CCoW (Claude Code on the Web) の隔離コンテナから **手元の Chrome を CDP で操作** する
ための DO+WS リレー。Chrome 拡張 (MV3) → Cloudflare Worker+DO → stateless MCP を、
唯一通る **TCP/443 の WSS** で中継合流させ、手元 NAT を内側から抜ける。

> 設計の全体像・判断の経緯は引継ぎ issue [ippoan/mcp-cf-workers#28](https://github.com/ippoan/mcp-cf-workers/issues/28) を参照。

## なぜ直接 CDP ではダメか

CCoW コンテナで実測済み (再検証不要):

| 確認 | 結果 |
|---|---|
| 手元 Chrome への直 CDP (Tailscale IP) | ❌ タイムアウト (CCoW は Tailscale 網外) |
| UDP アウトバウンド (STUN) | ❌ 封鎖 (WebRTC P2P も不可) |
| TCP/443 アウトバウンド (WSS) | ✅ 通る |

CDP は「Chrome がリッスン側 / 操作側がクライアント」。CCoW → 手元 Chrome へ入るには
NAT+FW を越える必要があり不可。唯一通る WSS で、**両側 outbound を中継で合流**させる。

## アーキテクチャ

```
[手元 Chrome]
  拡張 (MV3, chrome.debugger)
   │ (1) WSS outbound: /ext/{session}?token=…
   ▼
[Cloudflare Worker + BrowserSessionDO]   session = idFromName(session)
   ├ /ext/{session}      … 拡張 WS を hibernatable hold
   ├ /mcp                … stateless MCP (Claude が叩く)
   ├ /cmd                … (internal) MCP→DO の CDP コマンド投入口
   └ /shot/{session}/{id} … screenshot 一時配信
   ▲
   │ (2) tool 呼び出し → DO を session で引いて /cmd
[CCoW / Claude Code]  MCP: browser_navigate / browser_screenshot
```

## エンドポイント

| メソッド / パス | 役割 |
|---|---|
| `POST /mcp` | MCP ツール (`browser_navigate` / `browser_screenshot`)。**token 必須** |
| `GET /ext/{session}` | 拡張の WS upgrade。`?token=` 必須 (hibernatable hold) |
| `PUT /shot/{session}` | 拡張が screenshot(PNG) を投入。token 必須。`{ shot_url }` を返す |
| `GET /shot/{session}/{id}` | screenshot 一時配信 (予測不能 id ゆえ token 不要、TTL 既定 5 分) |
| `GET /health` | ヘルスチェック |
| `GET /` | 説明ページ |

`/cmd` は edge では公開しない。MCP tool だけが DO stub 経由で内部的に叩く。

## データフロー (CDP 往復の id 相関)

1. Claude が `browser_navigate(session, url)` を呼ぶ
2. stateless MCP が `BROWSER_DO.get(idFromName(session))` → `/cmd` に `{id, method, params}` POST
3. DO が拡張 WS に転送。`id → 応答待ち Promise` を in-memory Map で保持 (DO は /cmd の
   Promise 待ち中アクティブなので往復は同一インスタンスで閉じる)
4. 拡張が高レベル method を CDP に翻訳して `chrome.debugger.sendCommand` 実行
5. 拡張が `{id, result}` を WS 返信 → DO が Promise resolve → `/cmd` 応答 → tool 戻り値
6. タイムアウト (既定 30s) / 拡張未接続は明示エラー (`extension_not_connected` 503)

**screenshot は MCP body に base64 を載せない** (token 浪費回避)。拡張が PNG を DO の
`/shot` に PUT → tool は `shot_url` を返す → Claude が `curl -o /tmp/shot.png <shot_url>`
→ Read。ui-preview の「tar 直 PUT」思想と対称。

## MCP ツール

`POST /mcp` で stateless Streamable HTTP を提供する。`@ippoan/mcp-cf-workers` の
`createWorkerMcp` を使用 (`src/mcp/server.ts`)。実ロジックは `src/mcp/tools.ts`。

- `browser_navigate(session, url)` — 手元 Chrome を url に遷移 (http(s) のみ)。`{ url }` を返す
- `browser_screenshot(session)` — viewport を撮って `{ shot_url }` を返す

> 設計判断 (なぜ stateless + 自前 DO で durable McpAgent でないか): tool セットは固定なので
> `listChanged` 不要。durable の `McpAgent` は WS transport を内部で握るため「拡張用の別 WS
> (/ext)」を同居させにくい。詳細は issue #28 / Refs #6 / #12。

## auth / security

- `/ext` (拡張接続) と `/mcp` の両方に `RELAY_TOKEN`。**CDP は無認証 = この token が
  唯一の関門**。漏れたら任意 JS eval = ブラウザ乗っ取り。
- `RELAY_TOKEN` 未設定なら全 reject (**fail-closed**、503 `relay_token_not_configured`)。
- 比較は constant-time (`src/lib/auth.ts` の HMAC 固定長化 + XOR)。
- token は会話 context・log・tool param に出さない。`secret-inject` skill で投入する:

```sh
openssl rand -hex 32 | bash ~/.claude/skills/secret-inject/scripts/inject-secret.sh \
  CDP_RELAY_TOKEN --targets cf
# 投入後、worker binding に設定:
npx wrangler secret put RELAY_TOKEN
```

## 拡張のロード (手元 Chrome、1 度だけ)

1. `chrome://extensions` を開き、右上「デベロッパーモード」を ON
2. 「パッケージ化されていない拡張機能を読み込む」→ `extension/` ディレクトリを選択
3. ツールバーの cdp-relay アイコン → popup で設定:
   - **Relay URL**: deploy した worker (例 `https://cdp-relay.<subdomain>.workers.dev`)
   - **Session**: 任意の名前 (例 `my-laptop`)。MCP tool に渡す session と一致させる
   - **Token**: `RELAY_TOKEN` と同値 (pair flow で手元に渡す)
   - **対象タブ**: 操作させたいタブ
4. 「接続」→ status が `connected` になれば、CCoW から `browser_navigate(session, …)` で操作可能

MCP は `mcp-user-setup` skill で `~/.claude.json` の user-scope に登録する
(`<relayUrl>/mcp`、`Authorization: Bearer <RELAY_TOKEN>`)。

## 開発

```sh
npm install         # CI は @ippoan scope を GitHub Packages から引く
npm run typecheck   # tsc --noEmit
npm test            # vitest (workerd 上で DO 経由まで実行)
npm run dev         # wrangler dev
```

> CCoW / ローカルで GitHub Packages の read token が無い場合は
> `npm install ../mcp-cf-workers` で clone を file: link してから typecheck / test する
> (`package-lock.json` は file link が混じるため commit しない = `.gitignore` 済み)。

## デプロイ

Single-env (staging = prod)。PR merge (push: main) も tag push も同じ `wrangler deploy`
で同一 worker に出す (CI: `ippoan/ci-workflows` の `frontend-ci.yml`)。初回は
`workers_dev = true` のみ。custom domain (`cdp-relay.ippoan.org`) は後続 PR で有効化する。

## ロードマップ (issue #28 PoC 段取り)

- [x] P0/P1/P2 (初回 PR): DO リレー (`/ext` `/cmd` `/shot`) + 最小 MV3 拡張 +
      stateless MCP 2 tool (`browser_navigate` / `browser_screenshot`)
- [ ] P3: 残りツール (`click` / `type` / `eval` / `html` / `pdf` / `wait` / `tabs`)
- [ ] P3: auth 強化 + pair flow (auth-worker の device/pair に倣う) + custom domain 有効化
