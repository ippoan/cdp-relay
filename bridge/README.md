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

## 引数 (環境変数 `CDP_BRIDGE_<UPPER>` でも可)

| 引数 | 既定 | 説明 |
|---|---|---|
| `--session` | (必須) | cdp-relay の session 名 (client 脚と一致させる) |
| `--token` | (必須) | pair_code (bridge 脚の認証。`browser_cdp_endpoint` が発行) |
| `--relay` | `https://cdp-relay.ippoan.org` | cdp-relay の base URL |
| `--host` | `127.0.0.1` | 実 Chrome の DevTools ホスト |
| `--port` | `9222` | 実 Chrome の DevTools ポート |

## メモ

- `token` は `ps` から見えるので、気になる場合は `CDP_BRIDGE_TOKEN` env で渡す。
- ブリッジは client (chrome-devtools-mcp) 切断ごとに実 Chrome の WS を張り直し、
  次の client を待つ (= 毎回クリーンな CDP 状態で始まる)。Ctrl-C で終了。
- 拡張 (`../extension/`) は不要。この経路は素の node プロセスで完結する
  (Chrome の DevTools ポートは Origin 付き WS を拒否するため、Origin を付けない
  node WebSocket が向く)。
