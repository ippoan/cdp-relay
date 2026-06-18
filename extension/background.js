/**
 * cdp-relay MV3 拡張 — service worker。
 *
 * 2 つの接続モードを持つ:
 *
 *  - **WS モード** (Relay URL が remote、例 https://cdp-relay.ippoan.org):
 *    `wss://<relayUrl>/ext/<session>?token=<token>` に outbound 接続し、Worker+DO が
 *    転送する method を CDP に翻訳する。screenshot は PNG を /shot に PUT して shot_url。
 *
 *  - **agent モード** (Relay URL が http://127.0.0.1:<extPort> / localhost):
 *    手元 cdp-agent の ext port に **long-poll** で繋ぐ (cdp-relay#12 M2)。
 *    `GET /ext/poll` で CDP コマンドを引き、実行結果を `POST /ext/result` で返す。
 *    session / token は不要 (localhost 専用 port)。screenshot は base64 PNG を
 *    `{ data }` で直接返す (agent が MCP image content にする)。
 *
 * MV3 の service worker は idle で停止するため、WS の周期 ping / agent の long-poll
 * (= 継続的な fetch) で接続を生かし続ける。
 */

let ws = null;
let attachedTabId = null;
let agentRunning = false;
// 接続処理中フラグ。SW 起動直後の自動再接続 (top-level) と onAlarm / popup が
// 同時に connect() を呼んでも二重接続しないように guard する。
let connecting = false;
const KEEPALIVE_ALARM = "cdp-relay-keepalive";

/** Native Messaging host 名 (agent の --install-native-host が登録する manifest と一致)。 */
const NATIVE_HOST = "com.ippoan.cdp_agent";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Relay URL が localhost (= agent モード) か。 */
function isAgentUrl(relayUrl) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(relayUrl.trim());
}

