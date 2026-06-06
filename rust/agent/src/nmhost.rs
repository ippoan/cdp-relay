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

/// 受信メッセージを応答 JSON に変換する純ロジック。probe / spawn を注入して test 可能に。
///
/// - `{cmd:"ping"}`  → `{ok:true, version, ext_port}`
/// - `{cmd:"start"}` → 既に probe() 成功なら `already_running`、未起動なら spawn() して
///   `started`。spawn 失敗は `{ok:false, error}`。
/// - その他 → `{ok:false, error:"unknown cmd"}`
pub fn handle_request(
    req: &Value,
    port: u16,
    probe: &dyn Fn() -> bool,
    spawn: &mut dyn FnMut() -> Result<String, String>,
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
        other => json!({ "ok": false, "error": format!("unknown cmd: {other}") }),
    }
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
                let resp =
                    handle_request(&req, port, &|| probe_agent(port), &mut spawn_detached_agent);
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
        );
        assert_eq!(resp["ok"], true);
        assert_eq!(resp["already_running"], true);
    }

    #[test]
    fn start_propagates_spawn_error() {
        let req = json!({ "cmd": "start" });
        let resp = handle_request(&req, 19222, &|| false, &mut || Err("boom".to_string()));
        assert_eq!(resp["ok"], false);
        assert_eq!(resp["error"], "boom");
    }

    #[test]
    fn ping_returns_version_and_port() {
        let resp = handle_request(&json!({ "cmd": "ping" }), 19222, &|| false, &mut || {
            panic!("ping は spawn しない")
        });
        assert_eq!(resp["ok"], true);
        assert_eq!(resp["ext_port"], 19222);
        assert_eq!(resp["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn unknown_cmd_is_error() {
        let resp = handle_request(&json!({ "cmd": "explode" }), 19222, &|| false, &mut || {
            panic!("unknown は spawn しない")
        });
        assert_eq!(resp["ok"], false);
        assert!(resp["error"].as_str().unwrap().contains("unknown cmd"));
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
