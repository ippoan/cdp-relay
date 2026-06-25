/** cdp-relay popup — 設定の保存・タブ選択・接続トリガ。 */

const $ = (id) => document.getElementById(id);

// 接続用プロンプト生成に使う値は popup を開いた時点で先読みキャッシュする。
// クリック handler 内で fetch を await すると user gesture が切れて
// clipboard.writeText が拒否されるため (cdp-relay#33)。
let cachedMcpUrl = "";
let activeTabUrl = "";
let extVer = "";
let agentVer = "";

// ヘッダのバージョン表示。拡張 version は常に、agent version は /ext/info 取得後に併記。
function renderVer() {
  $("ver").textContent = "ext v" + extVer + (agentVer ? "  ·  agent " + agentVer : "");
}

/** Relay URL が localhost (= agent mode) か。background.js と同判定。 */
function isAgentUrl(relayUrl) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test((relayUrl || "").trim());
}

/** agent mode では session / token は不要なので隠す (WS mode のみ表示)。 */
function toggleModeFields() {
  const agent = isAgentUrl($("relayUrl").value);
  $("sessionRow").style.display = agent ? "none" : "";
  $("tokenRow").style.display = agent ? "none" : "";
}

async function restore() {
  // 現在の拡張バージョンを表示 (manifest.json の version)。agent version は後で併記。
  extVer = chrome.runtime.getManifest().version;
  renderVer();

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

  // agent / WS mode に応じて session/token の表示を切り替える。
  toggleModeFields();

  // 既に溜まっている debug ログを取り出してパネルに描画する。
  loadLogs();

  // MCP URL を取得して接続用プロンプトを textarea に出す。tunnel がまだ立って
  // いなければポーリングして進捗を見せる (= 「何も表示されない」を防ぐ)。
  startPromptPoll();
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
    if (info && info.version) {
      agentVer = info.version;
      renderVer();
    }
  } catch {
    cachedMcpUrl = "";
  }
  return cachedMcpUrl;
}

/** CCoW に貼る接続用プロンプトを組み立てる。 */
function buildPrompt(mcp, here) {
  // agent のビルド版 (release tag、例 cdp-agent-dev-33) を明記する。どの版が動いて
  // いるかでツール面 (browser_eval の有無等) が変わるため、貼り先で判別できるようにする。
  const ver = agentVer || "unknown";
  return (
    `手元 Chrome を cdp-relay 経由で操作してください。\n` +
    `MCP エンドポイント: ${mcp}\n` +
    `agent version: ${ver} / 拡張 version: ${extVer}\n\n` +
    `この MCP に対し tools/call で browser_navigate / browser_screenshot / browser_eval を使えます。\n` +
    `(browser_eval が無ければ agent が古い → tools/list で確認)\n` +
    `まず browser_screenshot で現在の画面（${here}）を確認してから、指示に従って操作してください。\n\n` +
    `例: curl -sS -X POST ${mcp} -H 'Content-Type: application/json' \\\n` +
    `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_screenshot","arguments":{}}}'`
  );
}

/** 接続用プロンプトを textarea に出しておく (常時表示・手動コピーの保険)。 */
function showPrompt(text) {
  $("promptOut").value = text;
}

/** 先読み済み MCP URL から接続用プロンプトを textarea に prefill する。 */
function prefillPrompt() {
  if (!cachedMcpUrl) return;
  showPrompt(buildPrompt(cachedMcpUrl, activeTabUrl || "(現在のタブ)"));
}

// 接続用プロンプトは agent の tunnel (mcp_url) が立つまで出せない。立つまで数秒〜
// 十数秒かかるので、ポーリングしつつ textarea に進捗を出して「無反応」を防ぐ。
let promptPollTimer = null;
function stopPromptPoll() {
  if (promptPollTimer) {
    clearInterval(promptPollTimer);
    promptPollTimer = null;
  }
}
/**
 * mcp_url が取れるまで ~2s 間隔で /ext/info を引き直し、取れたら接続用プロンプトを
 * textarea に出す。取得待ちの間も「取得中… [n]」を出して進捗を見せる。
 */
