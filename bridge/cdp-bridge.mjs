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
const cfg = {
  session: args.session ?? process.env.CDP_BRIDGE_SESSION ?? "",
  token: args.token ?? process.env.CDP_BRIDGE_TOKEN ?? "",
  relay: (args.relay ?? process.env.CDP_BRIDGE_RELAY ?? "https://cdp-relay.ippoan.org").replace(/\/+$/, ""),
  host: args.host ?? process.env.CDP_BRIDGE_HOST ?? "127.0.0.1",
  port: args.port ?? process.env.CDP_BRIDGE_PORT ?? "9222",
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

async function main() {
  log(`session=${cfg.session} relay=${cfg.relay} chrome=${cfg.host}:${cfg.port}`);
  let backoff = 1000;
  // cdp-relay は client (chrome-devtools-mcp) が切断すると bridge 脚も畳む設計なので、
  // 1 セッション終了ごとに実 Chrome の WS を張り直して次の client を待つ (= 毎回クリーンな
  // CDP 状態で始まる)。実 Chrome / relay 到達不能はバックオフして再試行する。
  for (;;) {
    try {
      const browserWs = await discoverBrowserWs();
      backoff = 1000;
      await runOnce(browserWs);
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
