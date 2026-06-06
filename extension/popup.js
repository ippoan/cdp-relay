/** cdp-relay popup — 設定の保存・タブ選択・接続トリガ。 */

const $ = (id) => document.getElementById(id);

async function restore() {
  // 現在の拡張バージョンを表示 (manifest.json の version)。
  $("ver").textContent = "v" + chrome.runtime.getManifest().version;

  const c = await chrome.storage.local.get(["relayUrl", "session", "token", "tabId"]);
  // 未設定なら手元 agent (固定 ext port 19222) を既定で埋める。
  $("relayUrl").value = c.relayUrl || "http://127.0.0.1:19222";
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

// 更新ボタン: 拡張を再読込してディスク上の最新ファイル (agent が更新したもの) を反映。
// unpacked 拡張は reload でディスクから再読込される。接続は切れるので再接続が必要。
$("reload").addEventListener("click", () => {
  if (confirm("拡張を再読込します（接続は切れます）。agent が更新した最新ファイルが反映されます。")) {
    chrome.runtime.reload();
  }
});

// 接続用プロンプトをコピー: agent の /ext/info から MCP URL を取り、現在タブと併せて
// CCoW (Claude) に貼るだけで手元 Chrome を操作開始できるプロンプトをクリップボードへ。
$("copyPrompt").addEventListener("click", async () => {
  try {
    const relayUrl = ($("relayUrl").value.trim() || "http://127.0.0.1:19222").replace(/\/+$/, "");
    const info = await fetch(`${relayUrl}/ext/info`)
      .then((r) => r.json())
      .catch(() => ({ mcp_url: "" }));
    const mcp = info.mcp_url || "";
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const here = tab && tab.url ? tab.url : "(現在のタブ)";

    if (!mcp) {
      setStatus("MCP URL 未確定（agent が tunnel を張るまで待つ）", "err");
      return;
    }
    const prompt =
      `手元 Chrome を cdp-relay 経由で操作してください。\n` +
      `MCP エンドポイント: ${mcp}\n\n` +
      `この MCP に対し tools/call で browser_navigate / browser_screenshot を使えます。\n` +
      `まず browser_screenshot で現在の画面（${here}）を確認してから、指示に従って操作してください。\n\n` +
      `例: curl -sS -X POST ${mcp} -H 'Content-Type: application/json' \\\n` +
      `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_screenshot","arguments":{}}}'`;

    await navigator.clipboard.writeText(prompt);
    setStatus("接続用プロンプトをコピーしました（CCoW に貼り付け）", "ok");
  } catch (e) {
    setStatus("コピー失敗: " + (e && e.message ? e.message : String(e)), "err");
  }
});

// background からの状態通知。
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "cdp-relay-status") {
    const cls = msg.state === "connected" ? "ok" : msg.state === "error" ? "err" : "";
    setStatus(`${msg.state}: ${msg.detail || ""}`, cls);
  }
});

restore();
