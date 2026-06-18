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
| cloudflared (cf tunnel, :7844) で CCoW 内サーバを公開 | ❌ edge に届かない (UDP/7844・TCP/7844 とも CCoW egress で落ちる、`HTTPS_PROXY` も非対応) |

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
[CCoW / Claude Code]  MCP: browser_navigate / browser_screenshot / browser_eval
```

## エンドポイント

| メソッド / パス | 役割 |
|---|---|
| `POST /mcp` | MCP ツール (`browser_navigate` / `browser_screenshot` / `browser_eval`)。**MCP-JWT 認証** (ref-files と同方式) |
| `GET /ext/{session}` | 拡張の WS upgrade。`?token=` 必須 (hibernatable hold) |
| `PUT /shot/{session}` | 拡張が screenshot(PNG) を投入。token 必須。`{ shot_url }` を返す |
| `GET /shot/{session}/{id}` | screenshot 一時配信 (予測不能 id ゆえ token 不要、TTL 既定 5 分) |
| `POST /register/{session}` | 手元 agent が quick tunnel URL を登録。token 必須 (rendezvous, #12 M3) |
| `GET /lookup/{session}` | CCoW proxy が session の tunnel URL を引く。token 必須 (rendezvous, #12 M3) |
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

- `browser_pair(session?, ttl_seconds?)` — 手元拡張を session にペアリングする**短命 pairing
  code** を発行 (`{ session, pair_code, expires_in_seconds, relay_url }`)。静的 `RELAY_TOKEN`
  を人手で調べる代わりに、Claude が code を発行して手元に渡す (下記 *pair flow* 参照)
- `browser_navigate(session, url)` — 手元 Chrome を url に遷移 (http(s) のみ)。`{ url }` を返す
- `browser_screenshot(session)` — viewport を撮って `{ shot_url }` を返す
- `browser_eval(session, expression)` — 現在ページで JS 式を評価し `{ value }` を返す。text 取得は `document.body.innerText` 等 (PNG と違い値が小さいので shot_url ではなく値を直接返す)

> 設計判断 (なぜ stateless + 自前 DO で durable McpAgent でないか): tool セットは固定なので
> `listChanged` 不要。durable の `McpAgent` は WS transport を内部で握るため「拡張用の別 WS
> (/ext)」を同居させにくい。詳細は issue #28 / Refs #6 / #12。

## auth / security

エンドポイントごとに認証方式が違う (クライアントが違うため):

| endpoint | クライアント | 認証 |
|---|---|---|
| `/mcp` | Claude Code | **MCP-JWT** (HS256、`MCP_JWT_SECRET` で検証、ref-files-worker と同方式)。auth-worker が OAT から mint し、`session-start-write-mcp-user-scope.sh` hook が自動 attach |
| `/ext` | ブラウザ MV3 拡張 | `RELAY_TOKEN` **または** session の pairing code (`?token=`)。拡張は MCP-JWT を mint できないため |
| `/shot/{session}` PUT | 拡張 | `RELAY_TOKEN` または pairing code |
| `/shot/{session}/{id}` GET | curl | 無認証 (予測不能 id) |

### pair flow (静的 token を手で調べない)

`RELAY_TOKEN` は無期限の共有秘密で、popup に貼るには値を調べる必要があり UX も粒度も粗い。
代わりに **`browser_pair` tool が session 単位・短命 (既定 15 分) の pairing code を発行**し、
Claude が会話で手元に渡す。拡張はその code を `?token=` に使って `/ext` `/shot` に接続する:

1. Claude が `browser_pair()` を呼ぶ → DO が pairing code を mint し SQLite に保存 (TTL 付き)
2. tool が `{ session, pair_code, relay_url }` を返す → Claude が「これを popup に貼って」と提示
3. ユーザーが popup の **Relay URL / Session / Token** にそれぞれ貼って接続
4. edge は `?token=` が `RELAY_TOKEN` と不一致なら `X-Relay-Auth: pair` を付けて DO に委譲し、
   DO が pairing code として権威的に検証 (未失効・session 一致なら通す)

- pairing code は **256-bit ランダム** なので会話に出ても TTL + session スコープで自然失効する
  (無期限の `RELAY_TOKEN` を会話に出すのとは安全性が桁違い)。`RELAY_TOKEN` は admin fallback
  として引き続き有効
- code は **session 単位で 1 つ**。`browser_pair` を再発行すると旧 code は失効する
- pairing code の検証は edge ではなく **DO** で行う (code が session DO の SQLite に在るため)。
  edge は `RELAY_TOKEN` 一致/未提示だけを早期に捌き、それ以外を pairing candidate として DO に渡す

**CDP は無認証なのでこれらが唯一の関門**。漏れたら任意 JS eval = ブラウザ乗っ取り。
未設定なら **fail-closed** (`/mcp` は 500、`/ext` は 503)。比較・検証は constant-time
(`src/lib/auth.ts` / `src/lib/jwt.ts`)。

- **`MCP_JWT_SECRET`** は auth-worker の `INTERNAL_SHARED_SECRET` と同値を Secrets Store
  binding で受ける (既存 secret 再利用、新規投入不要)。`aud` は `MCP_JWT_AUDIENCE="*"` で
  不問 (connector が可変 aud を mint するため)。
- **`RELAY_TOKEN`** は `secret-inject` skill で CF Secrets Store + GCP(SoT) に投入する
  (値は context/log 非露出):

```sh
openssl rand -hex 32 | bash ~/.claude/skills/secret-inject/scripts/inject-secret.sh \
  RELAY_TOKEN --targets gcp,cf
