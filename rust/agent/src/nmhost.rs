//! Native Messaging host (cdp-relay#33) — 拡張から cdp-agent を起動する **ランチャー**。
//!
//! Chrome の Native Messaging で拡張 (`chrome.runtime.sendNativeMessage`) から呼ばれ、
//! `{cmd:"start"}` を受けると手元 cdp-agent を **detached spawn** して即応答する。以降の
//! CDP 往復は従来どおり localhost の ext server (long-poll, default 19222) を使う。
//! こうすると cloudflared tunnel は spawn した agent が握り続けるので、native-host
//! プロセス (= Chrome が port close で kill する) の寿命に縛られない。
//!
//! Chrome は native messaging 起動時に argv へ呼び出し元 origin (`chrome-extension://<id>/`)
//! を渡す。それを検出して native-host モードに入る (`--native-host` でも明示可)。
//!
//! framing / dispatch / manifest 生成は OS 非依存の純関数にして CCoW (Linux) で unit test
//! する。registry 書き込み (`install_native_host`) と detached spawn の Windows 固有部分だけ
//! `#[cfg(windows)]` で割る。

use serde_json::{json, Value};
use std::io::{self, ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

/// Native Messaging host 名。拡張の `sendNativeMessage` の第 1 引数と一致させる。
pub const HOST_NAME: &str = "com.ippoan.cdp_agent";

/// 拡張 ID (manifest.json の `key` から決まる固定 ID)。allowed_origins に埋める。
pub const EXT_ID: &str = "ekadlloplnbagbidandccdheiemgocng";

/// 1 メッセージの上限 (拡張 → host は本来 4GB 許容だが launcher 用途では十分小さく cap)。
const MAX_MSG_BYTES: usize = 1024 * 1024;

/// ext server を probe する際の TCP connect timeout。
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

/// argv が native-host 起動か判定する。Chrome は origin (`chrome-extension://…`) を渡す。
pub fn is_native_host_invocation(args: &[String]) -> bool {
    args.iter()
        .any(|a| a == "--native-host" || a.starts_with("chrome-extension://"))
}

/// ext server の port を解決する (main と同じ既定 19222、CDP_AGENT_EXT_PORT で上書き)。
pub fn ext_port() -> u16 {
    std::env::var("CDP_AGENT_EXT_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(19222)
}

/// stdin から 4-byte LE length-prefixed JSON を 1 件読む。EOF (Chrome が port を閉じた) は
/// `Ok(None)`。length 超過や不正 JSON は `Err`。
pub fn read_message<R: Read>(r: &mut R) -> io::Result<Option<Value>> {
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_MSG_BYTES {
        return Err(io::Error::new(ErrorKind::InvalidData, "message too large"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    let v = serde_json::from_slice(&buf)
        .map_err(|e| io::Error::new(ErrorKind::InvalidData, e.to_string()))?;
    Ok(Some(v))
}

/// stdout に 4-byte LE length-prefixed JSON を 1 件書く。
pub fn write_message<W: Write>(w: &mut W, v: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(v).map_err(|e| io::Error::new(ErrorKind::InvalidData, e))?;
    let len = u32::try_from(bytes.len())
        .map_err(|_| io::Error::new(ErrorKind::InvalidData, "response too large"))?;
    w.write_all(&len.to_le_bytes())?;
    w.write_all(&bytes)?;
    w.flush()
}

/// 受信メッセージを応答 JSON に変換する純ロジック。probe / spawn / kill / mcp を注入して
/// test 可能に。
///
/// - `{cmd:"ping"}`    → `{ok:true, version, ext_port}`
/// - `{cmd:"start"}`   → 既に probe() 成功なら `already_running`、未起動なら spawn() して
///   `started`。spawn 失敗は `{ok:false, error}`。
/// - `{cmd:"restart"}` → **必ず kill() で既存 agent を落としてから** spawn() し直す。接続の
///   たびに最新インストール版バイナリで起動するための経路 (#54 後の旧 agent 居座り対策)。
///   kill 失敗は best-effort で握り潰し (落とすものが無いだけのことが多い)、spawn 失敗のみ
///   `{ok:false, error}`。
/// - `{cmd:"mcp_bridge_start", relay, session, token, port?}` → パラメータ検証後
///   mcp("start", …) へ委譲 (#83、popup の「MCP bridge 起動」ボタン)。検証 NG は
///   `{ok:false, error}` (mcp は呼ばない)。
/// - `{cmd:"mcp_bridge_stop"}` / `{cmd:"mcp_bridge_status"}` → mcp("stop"/"status", …)。
/// - その他 → `{ok:false, error:"unknown cmd"}`
pub fn handle_request(
    req: &Value,
    port: u16,
    probe: &dyn Fn() -> bool,
    spawn: &mut dyn FnMut() -> Result<String, String>,
    kill: &mut dyn FnMut() -> Result<String, String>,
    mcp: &mut dyn FnMut(&str, &Value) -> Value,
) -> Value {
    let version = env!("CARGO_PKG_VERSION");
    match req.get("cmd").and_then(Value::as_str).unwrap_or("") {
        "ping" => json!({ "ok": true, "version": version, "ext_port": port }),
        "start" => {
            if probe() {
                json!({ "ok": true, "already_running": true, "ext_port": port })
            } else {
                match spawn() {
                    Ok(detail) => {
                        json!({ "ok": true, "started": true, "ext_port": port, "detail": detail })
                    }
                    Err(e) => json!({ "ok": false, "error": e }),
                }
            }
        }
        "restart" => {
            // kill は best-effort (落とす対象が無ければ非ゼロ rc になり得るが致命ではない)。
            let killed = match kill() {
                Ok(d) => d,
                Err(e) => format!("kill skipped: {e}"),
            };
            match spawn() {
                Ok(detail) => json!({
                    "ok": true, "restarted": true, "ext_port": port,
                    "killed": killed, "detail": detail
                }),
                Err(e) => json!({ "ok": false, "error": e }),
            }
        }
        "mcp_bridge_start" => match validate_mcp_bridge_params(req) {
            Ok(params) => mcp("start", &params),
            Err(e) => json!({ "ok": false, "error": e }),
        },
        "mcp_bridge_stop" => mcp("stop", req),
        "mcp_bridge_status" => mcp("status", req),
        other => json!({ "ok": false, "error": format!("unknown cmd: {other}") }),
    }
}

/// `mcp_bridge_start` のパラメータ検証 (純関数)。spawn の argv になる値なので、popup 由来の
/// 値をそのまま流さず形式で縛る (コマンドライン injection は Command の argv 渡しで元々
/// 起きないが、relay の宛先すり替えで token を第三者に送らせない目的が主)。
///
/// - relay: `https://` origin のみ (path/クエリ/空白不可)。dev 用に `http://127.0.0.1[:port]` /
///   `http://localhost[:port]` も許可
/// - session: 1〜128 字の `[A-Za-z0-9._-]`
/// - token: 8〜256 字の `[A-Za-z0-9._~-]`
/// - port: 1〜65535 (省略時 9222)
pub fn validate_mcp_bridge_params(req: &Value) -> Result<Value, String> {
    let get = |k: &str| {
        req.get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let relay = get("relay");
    let session = get("session");
    let token = get("token");
    let port = req.get("port").and_then(Value::as_u64).unwrap_or(9222);

    let relay_ok = {
        let is_https_origin = relay.strip_prefix("https://").is_some_and(|rest| {
            !rest.is_empty()
                && rest
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
        });
        let is_local = relay.strip_prefix("http://").is_some_and(|rest| {
            let host = rest.split(':').next().unwrap_or("");
            (host == "127.0.0.1" || host == "localhost")
                && rest
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
        });
        is_https_origin || is_local
    };
    if !relay_ok {
        return Err(format!("invalid relay: {relay}"));
    }
    if session.is_empty()
        || session.len() > 128
        || !session
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err("invalid session".into());
    }
    if token.len() < 8
        || token.len() > 256
        || !token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-'))
    {
        return Err("invalid token".into());
    }
    if port == 0 || port > 65535 {
        return Err("invalid port".into());
    }
    Ok(json!({ "relay": relay, "session": session, "token": token, "port": port }))
}

/// ext server (= agent) が起動済みか TCP connect で probe する。
pub fn probe_agent(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).is_ok()
}

/// native-host の stdio ループ。Chrome が port を閉じる (EOF) まで読み続ける。
/// stdout は native messaging チャネルなので framed JSON 以外を絶対に出さない (log は stderr)。
pub fn run_native_host() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut r = stdin.lock();
    let mut w = stdout.lock();
    let port = ext_port();
    eprintln!("[cdp-agent] native-host mode (ext_port={port})");
    loop {
        match read_message(&mut r) {
            Ok(Some(req)) => {
                let resp = handle_request(
                    &req,
                    port,
                    &|| probe_agent(port),
                    &mut spawn_detached_agent,
                    &mut kill_other_agents,
                    &mut crate::mcpbridge::nm_op,
                );
                if let Err(e) = write_message(&mut w, &resp) {
                    eprintln!("[cdp-agent] native-host write 失敗: {e}");
                    break;
                }
            }
            Ok(None) => break, // Chrome が port を閉じた
            Err(e) => {
                let _ = write_message(&mut w, &json!({ "ok": false, "error": e.to_string() }));
                break;
            }
        }
    }
}

/// detached で自分自身を通常 (agent) モードで起動する (Windows)。Chrome が native-host
/// プロセスを kill しても agent は生き残るよう DETACHED_PROCESS + 新プロセスグループにする。
#[cfg(windows)]
fn spawn_detached_agent() -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Command::new(&exe)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn 失敗: {e}"))?;
    Ok(format!("spawned {}", exe.display()))
}

/// 非 Windows fallback (CCoW / 開発用)。detached フラグ無しで spawn する。
#[cfg(not(windows))]
fn spawn_detached_agent() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Command::new(&exe)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn 失敗: {e}"))?;
    Ok(format!("spawned {}", exe.display()))
}

/// 自分 (native-host プロセス) 以外の cdp-agent.exe を全て kill する (Windows)。
/// `restart` cmd で、接続のたびに居座っている旧 agent server を確実に落とすために使う。
/// `/FI "PID ne <self>"` で native-host 自身は除外する (応答を返す前に自死しないため)。
#[cfg(windows)]
fn kill_other_agents() -> Result<String, String> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    use std::os::windows::process::CommandExt;
    let self_pid = std::process::id();
    let out = Command::new("taskkill")
        .args([
            "/F",
            "/IM",
            "cdp-agent.exe",
            "/FI",
            &format!("PID ne {self_pid}"),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("taskkill 失敗: {e}"))?;
    // taskkill は対象なしで非ゼロを返すので rc は致命扱いしない。
    Ok(format!("taskkill rc={:?}", out.status.code()))
}

/// 非 Windows fallback (CCoW / 開発用)。kill 対象の概念が無いので no-op。
#[cfg(not(windows))]
fn kill_other_agents() -> Result<String, String> {
    Ok("noop (non-windows)".to_string())
}

/// native-host manifest の JSON を生成する (OS 非依存・純関数)。`path` は exe の絶対 path。
pub fn native_host_manifest_json(exe_path: &Path) -> String {
    let manifest = json!({
        "name": HOST_NAME,
        "description": "cdp-relay agent launcher",
        "path": exe_path.to_string_lossy().into_owned(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXT_ID}/")],
    });
    serde_json::to_string_pretty(&manifest).unwrap_or_else(|_| manifest.to_string())
}

/// native-host manifest を user-writable な場所に書き、Chrome / Edge の HKCU registry に
/// 登録する (Windows)。admin 不要 (per-user)。通常起動時に idempotent に呼ばれる +
/// `--install-native-host` で明示可。
///
/// manifest は **`%LOCALAPPDATA%\cdp-relay-agent\`** に置く。exe が
/// `C:\Program Files\` (perMachine MSI) に入ると隣には admin 無しで書けないため。
/// Chrome は manifest を read するだけなので、`path` フィールドが Program Files の exe を
/// 指していても問題ない。
#[cfg(windows)]
pub fn install_native_host() -> Result<String, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = manifest_dir(&exe)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let manifest_path = dir.join(format!("{HOST_NAME}.json"));
    std::fs::write(&manifest_path, native_host_manifest_json(&exe)).map_err(|e| e.to_string())?;

    let manifest_str = manifest_path.to_string_lossy().into_owned();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for base in [
        r"Software\Google\Chrome\NativeMessagingHosts",
        r"Software\Microsoft\Edge\NativeMessagingHosts",
    ] {
        let (key, _) = hkcu
            .create_subkey(format!(r"{base}\{HOST_NAME}"))
            .map_err(|e| format!("registry {base}: {e}"))?;
        key.set_value("", &manifest_str)
            .map_err(|e| format!("registry set {base}: {e}"))?;
    }
    Ok(format!("native host 登録: {manifest_str}"))
}