/** agent (ext server) に到達できるか。`/ext/info` を短 timeout で叩いて判定。 */
async function pingAgent(base, timeoutMs = 1500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/ext/info`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Native Messaging で手元 cdp-agent を起動依頼する (cdp-relay#33)。
 * host は agent を detached spawn して即応答する (ランチャー)。host 未登録なら
 * lastError が立つので throw する (= 呼び出し側は手動起動を案内)。
 */
function sendNative(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (resp) => {
        if (settled) return;
        settled = true;
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || "native messaging 失敗"));
          return;
        }
        resolve(resp || {});
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
  });
}

/** host 未登録なら throw → connect() が手動起動を案内。 */
function startAgentViaNative() {
  return sendNative({ cmd: "start" });
}

/**
 * 接続のたびに旧 agent を**必ず taskkill して最新インストール版で起動し直す** (#54 後の
 * 「旧バイナリが居座って browser_eval 等の新ツールが出ない」対策)。restart を理解しない
 * 旧バイナリ (unknown cmd) や host 未登録なら従来の start 経路に fallback する。
 */
async function ensureAgentFresh(base) {
  reportStatus("starting", "agent を再起動中 (最新版で起動)…");
  let resp = null;
  try {
    resp = await sendNative({ cmd: "restart" });
  } catch {
    resp = null; // host 未登録等 → fallback で扱う
  }
  // restart 非対応 (旧バイナリ unknown cmd) / host 未登録 → 従来の start (未起動なら spawn)。
  if (!resp || resp.ok === false) {
    await ensureAgentRunning(base);
    return;
  }
  // restart 成功 (kill→spawn 済み)。新 agent が ext server を bind するまで待つ。
  for (let i = 0; i < 20; i++) {
    if (await pingAgent(base)) return;
    await sleep(500);
  }
  throw new Error("agent restart 後に ext server へ到達できない");
}

/**
 * agent が起動済みであることを保証する。未到達なら Native Messaging で起動依頼し、
 * tunnel/HTTP server が立ち上がるまで `/ext/info` を polling する。
 */
async function ensureAgentRunning(base) {
  if (await pingAgent(base)) return; // 既に起動済み

  reportStatus("starting", "Native Messaging で agent を起動中…");
  await startAgentViaNative(); // host 未登録なら throw → connect() が error 表示

  // spawn 直後は ext server 未バインドのことがあるので最大 ~10s 待つ。
  for (let i = 0; i < 20; i++) {
    if (await pingAgent(base)) return;
    await sleep(500);
  }
  throw new Error("agent を起動したが ext server に到達できない");
}

/** popup / storage の設定を読む。Relay URL 未設定なら手元 agent (19222) に fallback。 */
async function loadConfig() {
  const c = await chrome.storage.local.get(["relayUrl", "session", "token", "tabId"]);
  return {
    relayUrl: c.relayUrl || "http://127.0.0.1:19222",
    session: c.session || "",
    token: c.token || "",
    tabId: typeof c.tabId === "number" ? c.tabId : null,
  };
}

/** popup へ接続状態を伝える (popup が開いていなければ無視される)。 */
function reportStatus(state, detail) {
  chrome.runtime.sendMessage({ type: "cdp-relay-status", state, detail }).catch(() => {});
}

/** relayUrl ("https://host" or "host") を wss base に正規化する。 */
function toWssBase(relayUrl) {
  let u = relayUrl.trim().replace(/\/+$/, "");
  if (u.startsWith("https://")) return "wss://" + u.slice("https://".length);
  if (u.startsWith("http://")) return "ws://" + u.slice("http://".length);
  if (u.startsWith("wss://") || u.startsWith("ws://")) return u;
  return "wss://" + u;
}
/** relayUrl を https base (shot PUT 用) に正規化する。 */
function toHttpsBase(relayUrl) {
  let u = relayUrl.trim().replace(/\/+$/, "");
  if (u.startsWith("wss://")) return "https://" + u.slice("wss://".length);
  if (u.startsWith("ws://")) return "http://" + u.slice("ws://".length);
  if (u.startsWith("https://") || u.startsWith("http://")) return u;
  return "https://" + u;
}

/** 対象タブに debugger attach する (共通)。 */
async function attach(tabId) {
  // 自動再接続 (SW idle 死からの復帰) で前回の attach が残っていることがあるので、
  // 念のため一度 detach してから attach する (未 attach なら detach は無害に失敗)。
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* not attached */
  }
  await chrome.debugger.attach({ tabId }, "1.3");
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  attachedTabId = tabId;
}

async function connect() {
  // 二重接続 guard (top-level 自動再接続 / onAlarm / popup の同時呼びを束ねる)。
  if (connecting) return;
  connecting = true;
  try {
    await connectInner();
  } finally {
    connecting = false;
  }
}

async function connectInner() {
  const cfg = await loadConfig();
  if (!cfg.relayUrl) {
    reportStatus("error", "Relay URL が未設定");
    return;
  }
  if (cfg.tabId == null) {
    reportStatus("error", "対象タブ未選択");
    return;
  }

  await disconnect();

  // agent モード: localhost の cdp-agent に long-poll で繋ぐ。session/token 不要。
  if (isAgentUrl(cfg.relayUrl)) {
    // agent 未起動なら Native Messaging で起動依頼する (cdp-relay#33)。
    const agentBase = cfg.relayUrl.trim().replace(/\/+$/, "");
    try {
      // 接続のたびに旧 agent を kill して最新版で起動し直す (旧バイナリ居座り対策)。
      await ensureAgentFresh(agentBase);
    } catch (e) {
      reportStatus(
        "error",
        "agent 起動失敗: " +
          (e && e.message ? e.message : String(e)) +
          " (cdp-agent --install-native-host 済みか確認)",
      );
      return;
    }
    try {
      await attach(cfg.tabId);
    } catch (e) {
      reportStatus("error", "debugger attach 失敗: " + (e && e.message ? e.message : String(e)));
      return;
    }
    agentRunning = true;
    // 接続意図を永続化 + keepalive alarm。MV3 SW が idle で落ちても alarm が SW を
    // 起こし、onAlarm が agentRunning=false を見て自動再接続する (cdp-relay#33)。
    await chrome.storage.local.set({ autoConnect: true });
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~24s
    reportStatus("connected", `agent mode tab=${cfg.tabId}`);
    agentLoop(cfg); // 非 await: 背景で回す
    return;
  }

  // WS モード: remote Worker+DO に接続。session/token 必須。
  if (!cfg.session || !cfg.token) {
    reportStatus("error", "session / token が未設定 (WS モード)");
    return;
  }
  try {
    await attach(cfg.tabId);
  } catch (e) {
    reportStatus("error", "debugger attach 失敗: " + (e && e.message ? e.message : String(e)));
    return;
  }

  const wssBase = toWssBase(cfg.relayUrl);
  const url = `${wssBase}/ext/${encodeURIComponent(cfg.session)}?token=${encodeURIComponent(cfg.token)}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    reportStatus("connected", `session=${cfg.session} tab=${cfg.tabId}`);
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~24s
  };
  ws.onclose = () => {
    reportStatus("disconnected", "WS closed");
  };
  ws.onerror = () => {
    reportStatus("error", "WS error");
  };
  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "pong") return;
    const { id, method, params } = msg;
    if (typeof id !== "number" || typeof method !== "string") return;
    try {
      const result = await handle(method, params || {}, cfg, "ws");
      ws.send(JSON.stringify({ id, result }));
    } catch (e) {
      ws.send(JSON.stringify({ id, error: e && e.message ? e.message : String(e) }));
    }
  };
}

