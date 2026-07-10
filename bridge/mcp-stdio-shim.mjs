#!/usr/bin/env node
/**
 * mcp-stdio-shim — CCoW 側で走らせる MCP passthrough の stdio シム (Refs #81)。
 *
 * MCP client (Claude Code) の stdio (newline-delimited JSON-RPC) を、cdp-relay の
 * `/mcppipe/{session}` WS に 1 行 = 1 フレームでパイプする。対向は手元の
 * `node bridge/cdp-bridge.mjs --mcp` が spawn した chrome-devtools-mcp。
 *
 * 生 CDP passthrough (`--wsEndpoint`) と違い、1 ツール呼び出しが太平洋横断 1 往復で
 * 済む (CDP の 4〜5 往復 → 1 往復、実測 ~1.1s → 0.4〜0.6s = 2〜2.5 倍。回線状況依存、
 * #81 の実測経緯参照)。
 *
 * 依存ゼロ (Node 22+ の global WebSocket)。CCoW の egress は TCP/443 直結 + TLS MITM
 * (Anthropic Egress Gateway) だが、`NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` が
 * 標準設定なのでそのまま繋がる (ippoan/cdp-relay#80 で実測済み)。
 *
 * 使い方 (browser_mcp_endpoint tool が完全コマンドを返す):
 *   claude mcp add chrome-local -- node bridge/mcp-stdio-shim.mjs --url "wss://…/mcppipe/…?token=…"
 *
 * 引数 (環境変数でも可):
 *   --url <wss url>   必須。/mcppipe/{session}?token=… (MCP_SHIM_URL)
 */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? process.env.MCP_SHIM_URL ?? "";
if (!url) {
  console.error('usage: node mcp-stdio-shim.mjs --url "wss://…/mcppipe/{session}?token=…"');
  process.exit(2);
}

const log = (...a) => console.error(`[mcp-shim ${new Date().toISOString()}]`, ...a);

const ws = new WebSocket(url);
// WS が開くまでの stdin 行を取りこぼさないようバッファする。
const pendingOut = [];

ws.onopen = () => {
  log("open:", url.replace(/token=[^&]+/, "token=***"));
  while (pendingOut.length) ws.send(pendingOut.shift());
};

// relay (→ 手元 chrome-devtools-mcp の stdout) → こちらの stdout (MCP client へ)。
ws.onmessage = (ev) => {
  const data = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
  process.stdout.write(data + "\n");
};

// 相手切断 = セッション終了。MCP client 側に EOF を見せてプロセスごと畳む
// (client は再接続 = シムの再起動で新セッションを張る)。
ws.onclose = (e) => {
  log(`closed (${e.code} ${e.reason || ""})`);
  process.exit(e.code === 1000 ? 0 : 1);
};
ws.onerror = () => {
  // 非 101 (503 mcp_bridge_not_connected 等) もここに来る。詳細は relay 側の応答参照。
  log("error (bridge 未接続 / token 失効の可能性。browser_mcp_endpoint を再発行して確認)");
};

// MCP client (stdin) → relay。newline-delimited JSON-RPC を 1 行 = 1 フレームで送る。
let inBuf = "";
process.stdin.on("data", (d) => {
  inBuf += d.toString("utf8");
  let idx;
  while ((idx = inBuf.indexOf("\n")) >= 0) {
    const line = inBuf.slice(0, idx).replace(/\r$/, "");
    inBuf = inBuf.slice(idx + 1);
    if (line === "") continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(line);
    else if (ws.readyState === WebSocket.CONNECTING) pendingOut.push(line);
    // CLOSING/CLOSED は捨てる (onclose が exit する)
  }
});
process.stdin.on("end", () => {
  log("stdin EOF");
  try { ws.close(1000, "stdin_eof"); } catch {}
  process.exit(0);
});