```

## 拡張のロード (手元 Chrome、1 度だけ)

1. `chrome://extensions` を開き、右上「デベロッパーモード」を ON
2. 「パッケージ化されていない拡張機能を読み込む」→ `extension/` ディレクトリを選択
3. ツールバーの cdp-relay アイコン → popup で設定:
   - **Relay URL**: `https://cdp-relay.ippoan.org` (custom domain。`cdp-relay.<subdomain>.workers.dev` でも可)
   - **Session**: MCP tool に渡す session と一致させる (pair flow なら `browser_pair` の戻り値の `session`)
   - **Token**: `browser_pair` が返した **pairing code** を貼る (= 推奨)。または `RELAY_TOKEN` 同値 (admin fallback)
   - **対象タブ**: 操作させたいタブ
4. 「接続」→ status が `connected` になれば、CCoW から `browser_navigate(session, …)` で操作可能

> **推奨フロー**: 値を手で調べる代わりに、まず Claude に `browser_pair` を呼ばせて
> `{ relay_url, session, pair_code }` を受け取り、その 3 値を popup に貼る。pairing code は
> 短命なので会話に出ても安全 (上記 *pair flow* / auth 節を参照)。

MCP (`/mcp`) は ippoan 標準の **MCP-JWT** 認証なので、ref-files と同じく
`session-start-write-mcp-user-scope.sh` hook が `~/.claude.json` に自動 attach する
(token cache の MCP-JWT を `Authorization: Bearer` で渡す)。手動登録は `mcp-user-setup`
skill 参照。拡張 popup の **Token** は `/ext` 用の `RELAY_TOKEN` で、MCP-JWT とは別物。

## Native Messaging で agent を自動起動 (agent モード、#33)

agent モード (Relay URL = `http://127.0.0.1:19222`) では、従来は先に `cdp-agent` を手元で
**手動起動**しておく必要があった。Chrome **Native Messaging** を使い、拡張の「接続」時に
agent が未起動なら自動で起動するようにした。

仕組み (= **ランチャー方式**):

1. 拡張は manifest の `key` で **固定 ID** (`ekadlloplnbagbidandccdheiemgocng`) を持つ
2. `cdp-agent` を 1 度起動すると native-host manifest + HKCU registry を **自己登録**する
   (`--install-native-host` でも明示登録可、admin 不要)
3. 以降、拡張の「接続」で agent 未到達なら `chrome.runtime.sendNativeMessage` で
   `com.ippoan.cdp_agent` を呼ぶ → host (= `cdp-agent.exe` が argv の origin を検出して
   native-host モードで起動) が `cdp-agent` 本体を **detached spawn** して即応答
4. spawn された本体が cloudflared tunnel + ext server (19222) を握る。native-host プロセスは
   Chrome が port close で kill するが、本体は detached なので生き残る

→ 手動起動は **MSI install 後の 1 回だけ** (= 自己登録のトリガ)。以降のセッションは
拡張の「接続」だけで agent が立ち上がる。Windows 専用。

> 既に起動済みなら native-host は spawn せず `already_running` を返す (二重起動しない)。
> 自動起動を無効にしたい場合は agent を `CDP_AGENT_NO_NM_REGISTER=1` で起動すると
> 自己登録しない。

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
で同一 worker に出す (CI: `ippoan/ci-workflows` の `frontend-ci.yml`)。一次エンドポイントは
custom domain **`cdp-relay.ippoan.org`** (`wrangler deploy` が ippoan.org ゾーンに DNS +
route を自動生成)。workers.dev も fallback で有効。MCP は `https://cdp-relay.ippoan.org/mcp`。

## ロードマップ (issue #28 PoC 段取り)

- [x] P0/P1/P2 (初回 PR): DO リレー (`/ext` `/cmd` `/shot`) + 最小 MV3 拡張 +
      stateless MCP 2 tool (`browser_navigate` / `browser_screenshot`)
- [x] P3 (済): /mcp を MCP-JWT に統一 (ref-files) + custom domain `cdp-relay.ippoan.org` 有効化
- [x] P3 (済): pair flow (`browser_pair` tool + DO 発行の短命 pairing code、Refs #7)
- [x] M2c (済): agent モードで拡張から Native Messaging で `cdp-agent` を自動起動 (#33)
- [ ] P3 (残): 残りツール (`click` / `type` / `eval` / `html` / `pdf` / `wait` / `tabs`) +
      claude-hooks (`write-mcp-user-scope.sh`) への自動 attach 登録