/** agent モード: ext port に long-poll して CDP コマンドを往復する。 */
async function agentLoop(cfg) {
  const base = cfg.relayUrl.trim().replace(/\/+$/, "");
  while (agentRunning) {
    let res;
    try {
      res = await fetch(`${base}/ext/poll`);
    } catch {
      await sleep(1000); // agent が落ちている等。間を置いて再試行。
      continue;
    }
    if (res.status === 204) continue; // long-poll 空振り → 再 poll
    if (!res.ok) {
      await sleep(1000);
      continue;
    }
    let cmd;
    try {
      cmd = await res.json();
    } catch {
      continue;
    }
    if (typeof cmd.id !== "number" || typeof cmd.method !== "string") continue;

    let body;
    try {
      const result = await handle(cmd.method, cmd.params || {}, cfg, "agent");
      body = { id: cmd.id, result };
    } catch (e) {
      body = { id: cmd.id, error: e && e.message ? e.message : String(e) };
    }
    try {
      await fetch(`${base}/ext/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      /* 結果返送に失敗しても次の poll を続ける */
    }
  }
}

async function disconnect() {
  agentRunning = false;
  chrome.alarms.clear(KEEPALIVE_ALARM);
  if (ws) {
    try {
      ws.close();
    } catch {
      /* noop */
    }
    ws = null;
  }
  if (attachedTabId != null) {
    try {
      await chrome.debugger.detach({ tabId: attachedTabId });
    } catch {
      /* already detached */
    }
    attachedTabId = null;
  }
}

/**
 * 高レベル method を CDP に翻訳して実行する。
 * mode="agent" は screenshot を base64 PNG `{ data }` で返す (agent が image content 化)。
 * mode="ws" は screenshot を /shot に PUT して `{ shot_url }` を返す。
 */
async function handle(method, params, cfg, mode) {
  const target = { tabId: cfg.tabId };
  switch (method) {
    case "navigate": {
      if (!params.url || !/^https?:\/\//i.test(params.url)) throw new Error("url must be http(s)");
      const loaded = waitForLoad(target);
      await chrome.debugger.sendCommand(target, "Page.navigate", { url: params.url });
      await loaded;
      return { url: params.url };
    }
    case "screenshot": {
      const shot = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
        format: "png",
      });
      if (mode === "agent") {
        return { data: shot.data }; // base64 PNG をそのまま返す
      }
      const bytes = base64ToBytes(shot.data);
      const shotUrl = await uploadShot(bytes, cfg);
      return { shot_url: shotUrl };
    }
    case "eval": {
      if (typeof params.expression !== "string" || params.expression === "")
        throw new Error("expression is required");
      // Runtime.evaluate は returnByValue で JSON 化可能な値を直接返す。
      // awaitPromise で式が Promise を返すケースも解決する。
      const r = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: params.expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        const ex = r.exceptionDetails;
        throw new Error(
          (ex.exception && (ex.exception.description || ex.exception.value)) ||
            ex.text ||
            "eval exception",
        );
      }
      return { value: r.result ? r.result.value : null };
    }
    default:
      throw new Error("unknown method: " + method);
  }
}

/** Page.loadEventFired を最大 25s 待つ。 */
function waitForLoad(target) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.debugger.onEvent.removeListener(onEvent);
      resolve(); // タイムアウトしても navigate 自体は成功扱い (load 待ちは best-effort)
    }, 25_000);
    function onEvent(source, evMethod) {
      if (source.tabId === target.tabId && evMethod === "Page.loadEventFired") {
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(onEvent);
        resolve();
      }
    }
    chrome.debugger.onEvent.addListener(onEvent);
  });
}

/** PNG bytes を Worker の /shot に PUT して shot_url を得る (WS モードのみ)。 */
async function uploadShot(bytes, cfg) {
  const httpsBase = toHttpsBase(cfg.relayUrl);
  const url = `${httpsBase}/shot/${encodeURIComponent(cfg.session)}?token=${encodeURIComponent(cfg.token)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: bytes,
  });
  if (!res.ok) throw new Error("shot upload failed: " + res.status);
  const body = await res.json();
  return body.shot_url;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// popup からの指示。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "cdp-relay-connect") {
    connect().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }
  if (msg && msg.type === "cdp-relay-disconnect") {
    // 明示切断: 自動再接続の意図もクリアする。
    chrome.storage.local.set({ autoConnect: false });
    disconnect().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// keepalive: alarm で SW を周期的に起こす。
//  - WS モード: ping で接続を生かす。
//  - agent モード: SW idle 死で loop が止まっていたら (agentRunning=false)、接続意図が
//    残っていれば自動再接続する。これで放置後も接続が切れない (cdp-relay#33)。
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send("ping");
    } catch {
      /* noop */
    }
    return;
  }
  if (agentRunning) return; // agent loop は生きている
  const { autoConnect } = await chrome.storage.local.get("autoConnect");
  if (autoConnect) connect().catch(() => {});
});

