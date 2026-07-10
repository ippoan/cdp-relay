//! MCP passthrough bridge (`--mcp-bridge`、cdp-relay#83)。
//!
//! `bridge/cdp-bridge.mjs --mcp` の Rust 版。chrome-devtools-mcp を手元で spawn し、
//! その stdio (newline-delimited JSON-RPC) を cdp-relay の `/mcpbridge/{session}` WSS に
//! 1 行 = 1 フレームでパイプする。生 CDP passthrough (1 ツール = 4〜5 往復 ≈ 1.1s) と
//! 違い 1 ツール = 海越え 1 往復 (≈ 0.3s) で済む (#80/#81 実測)。
//!
//! 拡張 popup の「MCP bridge 起動」ボタン → nmhost `{cmd:"mcp_bridge_start"}` →
//! `cdp-agent --mcp-bridge …` の detached spawn、という導線で使う (node clone 不要。
//! ただし chrome-devtools-mcp 自体が npm パッケージなので npx (Node.js) は手元に必要)。
//!
//! client (CCoW の stdio シム) が切断すると DO が bridge 脚も畳むので、child を kill して
//! ループ先頭から張り直す (= 次の client は新しい chrome-devtools-mcp と組む。MCP の
//! initialize が接続ごとに 1 回きりのため)。

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message};

pub struct BridgeConfig {
    pub relay: String,
    pub session: String,
    pub token: String,
    pub port: u16,
    /// chrome-devtools-mcp の起動コマンド上書き (空なら既定の npx 起動)。
    pub mcp_cmd: String,
}

/// relay origin → `/mcpbridge/{session}?token=…` の WSS URL を組む (純関数)。
pub fn ws_url(relay: &str, session: &str, token: &str) -> String {
    let relay = relay.trim_end_matches('/');
    let base = if let Some(rest) = relay.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = relay.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        relay.to_string()
    };
    format!("{base}/mcpbridge/{}?token={}", pct(session), pct(token))
}

/// URL パス/クエリ用の最小 percent-encode (unreserved 以外を全て encode)。
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// chrome-devtools-mcp の起動 argv を組む (純関数)。mcp_cmd 上書きは空白 split。
pub fn child_argv(port: u16, mcp_cmd: &str) -> Vec<String> {
    if !mcp_cmd.trim().is_empty() {
        return mcp_cmd.split_whitespace().map(String::from).collect();
    }
    vec![
        "npx".into(),
        "-y".into(),
        "chrome-devtools-mcp@latest".into(),
        "--browserUrl".into(),
        format!("http://127.0.0.1:{port}"),
    ]
}

/// bridge プロセスの PID ファイル (nmhost の stop / stale kill 用)。
pub fn pid_path() -> std::path::PathBuf {
    std::env::temp_dir().join("cdp-agent-mcpbridge.pid")
}

/// 記録済み bridge PID を (それがまだ cdp-agent なら) kill する。best-effort。
pub fn kill_recorded_bridge() -> String {
    let path = pid_path();
    let Ok(s) = std::fs::read_to_string(&path) else {
        return "no pid file".into();
    };
    let _ = std::fs::remove_file(&path);
    let Ok(pid) = s.trim().parse::<u32>() else {
        return "bad pid file".into();
    };
    kill_pid_if_agent(pid)
}

