#!/usr/bin/env node
/**
 * cdp-bridge — 手元で走らせる CDP ブリッジ (chrome-devtools-mcp × cdp-relay)。
 *
 * 実 Chrome (`--remote-debugging-port=9222`) の browser-level CDP WebSocket を、
 * cdp-relay の `/cdpbridge/{session}` に outbound WSS で繋いで双方向にパイプする。
 * これで CCoW の chrome-devtools-mcp が `--wsEndpoint`
 * (`wss://cdp-relay.ippoan.org/cdp/{session}/devtools/browser?token=…`) で
 * cdp-relay の client 脚として合流し、手元ブラウザを生 CDP 操作できる。
 *
 * なぜ拡張ではなく素の node プロセスか:
 *   - chrome.debugger はタブ単位で browser-level Target/Browser ドメインを出せず、
 *     puppeteer (chrome-devtools-mcp) が要求する browser エンドポイントを満たせない。
 *   - Chrome の DevTools ポートは Origin ヘッダ付き WS upgrade を拒否する
 *     (`--remote-allow-origins` が要る)。node の WebSocket は Origin を付けないので
 *     追加フラグ無しで実 :9222 に繋げる。
 *
 * 依存ゼロ (Node 18+ の global fetch / WebSocket を使う)。CCoW ではなく手元で動かす
 * ので egress gateway の TLS MITM も無関係。
 *
 * 使い方:
 *   1. 手元 Chrome を起動: chrome --remote-debugging-port=9222
 *   2. node bridge/cdp-bridge.mjs --session <session> --token <pair_code>
 *      (token は CCoW の browser_cdp_endpoint tool が発行する pair_code)
 *
 * 主な引数 (環境変数でも可、CDP_BRIDGE_<UPPER>):
 *   --session <name>   必須。cdp-relay の session 名 (client 脚と一致させる)
 *   --token <code>     必須。pair_code (bridge 脚の認証に使う)
 *   --relay <url>      cdp-relay の base URL (既定 https://cdp-relay.ippoan.org)
 *   --host <host>      実 Chrome の DevTools ホスト (既定 127.0.0.1)
 *   --port <port>      実 Chrome の DevTools ポート (既定 9222)
 *   --mcp              MCP passthrough モード (Refs #81)。生 CDP の代わりに
 *                      chrome-devtools-mcp を手元で spawn し、その stdio (JSONL) を
 *                      relay の /mcpbridge/{session} へパイプする。CDP の 1 ツール
 *                      呼び出し = 4〜5 往復が 1 往復になり、CCoW からの操作が約 4 倍速い。
 *   --mcp-cmd <cmd>    --mcp 時の起動コマンド上書き (既定:
 *                      `npx -y chrome-devtools-mcp@latest --browserUrl http://<host>:<port>`)
 */

import { spawn } from "node:child_process";

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
const cfg = {
  session: args.session ?? process.env.CDP_BRIDGE_SESSION ?? "",
  token: args.token ?? process.env.CDP_BRIDGE_TOKEN ?? "",
  relay: (args.relay ?? process.env.CDP_BRIDGE_RELAY ?? "https://cdp-relay.ippoan.org").replace(/\/+$/, ""),
  host: args.host ?? process.env.CDP_BRIDGE_HOST ?? "127.0.0.1",
  port: args.port ?? process.env.CDP_BRIDGE_PORT ?? "9222",
  mcp: (args.mcp ?? process.env.CDP_BRIDGE_MCP ?? "") !== "" && args.mcp !== "false",
  mcpCmd: args["mcp-cmd"] ?? process.env.CDP_BRIDGE_MCP_CMD ?? "",
};

if (!cfg.session || !cfg.token) {
  console.error("usage: node cdp-bridge.mjs --session <name> --token <pair_code> [--relay <url>] [--port 9222]");
  process.exit(2);
}

function relayWss(base) {
  if (base.startsWith("https://")) return "wss://" + base.slice("https://".length);
  if (base.startsWith("http://")) return "ws://" + base.slice("http://".length);
  return base;
}

const versionUrl = `http://${cfg.host}:${cfg.port}/json/version`;
const relayWsUrl = `${relayWss(cfg.relay)}/cdpbridge/${encodeURIComponent(cfg.session)}?token=${encodeURIComponent(cfg.token)}`;

const log = (...a) => console.error(`[cdp-bridge ${new Date().toISOString()}]`, ...a);

/** 実 Chrome の browser-level CDP WS エンドポイントを取得する。 */
async function discoverBrowserWs() {
  const res = await fetch(versionUrl);
  if (!res.ok) throw new Error(`GET ${versionUrl} → ${res.status} (Chrome を --remote-debugging-port=${cfg.port} で起動したか確認)`);
  const info = await res.json();
  if (!info.webSocketDebuggerUrl) throw new Error("webSocketDebuggerUrl が /json/version に無い");
  return info.webSocketDebuggerUrl;
}

/**
 * 1 セッション分の接続。実 Chrome ↔ cdp-relay を両方張り、フレームを無加工で流す。
 * どちらかが閉じたら両方畳んで resolve する (呼び出し側が再接続をループする)。
 */
