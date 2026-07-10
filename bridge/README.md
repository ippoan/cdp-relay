# cdp-bridge — chrome-devtools-mcp × cdp-relay 用の手元ブリッジ

CCoW の chrome-devtools-mcp から cdp-relay 経由で **手元 Chrome を生 CDP 操作**する
ための、手元で走らせる依存ゼロ (Node 18+) のブリッジ。設計は
[`../docs/plan-chrome-devtools-mcp.md`](../docs/plan-chrome-devtools-mcp.md)。

> **多くの場合これは不要**: cdp-relay MV3 拡張の **CDP passthrough モード**
> (`browser_cdp_endpoint` の `pair_string` を popup に貼るだけ) を使えば、拡張の
> Service Worker が同じ役割を担うので node bridge を常駐させなくて済む。この
> スクリプト (方式 B) は、拡張を使いたくない / SW の idle 停止を避けて常駐させたい
> 場合の代替。詳細は plan doc の「使い方」を参照。

実 Chrome (`--remote-debugging-port=9222`) の browser-level CDP WebSocket を、
cdp-relay の `/cdpbridge/{session}` に outbound WSS で繋いで無加工パイプする。

## 手順

```sh
# 1. 手元 Chrome を DevTools ポート付きで起動 (ショートカットに追記でも可)
chrome --remote-debugging-port=9222

# 2. CCoW の browser_cdp_endpoint tool が発行した session / token でブリッジ起動
node bridge/cdp-bridge.mjs --session <session> --token <pair_code>

# 3. CCoW 側で chrome-devtools-mcp を wsEndpoint で起動
npx chrome-devtools-mcp@latest \
  --wsEndpoint "wss://cdp-relay.ippoan.org/cdp/<session>/devtools/browser?token=<pair_code>"
```

## MCP passthrough モード (`--mcp`、Refs #81) — 実測 2〜2.5 倍速い

生 CDP を海越えで運ぶと 1 ツール呼び出し = CDP 4〜5 往復 (~236ms/往復、warm ~1.1s) に
なる。`--mcp` は chrome-devtools-mcp を**手元で spawn** し、その stdio (JSONL) を
`/mcpbridge/{session}` へパイプする — 1 ツール = 1 往復。

実測 (#81、2026-07-10): **1 ツール 0.4〜0.6s (回線状況依存) = 2〜2.5 倍**、接続確立は
8s → 0.3〜0.4s。理論値 ~0.3s との差は海越え RTT の時間帯変動 (±150ms) に埋もれて分解
不能だったため、これ以上の短縮はエージェント自体を手元で動かす (cc-webreview-ext 系) の領分。

手元での bridge 起動は 3 通り (どれも chrome-devtools-mcp が npm パッケージのため npx =
Node.js は必要):

- **(a) 拡張 popup の「MCP bridge 起動」ボタン (推奨、#83)** — cdp-agent (MSI) 導入済みなら、
  `browser_mcp_endpoint` の `pair_string` (mode=mcp) を popup に貼るとボタンが出る。押すと
  nmhost 経由で `cdp-agent --mcp-bridge` が detached 起動する (repo clone / node コマンド不要)
- **(b) clone 不要 bootstrap** — `bootstrap_command` (raw curl + node) をそのまま実行
- **(c) repo clone 済み** — 下の手順 2

```sh
# 1. 手元 Chrome を DevTools ポート付きで起動 (Chrome 136+ は非デフォルト
#    --user-data-dir が必須。デフォルト profile への debug port は無視される)
chrome --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\cdp-relay-chrome"

# 2. CCoW の browser_mcp_endpoint tool が発行した session / token でブリッジ起動
node bridge/cdp-bridge.mjs --mcp --session <session> --token <pair_code>

# 3. CCoW 側は同 tool が返す claude_mcp_add_command を実行 (次 session から有効)
claude mcp add chrome-local -- node bridge/mcp-stdio-shim.mjs \
  --url "wss://cdp-relay.ippoan.org/mcppipe/<session>?token=<pair_code>"
```

CCoW 側シム [`mcp-stdio-shim.mjs`](./mcp-stdio-shim.mjs) も依存ゼロ (Node 22+ の global
WebSocket)。CCoW egress の TLS MITM は `NODE_EXTRA_CA_CERTS` 標準設定で信頼される (#80)。
このモードは npx / node が手元に必須 (拡張 SW はプロセスを spawn できない) — 拡張だけで
完結させたい場合は従来の CDP passthrough を使う。

## 引数 (環境変数 `CDP_BRIDGE_<UPPER>` でも可)

| 引数 | 既定 | 説明 |
|---|---|---|
| `--session` | (必須) | cdp-relay の session 名 (client 脚と一致させる) |
| `--token` | (必須) | pair_code (bridge 脚の認証。`browser_cdp_endpoint` / `browser_mcp_endpoint` が発行) |
| `--relay` | `https://cdp-relay.ippoan.org` | cdp-relay の base URL |
| `--host` | `127.0.0.1` | 実 Chrome の DevTools ホスト |
| `--port` | `9222` | 実 Chrome の DevTools ポート |
| `--mcp` | (off) | MCP passthrough モード (chrome-devtools-mcp を手元 spawn) |
| `--mcp-cmd` | `npx -y chrome-devtools-mcp@latest --browserUrl http://<host>:<port>` | `--mcp` 時の起動コマンド上書き |

## メモ

- `token` は `ps` から見えるので、気になる場合は `CDP_BRIDGE_TOKEN` env で渡す。
- ブリッジは client 切断ごとに手元側 (実 Chrome の WS / chrome-devtools-mcp child) を
  張り直し、次の client を待つ (= 毎回クリーンな状態で始まる。MCP の initialize は
  client 接続ごとに 1 回きりのため child も作り直す)。Ctrl-C で終了。
- 拡張 (`../extension/`) は不要。この経路は素の node プロセスで完結する
  (Chrome の DevTools ポートは Origin 付き WS を拒否するため、Origin を付けない
  node WebSocket が向く)。
