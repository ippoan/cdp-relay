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
const KEEPALIVE_ALARM = "cdp-relay-keepalive";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Relay URL が localhost (= agent モード) か。 */
function isAgentUrl(relayUrl) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(relayUrl.trim());
}

/** popup / storage の設定を読む。 */
async function loadConfig() {
  const c = await chrome.storage.local.get(["relayUrl", "session", "token", "tabId"]);
  return {
    relayUrl: c.relayUrl || "",
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
  await chrome.debugger.attach({ tabId }, "1.3");
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  attachedTabId = tabId;
}

async function connect() {
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
    try {
      await attach(cfg.tabId);
    } catch (e) {
      reportStatus("error", "debugger attach 失敗: " + (e && e.message ? e.message : String(e)));
      return;
    }
    agentRunning = true;
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
    disconnect().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// keepalive: WS が開いていれば ping を打って SW を生かす (agent モードは long-poll fetch が生かす)。
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send("ping");
    } catch {
      /* noop */
    }
  }
});

// 対象タブが閉じたら片付ける。
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === attachedTabId) disconnect();
});
