# local-mcp — CCoW ローカル lib 検証 MCP (bun)

CCoW コンテナ内で動く **stdio MCP**。CCoW で書いた lib / SDK を **動的に読み込んで実行・検証**する。
deploy / publish / ブラウザを挟まず、ワークスペースのソースをその場で叩ける汎用ハーネス。

> cdp-relay (CCoW → 手元 Chrome の CDP relay Worker) とは別物の **ローカル実行ツール**。
> deploy される Worker ではなく、CCoW コンテナ内の bun プロセスとして動く。同 repo に同居するが
> artifact 種別が違う点に注意。

## なぜ bun / なぜローカル

- **リモート Worker MCP は CCoW の FS を読めない** + runtime で `npm install` 不可 + node 依存 lib を
  動的ロードできない → 「CCoW で書いたコードを動的読み込み」はローカルランタイムでしか成立しない。
- **bun は .ts を native 実行** (tsx/esbuild 不要) + cold start 数十 ms → 動的ロード + warm 反復に最適。
- 外向き API は CCoW egress proxy (TCP/443) 経由で sandbox 等に届く。

## tool: `run`

```
run({ code, cwd?, timeoutMs?, env? })
```

- `code`: **bun の本物のモジュール**として実行される。static `import` / top-level `await` OK。
- `cwd`: import 解決 + 実行の作業ディレクトリ。**対象 lib の dir を指定**する
  (例 `/home/user/egov-shinsei-sdk/src`)。相対 import も lib の `node_modules` も cwd 基準で解決。
- `timeoutMs`: 既定 30000。
- `env`: 追加環境変数 (access_token などを渡す用)。

### 出力契約

- **ログ**: `console.log` の出力が `stdout` に入る。
- **構造化戻り値**: `globalThis.__result = X` を立てると `result` として返る (JSON 化)。
- **例外**: module が throw すると非ゼロ終了 + `stderr` に stack。`ok:false` で返る。

返却 (tool result text は JSON):

```json
{ "ok": true, "exitCode": 0, "durationMs": 39, "result": {...}, "stdout": "...", "stderr": "" }
```

## 使用例: e-Gov SDK を Trial 検証 (access_token は env / 引数で渡す)

```ts
// cwd: /home/user/egov-shinsei-sdk/src
import { EgovClient } from './index'
const c = new EgovClient({
  apiBase: 'https://api2.sbx.e-gov.go.jp/shinsei/v2',
  accessToken: process.env.EGOV_TOKEN!,
} as any)
const skel = await c.getProcedure('950A102200038000')   // 例
globalThis.__result = { configs: skel.results.configuration_file_name, forms: skel.results.file_info.length }
```

新しい lib を検証するときは **`cwd` をその lib の dir に変えるだけ**。MCP 側のコード変更は不要。

## 登録 (install)

stdio MCP として `~/.claude.json` の user-scope `mcpServers` に登録する:

```json
{
  "mcpServers": {
    "local-lib-run": {
      "command": "bun",
      "args": ["run", "/home/user/cdp-relay/local-mcp/server.ts"]
    }
  }
}
```

- 登録は `mcp-user-setup` 系の skill が担当する (手書きで `~/.claude.json` を編集しない)。
- **反映は次 session** (`~/.claude.json` の mcpServers 追加は当 session には載らない)。
- 当 session で試すときは `bun` を直接叩く:
  ```sh
  bun run /home/user/cdp-relay/local-mcp/server.ts < rpc.jsonl
  ```
  (newline-delimited JSON-RPC: initialize → tools/list → tools/call)

## 設計メモ

- 依存ゼロ (bun 組み込みのみ)。
- snippet は cwd 配下に一時 `.librun-*.ts` を書き出して `bun run` で spawn → 実行後に削除。
  関数 wrap しないのは `import` を top-level に保つため (戻り値は `globalThis.__result` で回収)。
- transport は stdio (newline-delimited JSON-RPC 2.0)。`initialize` / `tools/list` /
  `tools/call` / `ping` を実装。
