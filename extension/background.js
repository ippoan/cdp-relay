/**
 * cdp-relay MV3 拡張 — service worker。
 *
 * popup で保存した設定 ({ relayUrl, session, token, tabId }) を使って
 * `wss://<relayUrl>/ext/<session>?token=<token>` に outbound 接続し、Worker+DO が
 * 転送する高レベル method を CDP (chrome.debugger.sendCommand) に翻訳して実行する。
 *
 *   navigate   → Page.navigate + Page.loadEventFired 待ち
 *   screenshot → Page.captureScreenshot → PNG を /shot に PUT → { shot_url }
 *
 * MV3 の service worker は idle で停止するため、WS の周期 ping と chrome.alarms で
 * 接続を生かし続ける (Chrome 116+ は WS activity が SW lifetime を延長する)。
 */

let ws = null;
let attachedTabId = null;
const KEEPALIVE_ALARM = "cdp-relay-keepalive";

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

async function connect() {
  const cfg = await loadConfig();
  if (!cfg.relayUrl || !cfg.session || !cfg.token) {
    reportStatus("error", "relayUrl / session / token が未設定");
    return;
  }
  if (cfg.tabId == null) {
    reportStatus("error", "対象タブ未選択");
    return;
  }

  // 既存接続/attach を片付ける。
  await disconnect();

  // 対象タブに debugger attach。
  try {
    await chrome.debugger.attach({ tabId: cfg.tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId: cfg.tabId }, "Page.enable");
    attachedTabId = cfg.tabId;
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
      const result = await handle(method, params || {}, cfg);
      ws.send(JSON.stringify({ id, result }));
    } catch (e) {
      ws.send(JSON.stringify({ id, error: e && e.message ? e.message : String(e) }));
    }
  };
}

async function disconnect() {
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

/** 高レベル method を CDP に翻訳して実行する。 */
async function handle(method, params, cfg) {
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

/** PNG bytes を Worker の /shot に PUT して shot_url を得る。 */
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

// keepalive: WS が開いていれば ping を打って SW を生かす。
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