// 対象タブが閉じたら片付ける + 自動再接続も止める (タブが無いので繋ぎ直せない)。
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === attachedTabId) {
    chrome.storage.local.set({ autoConnect: false });
    disconnect();
  }
});

/**
 * SW 起動時に接続意図 (autoConnect) が残っていれば再接続する。
 *
 * 「更新（拡張を再読込）」ボタンは chrome.runtime.reload() で service worker を
 * 作り直すだけで、接続 (ws / agentLoop) も keepalive alarm も復元しない。
 * chrome.runtime.reload() は onInstalled / onStartup を発火させないため、SW が
 * 再評価される度に必ず走る top-level でのみ確実に再接続できる。これが無いと
 * 更新ボタン押下後に再接続されず「更新ボタンが動かない」症状になる (cdp-relay#33)。
 */
async function autoReconnectOnBoot() {
  try {
    const { autoConnect } = await chrome.storage.local.get("autoConnect");
    if (autoConnect) await connect();
  } catch {
    /* storage 読めない等は無視 (popup の「接続」で手動復帰できる) */
  }
}

// browser / profile 起動時にも alarm 待ちにせず即再接続する。
chrome.runtime.onStartup.addListener(() => {
  autoReconnectOnBoot();
});

// SW が起動するたび (更新ボタンの reload / idle 復帰 / install / 更新) に走る。
// connect() の二重接続 guard が onStartup / onAlarm との競合を吸収する。
autoReconnectOnBoot();