#[cfg(windows)]
fn kill_pid_if_agent(pid: u32) -> String {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    match Command::new("taskkill")
        .args([
            "/F",
            "/T", // 子 (npx / chrome-devtools-mcp) ごと落とす
            "/PID",
            &pid.to_string(),
            "/FI",
            "IMAGENAME eq cdp-agent.exe",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(o) if o.status.success() => format!("killed pid {pid}"),
        Ok(_) => format!("pid {pid} not running"),
        Err(e) => format!("taskkill failed: {e}"),
    }
}

#[cfg(not(windows))]
fn kill_pid_if_agent(pid: u32) -> String {
    match Command::new("kill").arg(pid.to_string()).output() {
        Ok(o) if o.status.success() => format!("killed pid {pid}"),
        Ok(_) => format!("pid {pid} not running"),
        Err(e) => format!("kill failed: {e}"),
    }
}

/// 記録済み bridge PID が生きているか (nmhost `mcp_bridge_status` 用)。
pub fn recorded_bridge_alive() -> bool {
    let Ok(s) = std::fs::read_to_string(pid_path()) else {
        return false;
    };
    let Ok(pid) = s.trim().parse::<u32>() else {
        return false;
    };
    pid_alive(pid)
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("tasklist")
        .args([
            "/FI",
            &format!("PID eq {pid}"),
            "/FI",
            "IMAGENAME eq cdp-agent.exe",
            "/NH",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("cdp-agent"))
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// nmhost からの mcp_bridge 系コマンドの実体 (spawn / kill / probe)。
/// `op`: "start" | "stop" | "status"。start は既存 bridge を落としてから detached spawn。
pub fn nm_op(op: &str, params: &Value) -> Value {
    match op {
        "start" => {
            let killed = kill_recorded_bridge();
            match spawn_detached_bridge(params) {
                Ok(pid) => {
                    let _ = std::fs::write(pid_path(), pid.to_string());
                    json!({ "ok": true, "started": true, "pid": pid, "killed": killed })
                }
                Err(e) => json!({ "ok": false, "error": e }),
            }
        }
        "stop" => json!({ "ok": true, "stopped": true, "detail": kill_recorded_bridge() }),
        "status" => json!({ "ok": true, "running": recorded_bridge_alive() }),
        other => json!({ "ok": false, "error": format!("unknown mcp op: {other}") }),
    }
}

/// `cdp-agent --mcp-bridge …` を detached で spawn する。token は argv に載せず
/// env (`CDP_AGENT_MCP_TOKEN`) で渡す (タスクマネージャ等のコマンドライン露出を避ける)。
fn spawn_detached_bridge(params: &Value) -> Result<u32, String> {
    let get = |k: &str| params.get(k).and_then(Value::as_str).unwrap_or("");
    let relay = get("relay");
    let session = get("session");
    let token = get("token");
    let port = params.get("port").and_then(Value::as_u64).unwrap_or(9222);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&exe);
    cmd.args([
        "--mcp-bridge",
        "--session",
        session,
        "--relay",
        relay,
        "--port",
        &port.to_string(),
    ])
    .env("CDP_AGENT_MCP_TOKEN", token)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| format!("spawn 失敗: {e}"))?;
    Ok(child.id())
}

/// chrome-devtools-mcp child を spawn する (stdio pipe 付き)。
fn spawn_child(argv: &[String]) -> Result<Child, String> {
    if argv.is_empty() {
        return Err("empty mcp cmd".into());
    }
    let mut cmd;
    #[cfg(windows)]
    {
        // npx は .cmd シムなので cmd /C 経由で解決する。
        cmd = Command::new("cmd");
        cmd.arg("/C").args(argv);
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..]);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("chrome-devtools-mcp spawn 失敗 ({}): {e}", argv.join(" ")))
}

/// bridge のメインループ。戻らない (エラーはバックオフして張り直す)。
pub fn run(cfg: &BridgeConfig) -> ! {
    // 自分の PID を記録 (nmhost 経由でなく手動起動した場合も stop/status が効くように上書き)。
    let _ = std::fs::write(pid_path(), std::process::id().to_string());
    let url = ws_url(&cfg.relay, &cfg.session, &cfg.token);
    alog!(
        "[mcp-bridge] session={} relay={} chrome=127.0.0.1:{}",
        cfg.session,
        cfg.relay,
        cfg.port
    );
    let mut backoff = Duration::from_millis(1000);
    loop {
        match run_once(cfg, &url) {
            Ok(()) => {
                backoff = Duration::from_millis(1000);
                thread::sleep(Duration::from_millis(300));
            }
            Err(e) => {
                alog!("[mcp-bridge] retry: {e}");
                thread::sleep(backoff);
                backoff = std::cmp::min(backoff * 2, Duration::from_secs(15));
            }
        }
    }
}

