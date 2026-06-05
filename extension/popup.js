/** cdp-relay popup — 設定の保存・タブ選択・接続トリガ。 */

const $ = (id) => document.getElementById(id);

async function restore() {
  const c = await chrome.storage.local.get(["relayUrl", "session", "token", "tabId"]);
  if (c.relayUrl) $("relayUrl").value = c.relayUrl;
  if (c.session) $("session").value = c.session;
  if (c.token) $("token").value = c.token;

  // 現ウィンドウのタブ一覧を埋める。
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const sel = $("tab");
  sel.innerHTML = "";
  for (const t of tabs) {
    const opt = document.createElement("option");
    opt.value = String(t.id);
    opt.textContent = (t.title || t.url || "(tab)").slice(0, 48);
    if (t.id === c.tabId) opt.selected = true;
    sel.appendChild(opt);
  }
  // 既定は現在アクティブなタブ。
  if (c.tabId == null) {
    const active = tabs.find((t) => t.active);
    if (active) sel.value = String(active.id);
  }
}

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = cls || "";
}

async function save() {
  await chrome.storage.local.set({
    relayUrl: $("relayUrl").value.trim(),
    session: $("session").value.trim(),
    token: $("token").value,
    tabId: Number($("tab").value),
  });
}

$("connect").addEventListener("click", async () => {
  await save();
  setStatus("接続中…");
  const res = await chrome.runtime.sendMessage({ type: "cdp-relay-connect" }).catch((e) => ({ ok: false, error: String(e) }));
  if (!res || !res.ok) setStatus("接続失敗: " + (res && res.error ? res.error : "unknown"), "err");
});

$("disconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "cdp-relay-disconnect" }).catch(() => {});
  setStatus("切断しました");
});

// background からの状態通知。
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "cdp-relay-status") {
    const cls = msg.state === "connected" ? "ok" : msg.state === "error" ? "err" : "";
    setStatus(`${msg.state}: ${msg.detail || ""}`, cls);
  }
});

restore();