function startPromptPoll() {
  stopPromptPoll();
  // 既に取得済みなら即出して終わり。
  if (cachedMcpUrl) {
    prefillPrompt();
    return;
  }
  let tries = 0;
  const MAX = 30; // ~60s
  const tick = async () => {
    tries++;
    await refreshMcpUrl();
    if (cachedMcpUrl) {
      prefillPrompt();
      setStatus("接続用プロンプトを下の枠に表示しました（コピー可）", "ok");
      stopPromptPoll();
      return;
    }
    // まだ tunnel が立っていない。進捗を見せる (空白で無反応に見せない)。
    $("promptOut").value =
      `MCP URL を取得中… (agent が tunnel を張るまで数秒) [${tries}/${MAX}]\n` +
      `接続直後は時間がかかります。このまま少し待ってください。`;
    if (tries >= MAX) {
      stopPromptPoll();
      $("promptOut").value =
        "MCP URL を取得できませんでした。\n" +
        "agent が起動/接続済みか確認し、『更新』→『接続』後にもう一度開いてください。";
      setStatus("MCP URL 未確定（agent / tunnel の状態を確認）", "err");
    }
  };
  promptPollTimer = setInterval(tick, 2000);
  tick(); // 初回は即実行 (待ち表示をすぐ出す)
}

/**
 * gesture を保ったまま同期コピーする汎用ヘルパ。一時 textarea を選択して
 * execCommand('copy') を使う (MV3 popup でも確実)。併せて clipboard API も
 * fire-and-forget で試す。戻り値は execCommand の成否 (false でも枠から手動コピー可)。
 */
function copyToClipboard(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
  return ok;
}

// ─── debug ログパネル ───────────────────────────────────────────────────────
function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 1 エントリを #log に追記し、最下部に居たらスクロール追従する。 */
function appendLog(entry) {
  const box = $("log");
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
  const line = document.createElement("div");
  line.className = "line";
  const ts = document.createElement("span");
  ts.className = "t";
  ts.textContent = fmtTime(entry.t) + " ";
  const msg = document.createElement("span");
  if (/error|fail|失敗/i.test(entry.msg)) msg.className = "e";
  msg.textContent = entry.msg; // textContent で描画 (XSS 回避)
  line.appendChild(ts);
  line.appendChild(msg);
  box.appendChild(line);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/** 全ログを描画し直す。 */
function renderLogs(logs) {
  const box = $("log");
  box.textContent = "";
  for (const e of logs) appendLog(e);
  box.scrollTop = box.scrollHeight;
}

/** background が保持する現行ログを取り出して描画する。 */
async function loadLogs() {
  const r = await chrome.runtime.sendMessage({ type: "cdp-relay-getlogs" }).catch(() => null);
  if (r && r.logs) renderLogs(r.logs);
}

/** 表示中のログを 1 テキストにまとめる (コピー用)。 */
function logsToText() {
  return Array.from($("log").querySelectorAll(".line"))
    .map((l) => l.textContent)
    .join("\n");
}

// Relay URL を変えたら mode 表示を更新し、MCP URL も取り直す。
$("relayUrl").addEventListener("input", () => {
  toggleModeFields();
});

async function doConnect() {
  await save();
  setStatus("接続中…");
  const res = await chrome.runtime.sendMessage({ type: "cdp-relay-connect" }).catch((e) => ({ ok: false, error: String(e) }));
  if (!res || !res.ok) setStatus("接続失敗: " + (res && res.error ? res.error : "unknown"), "err");
  // 接続後は tunnel URL が遅れて立つので、cache を捨ててからポーリングで取り直し、
  // 立った時点で接続用プロンプトを出す (進捗は textarea に表示)。
  cachedMcpUrl = "";
  startPromptPoll();
}

$("connect").addEventListener("click", doConnect);

/**
 * `cdp1.<base64url(JSON{r,s,t})>` 接続文字列を decode する。browser_pair が返す
 * pair_string と同形式。不正なら null。
 */
function parsePairString(s) {
  s = (s || "").trim();
  if (!s.startsWith("cdp1.")) return null;
  try {
    let b64 = s.slice(5).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const o = JSON.parse(new TextDecoder().decode(bytes));
    if (o && o.r && o.s && o.t) return { relay: String(o.r), session: String(o.s), token: String(o.t) };
  } catch {
    /* 不正な文字列は無視 */
  }
  return null;
}

// 「接続文字列（1コピペ）」: cdp1.… を貼ると 3 欄を自動入力して接続まで走らせる。
// token を欄に残さないよう combo は使い捨て (クリア)。対象タブは現在の選択 (既定=アクティブ)。
$("combo").addEventListener("input", async () => {
  const p = parsePairString($("combo").value);
  if (!p) return;
  $("relayUrl").value = p.relay;
  $("session").value = p.session;
  $("token").value = p.token;
  $("combo").value = "";
  toggleModeFields();
  setStatus("接続文字列を読み込みました。接続中…");
  await doConnect();
});

$("disconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "cdp-relay-disconnect" }).catch(() => {});
  setStatus("切断しました");
});