/// 1 client セッション分。child spawn + WSS 接続 → 双方向パイプ → どちらかが閉じたら畳む。
/// 正常終了 (client 切断など) は Ok、接続/spawn 失敗は Err (呼び出し側がバックオフ)。
fn run_once(cfg: &BridgeConfig, url: &str) -> Result<(), String> {
    let argv = child_argv(cfg.port, &cfg.mcp_cmd);
    let mut child = spawn_child(&argv)?;
    alog!(
        "[mcp-bridge] child spawn: {} (pid {})",
        argv.join(" "),
        child.id()
    );

    let (mut ws, _resp) = connect(url).map_err(|e| {
        let _ = child.kill();
        format!("relay 接続失敗: {e}")
    })?;
    alog!("[mcp-bridge] remote (cdp-relay) open");
    // read をノンブロッキング寄りにして child stdout との多重化をシングルスレッドで回す。
    match ws.get_mut() {
        MaybeTlsStream::Plain(s) => {
            let _ = s.set_read_timeout(Some(Duration::from_millis(50)));
        }
        MaybeTlsStream::NativeTls(t) => {
            let _ = t
                .get_ref()
                .set_read_timeout(Some(Duration::from_millis(50)));
        }
        _ => {}
    }

    // child stdout (JSONL) → channel (1 行単位)。
    let (tx, rx) = mpsc::channel::<String>();
    let stdout = child.stdout.take().ok_or("child stdout 無し")?;
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                alog!("[chrome-devtools-mcp] {line}");
            }
        });
    }
    let mut stdin = child.stdin.take().ok_or("child stdin 無し")?;

    let done = |mut child: Child, why: &str| {
        alog!("[mcp-bridge] session end: {why}");
        let _ = child.kill();
        let _ = child.wait();
    };

    loop {
        // child → relay
        while let Ok(line) = rx.try_recv() {
            if line.is_empty() {
                continue;
            }
            if let Err(e) = ws.send(Message::Text(line)) {
                done(child, &format!("ws send 失敗: {e}"));
                return Ok(());
            }
        }
        // child 死亡検知 (spawn 直後の npx 失敗等)。
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("chrome-devtools-mcp exit ({status})"));
        }
        // relay → child
        match ws.read() {
            Ok(Message::Text(t)) => {
                if t == "ping" {
                    continue; // keepalive は握り潰す (JSONL に混ぜない)
                }
                if stdin.write_all(t.as_bytes()).is_err() || stdin.write_all(b"\n").is_err() {
                    done(child, "child stdin 書き込み失敗");
                    return Ok(());
                }
            }
            Ok(Message::Binary(b)) => {
                if stdin.write_all(&b).is_err() || stdin.write_all(b"\n").is_err() {
                    done(child, "child stdin 書き込み失敗");
                    return Ok(());
                }
            }
            Ok(Message::Close(_)) => {
                done(child, "client 切断 (close)");
                return Ok(());
            }
            Ok(_) => {} // Ping/Pong/Frame は無視 (tungstenite が Pong を自動返信)
            Err(tungstenite::Error::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                // read timeout: child stdout の drain に戻る
            }
            Err(e) => {
                done(child, &format!("ws read 終了: {e}"));
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_converts_scheme_and_encodes() {
        assert_eq!(
            ws_url("https://cdp-relay.ippoan.org", "s1", "tok"),
            "wss://cdp-relay.ippoan.org/mcpbridge/s1?token=tok"
        );
        assert_eq!(
            ws_url("http://127.0.0.1:8787/", "a b", "t/+"),
            "ws://127.0.0.1:8787/mcpbridge/a%20b?token=t%2F%2B"
        );
    }

    #[test]
    fn child_argv_default_uses_npx_browser_url() {
        let v = child_argv(9223, "");
        assert_eq!(
            v,
            vec![
                "npx",
                "-y",
                "chrome-devtools-mcp@latest",
                "--browserUrl",
                "http://127.0.0.1:9223"
            ]
        );
    }

    #[test]
    fn child_argv_override_splits_whitespace() {
        let v = child_argv(9222, "node my-mcp.js --flag x");
        assert_eq!(v, vec!["node", "my-mcp.js", "--flag", "x"]);
    }

    #[test]
    fn nm_op_unknown_is_error() {
        let r = nm_op("explode", &json!({}));
        assert_eq!(r["ok"], false);
    }

    #[test]
    fn nm_op_status_reports_running_flag() {
        // pid file が無い状態では running=false (環境依存を避けるため file を消してから)。
        let _ = std::fs::remove_file(pid_path());
        let r = nm_op("status", &json!({}));
        assert_eq!(r["ok"], true);
        assert_eq!(r["running"], false);
    }
}
