/** cdp-relay popup — 設定の保存・タブ選択・接続トリガ。 */

const $ = (id) => document.getElementById(id);

// 接続用プロンプト生成に使う値は popup を開いた時点で先読みキャッシュする。
// クリック handler 内で fetch を await すると user gesture が切れて
// clipboard.writeText が拒否されるため (cdp-relay#33)。
let cachedMcpUrl = "";
let activeTabUrl = "";

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
  const active = tabs.find((t) => t.active);
  if (active && active.url) activeTabUrl = active.url;
  if (c.tabId == null && active) sel.value = String(active.id);

  // MCP URL を先読みしておく (クリック時は await を挟まず同期コピーできるように)。
  refreshMcpUrl();
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

/** agent の /ext/info から MCP URL を取得して cache する。失敗時は空文字。 */
async function refreshMcpUrl() {
  const relayUrl = ($("relayUrl").value.trim() || "http://127.0.0.1:19222").replace(/\/+$/, "");
  try {
    const info = await fetch(`${relayUrl}/ext/info`).then((r) => r.json());
    cachedMcpUrl = (info && info.mcp_url) || "";
  } catch {
    cachedMcpUrl = "";
  }
  return cachedMcpUrl;
}

/** CCoW に貼る接続用プロンプトを組み立てる。 */
function buildPrompt(mcp, here) {
  return (
    `手元 Chrome を cdp-relay 経由で操作してください。\n` +
    `MCP エンドポイント: ${mcp}\n\n` +
    `この MCP に対し tools/call で browser_navigate / browser_screenshot を使えます。\n` +
    `まず browser_screenshot で現在の画面（${here}）を確認してから、指示に従って操作してください。\n\n` +
    `例: curl -sS -X POST ${mcp} -H 'Content-Type: application/json' \\\n` +
    `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_screenshot","arguments":{}}}'`
  );
}

/** textarea に出して全選択する (手動コピーの保険、常に表示)。 */
function showPrompt(text) {
  const ta = $("promptOut");
  ta.value = text;
  ta.style.display = "block";
  ta.focus();
  ta.select();
}

/**
 * gesture を保ったまま同期的にコピーする。textarea を選択して execCommand('copy')
 * を使う (popup でも確実)。併せて clipboard API も fire-and-forget で試す。
 * 戻り値は execCommand の成否 (false でも textarea から手動コピー可)。
 */
function copyTextSync(text) {
  showPrompt(text);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
  return ok;
}

$("connect").addEventListener("click", async () => {
  await save();
  setStatus("接続中…");
  const res = await chrome.runtime.sendMessage({ type: "cdp-relay-connect" }).catch((e) => ({ ok: false, error: String(e) }));
  if (!res || !res.ok) setStatus("接続失敗: " + (res && res.error ? res.error : "unknown"), "err");
  // 接続したら tunnel URL が遅れて立つので、少し置いて先読みし直す。
  setTimeout(refreshMcpUrl, 4000);
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

// 接続用プロンプトをコピー: 先読み済みの MCP URL から同期コピー。
// 未取得なら取りに行き、textarea に出して手動コピーに倒す (gesture が切れるため)。
$("copyPrompt").addEventListener("click", async () => {
  const here = activeTabUrl || "(現在のタブ)";
  if (cachedMcpUrl) {
    const ok = copyTextSync(buildPrompt(cachedMcpUrl, here));
    setStatus(
      ok ? "接続用プロンプトをコピーしました（CCoW に貼り付け）" : "下の枠から手動でコピーしてください",
      ok ? "ok" : "err",
    );
    return;
  }
  // 未取得: ここで取得 (この後 gesture が切れるので textarea 手動コピーに倒す)。
  const mcp = await refreshMcpUrl();
  if (!mcp) {
    setStatus("MCP URL 未確定（agent が tunnel を張るまで数秒待って再度）", "err");
    return;
  }
  showPrompt(buildPrompt(mcp, here));
  setStatus("下の枠に表示しました。Ctrl+C で手動コピーしてください", "ok");
});

// background からの状態通知。
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "cdp-relay-status") {
    const cls = msg.state === "connected" ? "ok" : msg.state === "error" ? "err" : "";
    setStatus(`${msg.state}: ${msg.detail || ""}`, cls);
  }
});

restore();