// 更新ボタン: 拡張を再読込してディスク上の最新ファイル (agent が更新したもの) を反映。
// unpacked 拡張は reload でディスクから再読込される。接続は切れるので再接続が必要。
// NOTE: 拡張 popup 内で confirm()/alert() を呼ぶと、ダイアログ表示で popup が focus を
// 失って閉じ、その瞬間 confirm が dismiss (false) 扱いになって reload に到達しない
// (= 更新ボタンが「効かない」ように見える)。popup を閉じない 2 段階クリックで確認する。
let reloadArmed = false;
$("reload").addEventListener("click", () => {
  if (!reloadArmed) {
    reloadArmed = true;
    $("reload").textContent = "もう一度押すと再読込（接続が切れます）";
    setStatus("再読込の確認待ち。もう一度「更新」を押すと反映されます。");
    return;
  }
  chrome.runtime.reload();
});

// 接続用プロンプトをコピー: 先読み済みの MCP URL から同期コピー。
// 未取得なら取りに行き、textarea に出して手動コピーに倒す (gesture が切れるため)。
$("copyPrompt").addEventListener("click", async () => {
  const here = activeTabUrl || "(現在のタブ)";
  // 先読み済み MCP URL があれば gesture を保ったまま即コピー。
  if (cachedMcpUrl) {
    const text = buildPrompt(cachedMcpUrl, here);
    showPrompt(text);
    const ok = copyToClipboard(text);
    setStatus(
      ok
        ? "接続用プロンプトをコピーしました（CCoW に貼り付け）"
        : "コピー拒否。下の枠をクリック → Ctrl+C でコピーしてください",
      ok ? "ok" : "err",
    );
    return;
  }
  // 未取得: ポーリングを開始する。立った時点で prompt が textarea に出るので、
  // ユーザーはそれを見て押し直せば良い (取得待ちの進捗も textarea に出る)。
  setStatus("MCP URL を取得中… 下の枠に出たら再度コピーを押してください", "");
  startPromptPoll();
});

// 接続用プロンプト枠はクリックで全選択 (手動コピーを 1 操作で)。
$("promptOut").addEventListener("click", () => $("promptOut").select());

// debug ログのコピー / クリア。
$("copyLog").addEventListener("click", () => {
  const text = logsToText();
  if (!text) {
    setStatus("ログが空です", "err");
    return;
  }
  const ok = copyToClipboard(text);
  setStatus(ok ? "ログをコピーしました" : "コピー拒否（ログ枠を選択して Ctrl+C）", ok ? "ok" : "err");
});

$("clearLog").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "cdp-relay-clearlogs" }).catch(() => {});
  $("log").textContent = "";
  setStatus("ログをクリアしました");
});

// background からの状態通知。
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "cdp-relay-status") {
    const cls = msg.state === "connected" ? "ok" : msg.state === "error" ? "err" : "";
    setStatus(`${msg.state}: ${msg.detail || ""}`, cls);
  }
  if (msg && msg.type === "cdp-relay-log" && msg.entry) {
    appendLog(msg.entry);
  }
});

restore();