/// manifest を置く user-writable ディレクトリ。`%LOCALAPPDATA%\cdp-relay-agent`、
/// LOCALAPPDATA が無ければ exe の隣に fallback。
#[cfg(windows)]
fn manifest_dir(exe: &Path) -> Result<std::path::PathBuf, String> {
    std::env::var_os("LOCALAPPDATA")
        .map(|p| std::path::PathBuf::from(p).join("cdp-relay-agent"))
        .or_else(|| exe.parent().map(|p| p.to_path_buf()))
        .ok_or_else(|| "LOCALAPPDATA も exe parent も不明".to_string())
}

/// 非 Windows fallback。registry 登録は Windows 専用だが、manifest 生成は OS 非依存なので
/// 参照だけして notice を返す (登録自体は no-op)。
#[cfg(not(windows))]
pub fn install_native_host() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let _manifest = native_host_manifest_json(&exe); // 生成は可能、登録だけ Windows 限定
    Err(format!(
        "native-host 登録は Windows のみ対応 (host={HOST_NAME})"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn detects_native_host_invocation() {
        assert!(is_native_host_invocation(&["--native-host".into()]));
        assert!(is_native_host_invocation(&[
            "chrome-extension://ekadlloplnbagbidandccdheiemgocng/".into(),
            "--parent-window=0".into(),
        ]));
        assert!(!is_native_host_invocation(&["--help".into()]));
        assert!(!is_native_host_invocation(&[]));
    }

    #[test]
    fn framing_round_trips() {
        let msg = json!({ "cmd": "start", "x": 1 });
        let mut buf = Vec::new();
        write_message(&mut buf, &msg).unwrap();
        // 先頭 4 byte は LE length。
        let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        assert_eq!(len, buf.len() - 4);

        let mut cursor = std::io::Cursor::new(buf);
        let got = read_message(&mut cursor).unwrap().unwrap();
        assert_eq!(got, msg);
        // 続けて読むと EOF → None。
        assert!(read_message(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn read_message_rejects_oversized_length() {
        // length = MAX_MSG_BYTES + 1 を LE で並べる。
        let len = (MAX_MSG_BYTES as u32) + 1;
        let mut buf = len.to_le_bytes().to_vec();
        buf.extend_from_slice(b"{}");
        let mut cursor = std::io::Cursor::new(buf);
        let err = read_message(&mut cursor).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidData);
    }

    /// kill は呼ばれない想定のテスト用 no-op (呼ばれたら panic)。
    fn no_kill() -> impl FnMut() -> Result<String, String> {
        || panic!("kill は呼ばれないはず")
    }

    /// mcp は呼ばれない想定のテスト用 no-op (呼ばれたら panic)。
    fn no_mcp() -> impl FnMut(&str, &Value) -> Value {
        |_, _| panic!("mcp は呼ばれないはず")
    }

    #[test]
    fn start_when_not_running_spawns() {
        let mut spawned = false;
        let req = json!({ "cmd": "start" });
        let resp = handle_request(
            &req,
            19222,
            &|| false, // 未起動
            &mut || {
                spawned = true;
                Ok("spawned x".to_string())
            },
            &mut no_kill(),
            &mut no_mcp(),
        );
        assert_eq!(resp["ok"], true);
        assert_eq!(resp["started"], true);
        assert_eq!(resp["ext_port"], 19222);
        assert!(spawned);
    }

    #[test]
    fn start_when_already_running_does_not_spawn() {
        let req = json!({ "cmd": "start" });
        let resp = handle_request(
            &req,
            19222,
            &|| true, // 既に起動
            &mut || panic!("spawn は呼ばれないはず"),
            &mut no_kill(),
            &mut no_mcp(),
        );
        assert_eq!(resp["ok"], true);
        assert_eq!(resp["already_running"], true);
    }

    #[test]
    fn start_propagates_spawn_error() {
        let req = json!({ "cmd": "start" });
        let resp = handle_request(
            &req,
            19222,
            &|| false,
            &mut || Err("boom".to_string()),
            &mut no_kill(),
            &mut no_mcp(),
        );
        assert_eq!(resp["ok"], false);
        assert_eq!(resp["error"], "boom");
    }

    #[test]
    fn restart_kills_then_spawns_regardless_of_probe() {
        let mut killed = false;
        let mut spawned = false;
        let resp = handle_request(
            &json!({ "cmd": "restart" }),
            19222,
            &|| true, // probe が true (既に起動中) でも restart は kill+spawn する
            &mut || {
                spawned = true;
                Ok("spawned new".to_string())
            },
            &mut || {
                killed = true;
                Ok("taskkill rc=Some(0)".to_string())
            },
            &mut no_mcp(),
        );
        assert_eq!(resp["ok"], true);
        assert_eq!(resp["restarted"], true);
        assert_eq!(resp["killed"], "taskkill rc=Some(0)");
        assert!(killed && spawned);
    }

    #[test]
    fn restart_swallows_kill_error_but_still_spawns() {
        let resp = handle_request(
            &json!({ "cmd": "restart" }),
            19222,
            &|| false,
            &mut || Ok("spawned".to_string()),
            &mut || Err("taskkill missing".to_string()),
            &mut no_mcp(),
        );
        assert_eq!(resp["ok"], true);
        assert_eq!(resp["restarted"], true);
        assert!(resp["killed"].as_str().unwrap().contains("kill skipped"));
    }

    #[test]
    fn restart_propagates_spawn_error() {
        let resp = handle_request(
            &json!({ "cmd": "restart" }),
            19222,
            &|| false,
            &mut || Err("spawn boom".to_string()),
            &mut || Ok("killed".to_string()),
            &mut no_mcp(),
        );
        assert_eq!(resp["ok"], false);
        assert_eq!(resp["error"], "spawn boom");
    }

    #[test]
    fn ping_returns_version_and_port() {
        let resp = handle_request(
            &json!({ "cmd": "ping" }),
            19222,
            &|| false,
            &mut || panic!("ping は spawn しない"),
            &mut no_kill(),
            &mut no_mcp(),
        );
        assert_eq!(resp["ok"], true);
        assert_eq!(resp["ext_port"], 19222);
        assert_eq!(resp["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn unknown_cmd_is_error() {
        let resp = handle_request(
            &json!({ "cmd": "explode" }),
            19222,
            &|| false,
            &mut || panic!("unknown は spawn しない"),
            &mut no_kill(),
            &mut no_mcp(),
        );
        assert_eq!(resp["ok"], false);
        assert!(resp["error"].as_str().unwrap().contains("unknown cmd"));
    }

    const OK_TOKEN: &str = "0123456789abcdef";

    #[test]
    fn mcp_bridge_start_validates_then_delegates() {
        let mut got: Option<(String, Value)> = None;
        let resp = handle_request(
            &json!({ "cmd": "mcp_bridge_start", "relay": "https://cdp-relay.ippoan.org",
                     "session": "s-1", "token": OK_TOKEN, "port": 9223 }),
            19222,
            &|| false,
            &mut || panic!("spawn (agent) は呼ばれない"),
            &mut no_kill(),
            &mut |op, params| {
                got = Some((op.to_string(), params.clone()));
                json!({ "ok": true, "started": true })
            },
        );
        assert_eq!(resp["ok"], true);
        let (op, params) = got.expect("mcp が呼ばれる");
        assert_eq!(op, "start");
        assert_eq!(params["session"], "s-1");
        assert_eq!(params["port"], 9223);
    }

    #[test]
    fn mcp_bridge_start_rejects_bad_relay_without_delegating() {
        for relay in [
            "http://evil.example",    // 非 https の外部
            "https://x.example/path", // path 付き
            "https://x.example?a=b",  // クエリ付き
            "ftp://x",                // scheme 違い
            "",                       // 空
        ] {
            let resp = handle_request(
                &json!({ "cmd": "mcp_bridge_start", "relay": relay,
                         "session": "s", "token": OK_TOKEN }),
                19222,
                &|| false,
                &mut || panic!("spawn は呼ばれない"),
                &mut no_kill(),
                &mut no_mcp(),
            );
            assert_eq!(resp["ok"], false, "relay={relay} は拒否されるはず");
        }
    }

    #[test]
    fn mcp_bridge_start_allows_localhost_relay_for_dev() {
        let resp = handle_request(
            &json!({ "cmd": "mcp_bridge_start", "relay": "http://127.0.0.1:8787",
                     "session": "s", "token": OK_TOKEN }),
            19222,
            &|| false,
            &mut || panic!("spawn は呼ばれない"),
            &mut no_kill(),
            &mut |_, _| json!({ "ok": true }),
        );
        assert_eq!(resp["ok"], true);
    }

    #[test]
    fn mcp_bridge_start_rejects_bad_session_and_token() {
        for (session, token) in [
            ("bad session", OK_TOKEN),  // 空白入り session
            ("", OK_TOKEN),             // 空 session
            ("s", "short"),             // 8 字未満 token
            ("s", "tok en 0123456789"), // 空白入り token
        ] {
            let resp = handle_request(
                &json!({ "cmd": "mcp_bridge_start", "relay": "https://cdp-relay.ippoan.org",
                         "session": session, "token": token }),
                19222,
                &|| false,
                &mut || panic!("spawn は呼ばれない"),
                &mut no_kill(),
                &mut no_mcp(),
            );
            assert_eq!(
                resp["ok"], false,
                "session={session} token={token} は拒否されるはず"
            );
        }
    }

    #[test]
    fn mcp_bridge_start_defaults_port_9222() {
        let params = validate_mcp_bridge_params(&json!({
            "relay": "https://cdp-relay.ippoan.org", "session": "s", "token": OK_TOKEN
        }))
        .unwrap();
        assert_eq!(params["port"], 9222);
    }

    #[test]
    fn mcp_bridge_stop_and_status_delegate() {
        for (cmd, op_expected) in [("mcp_bridge_stop", "stop"), ("mcp_bridge_status", "status")] {
            let mut got = String::new();
            let resp = handle_request(
                &json!({ "cmd": cmd }),
                19222,
                &|| false,
                &mut || panic!("spawn は呼ばれない"),
                &mut no_kill(),
                &mut |op, _| {
                    got = op.to_string();
                    json!({ "ok": true })
                },
            );
            assert_eq!(resp["ok"], true);
            assert_eq!(got, op_expected);
        }
    }

    #[test]
    fn manifest_json_has_required_fields() {
        let json_str = native_host_manifest_json(&PathBuf::from(
            r"C:\Program Files\cdp-relay-agent\cdp-agent.exe",
        ));
        let v: Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(v["name"], HOST_NAME);
        assert_eq!(v["type"], "stdio");
        assert_eq!(
            v["allowed_origins"][0],
            format!("chrome-extension://{EXT_ID}/")
        );
        assert!(v["path"].as_str().unwrap().ends_with("cdp-agent.exe"));
    }
}