function runOnce(browserWsUrl) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (why) => {
      if (settled) return;
      settled = true;
      log("session end:", why);
      try { local.close(); } catch {}
      try { remote.close(); } catch {}
      resolve();
    };

    const local = new WebSocket(browserWsUrl); // 実 Chrome (browser-level CDP)
    const remote = new WebSocket(relayWsUrl); // cdp-relay の bridge 脚

    // 相手がまだ開いていない間のフレームを取りこぼさないよう軽くバッファする。
    const toLocal = [];
    const toRemote = [];
    const flush = () => {
      if (local.readyState === WebSocket.OPEN) while (toLocal.length) local.send(toLocal.shift());
      if (remote.readyState === WebSocket.OPEN) while (toRemote.length) remote.send(toRemote.shift());
    };

    local.onopen = () => { log("local (Chrome) open"); flush(); };
    remote.onopen = () => { log("remote (cdp-relay) open:", relayWsUrl.replace(/token=[^&]+/, "token=***")); flush(); };

    // chrome-devtools-mcp → cdp-relay → (remote) → local (Chrome)
    remote.onmessage = (ev) => {
      if (local.readyState === WebSocket.OPEN) local.send(ev.data);
      else toLocal.push(ev.data);
    };
    // Chrome (local) → (remote) → cdp-relay → chrome-devtools-mcp
    local.onmessage = (ev) => {
      if (remote.readyState === WebSocket.OPEN) remote.send(ev.data);
      else toRemote.push(ev.data);
    };

    local.onclose = (e) => done(`local closed (${e.code})`);
    remote.onclose = (e) => done(`remote closed (${e.code} ${e.reason || ""})`);
    local.onerror = () => done("local error");
    remote.onerror = () => done("remote error");
  });
}

// ─── MCP passthrough モード (--mcp、Refs #81) ────────────────────────────────

const mcpRelayWsUrl = `${relayWss(cfg.relay)}/mcpbridge/${encodeURIComponent(cfg.session)}?token=${encodeURIComponent(cfg.token)}`;

/**
 * 1 セッション分の MCP passthrough。chrome-devtools-mcp を spawn し、
 * その stdio (newline-delimited JSON-RPC) と relay の /mcpbridge WS を 1 行 = 1 フレームで
 * 双方向パイプする。client (CCoW の stdio シム) が切断すると DO が bridge 脚も畳むので、
 * child を kill して resolve する (次のループで新しい child + 新しい WS = クリーンな
 * MCP 状態で待ち受け直す。MCP の initialize は client 接続ごとに 1 回きりのため)。
 */
function runOnceMcp() {
  return new Promise((resolve, reject) => {
    const cmd = cfg.mcpCmd !== ""
      ? cfg.mcpCmd
      : `npx -y chrome-devtools-mcp@latest --browserUrl http://${cfg.host}:${cfg.port}`;
    const [exe, ...exeArgs] = cmd.split(/\s+/);
    // Windows の npx は .cmd シム経由なので shell: true で解決する。
    const child = spawn(exe, exeArgs, { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
    log(`mcp child spawn: ${cmd} (pid ${child.pid ?? "?"})`);

    const remote = new WebSocket(mcpRelayWsUrl);
    let settled = false;
    const done = (why, isErr) => {
      if (settled) return;
      settled = true;
      log("mcp session end:", why);
      try { child.kill(); } catch {}
      try { remote.close(); } catch {}
      if (isErr) reject(new Error(why));
      else resolve();
    };

    // child stdout (JSONL) → 1 行 = 1 WS フレーム。相手が開くまでバッファ。
    const toRemote = [];
    let stdoutBuf = "";
    child.stdout.on("data", (d) => {
      stdoutBuf += d.toString("utf8");
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).replace(/\r$/, "");
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line === "") continue;
        if (remote.readyState === WebSocket.OPEN) remote.send(line);
        else toRemote.push(line);
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(`[chrome-devtools-mcp] ${d}`));
    child.on("exit", (code) => done(`mcp child exit (${code})`, code !== 0 && code !== null));
    child.on("error", (e) => done(`mcp child spawn error: ${e.message}`, true));

    remote.onopen = () => {
      log("mcp remote (cdp-relay) open:", mcpRelayWsUrl.replace(/token=[^&]+/, "token=***"));
      while (toRemote.length) remote.send(toRemote.shift());
    };
    // relay (CCoW シム) → child stdin。1 フレーム = 1 行。
    remote.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
      child.stdin.write(data + "\n");
    };
    remote.onclose = (e) => done(`mcp remote closed (${e.code} ${e.reason || ""})`);
    remote.onerror = () => done("mcp remote error");
  });
}

async function main() {
  log(`session=${cfg.session} relay=${cfg.relay} chrome=${cfg.host}:${cfg.port} mode=${cfg.mcp ? "mcp" : "cdp"}`);
  let backoff = 1000;
  // cdp-relay は client が切断すると bridge 脚も畳む設計なので、1 セッション終了ごとに
  // 手元側 (実 Chrome の WS / chrome-devtools-mcp child) を張り直して次の client を待つ
  // (= 毎回クリーンな状態で始まる)。到達不能・spawn 失敗はバックオフして再試行する。
  for (;;) {
    try {
      if (cfg.mcp) {
        await runOnceMcp();
      } else {
        const browserWs = await discoverBrowserWs();
        await runOnce(browserWs);
      }
      backoff = 1000;
    } catch (e) {
      log("retry:", e.message || String(e));
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15000);
      continue;
    }
    // 正常終了 (client 切断など) は即座に次の待受へ。
    await new Promise((r) => setTimeout(r, 300));
  }
}

process.on("SIGINT", () => { log("bye"); process.exit(0); });
main();
