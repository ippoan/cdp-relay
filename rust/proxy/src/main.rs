//! cdp-proxy — CCoW 側の stdio MCP proxy (cdp-relay#12 M4)。
//!
//! Claude Code は session 起動時の固定 URL (ここでは stdio) にしか繋げず、runtime で
//! 接続先を切り替えられない。そこで proxy が固定 stdio を被り、起動時に rendezvous で
//! **揮発する tunnel_url を解決**して、以降の MCP リクエストを手元 agent の `/mcp` に
//! **透過転送**する。これで「最初だけ DO、あと手元」が Claude の挙動に依存せず成立する。
//!
//! stdio MCP transport は「1 行 = 1 JSON-RPC メッセージ」(改行区切り)。proxy は中身を
//! 解釈せず opaque に転送する。唯一 `Mcp-Session-Id` ヘッダだけは sticky に保持して
//! 後続リクエストへ載せ直す (Streamable HTTP の session を proxy が握る)。
//!
//! 設定 (env):
//!   CDP_RELAY_TARGET      tunnel_url を直接指定 (= rendezvous skip、テスト/手動用)
//!   CDP_RELAY_RENDEZVOUS  rendezvous base (default https://cdp-relay.ippoan.org)
//!   CDP_RELAY_SESSION     session 名 (rendezvous lookup に使う)
//!   CDP_RELAY_TOKEN       pairing code (lookup / 後続の認可に使う)

use std::io::{BufRead, BufReader, Write};
use std::sync::Arc;
use std::time::Duration;

/// 1 行 (= 1 JSON-RPC メッセージ) を転送し、応答があれば返す抽象。
/// pump をネットワーク非依存にテストするために trait にしてある。
trait Forward {
    fn forward(&mut self, line: &str) -> Option<String>;
}

/// 手元 agent の `/mcp` (Streamable HTTP) に HTTP POST で転送する実装。
struct HttpForwarder {
    agent: ureq::Agent,
    endpoint: String,
    /// initialize 応答で受け取った Mcp-Session-Id を sticky に保持する。
    session_id: Option<String>,
}

impl Forward for HttpForwarder {
    fn forward(&mut self, line: &str) -> Option<String> {
        let mut req = self
            .agent
            .post(&self.endpoint)
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream");
        if let Some(sid) = &self.session_id {
            req = req.set("Mcp-Session-Id", sid);
        }
        let resp = match req.send_string(line) {
            Ok(r) => r,
            // 4xx/5xx でも body があれば JSON-RPC error として返す。
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => {
                return Some(transport_error(line, &e.to_string()));
            }
        };
        if let Some(sid) = resp.header("Mcp-Session-Id") {
            self.session_id = Some(sid.to_string());
        }
        let body = resp.into_string().unwrap_or_default();
        let body = body.trim();
        if body.is_empty() {
            None // notification 等、応答なし
        } else {
            Some(body.to_string())
        }
    }
}

/// JSON-RPC の id を引き継いだ transport error を組み立てる (Claude 側で hang させない)。
fn transport_error(request_line: &str, msg: &str) -> String {
    let id = serde_json::from_str::<serde_json::Value>(request_line)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32000, "message": format!("cdp-proxy transport: {msg}") }
    })
    .to_string()
}

/// stdin の各行を forwarder に流し、応答を stdout に 1 行ずつ書く。
fn pump<R: BufRead, W: Write, F: Forward>(mut input: R, mut out: W, fwd: &mut F) {
    let mut line = String::new();
    loop {
        line.clear();
        match input.read_line(&mut line) {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(_) => break,
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            continue;
        }
        if let Some(resp) = fwd.forward(trimmed) {
            // 念のため改行を畳んで「1 行 = 1 メッセージ」を保つ。
            let one_line = resp.replace(['\n', '\r'], "");
            if writeln!(out, "{one_line}").is_err() {
                break;
            }
            let _ = out.flush();
        }
    }
}

/// lookup 応答 JSON から tunnel_url を取り出す。
fn parse_tunnel_url(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get("tunnel_url")?
        .as_str()
        .map(|s| s.to_string())
}

/// 転送先 `/mcp` エンドポイントを解決する。
/// CDP_RELAY_TARGET があればそれを優先 (rendezvous skip)、無ければ rendezvous lookup。
fn resolve_endpoint(agent: &ureq::Agent) -> Result<String, String> {
    if let Ok(t) = std::env::var("CDP_RELAY_TARGET") {
        if !t.is_empty() {
            return Ok(format!("{}/mcp", t.trim_end_matches('/')));
        }
    }
    let base = std::env::var("CDP_RELAY_RENDEZVOUS")
        .unwrap_or_else(|_| "https://cdp-relay.ippoan.org".into());
    let session =
        std::env::var("CDP_RELAY_SESSION").map_err(|_| "CDP_RELAY_SESSION 未設定".to_string())?;
    let token =
        std::env::var("CDP_RELAY_TOKEN").map_err(|_| "CDP_RELAY_TOKEN 未設定".to_string())?;
    let url = format!(
        "{}/lookup/{}?token={}",
        base.trim_end_matches('/'),
        session,
        token
    );
    let body = agent
        .get(&url)
        .call()
        .map_err(|e| format!("rendezvous lookup 失敗: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let tunnel =
        parse_tunnel_url(&body).ok_or_else(|| "lookup 応答に tunnel_url が無い".to_string())?;
    Ok(format!("{}/mcp", tunnel.trim_end_matches('/')))
}

fn build_agent() -> ureq::Agent {
    ureq::builder()
        .tls_connector(Arc::new(
            native_tls::TlsConnector::new().expect("native-tls init"),
        ))
        .timeout_connect(Duration::from_secs(10))
        .build()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "cdp-proxy — CCoW 側 stdio MCP proxy (cdp-relay#12 M4)\n\n\
             env:\n  \
             CDP_RELAY_TARGET      tunnel_url を直接指定 (rendezvous skip)\n  \
             CDP_RELAY_RENDEZVOUS  rendezvous base (default https://cdp-relay.ippoan.org)\n  \
             CDP_RELAY_SESSION     session 名\n  \
             CDP_RELAY_TOKEN       pairing code"
        );
        return;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("cdp-proxy {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let agent = build_agent();
    let endpoint = match resolve_endpoint(&agent) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[cdp-proxy] 転送先の解決に失敗: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("[cdp-proxy] forwarding stdio MCP -> {endpoint}");

    let mut fwd = HttpForwarder {
        agent,
        endpoint,
        session_id: None,
    };
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    pump(BufReader::new(stdin.lock()), stdout.lock(), &mut fwd);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parse_tunnel_url_extracts_field() {
        let body = r#"{"tunnel_url":"https://x.trycloudflare.com","updated_at":123}"#;
        assert_eq!(
            parse_tunnel_url(body).as_deref(),
            Some("https://x.trycloudflare.com")
        );
    }

    #[test]
    fn parse_tunnel_url_none_when_missing() {
        assert_eq!(parse_tunnel_url(r#"{"error":"not_registered"}"#), None);
        assert_eq!(parse_tunnel_url("not json"), None);
    }

    #[test]
    fn transport_error_preserves_id() {
        let err = transport_error(r#"{"jsonrpc":"2.0","id":7,"method":"x"}"#, "boom");
        let v: serde_json::Value = serde_json::from_str(&err).unwrap();
        assert_eq!(v["id"], 7);
        assert_eq!(v["error"]["code"], -32000);
    }

    /// 実 HTTP 転送 + Mcp-Session-Id の sticky 保持をモックサーバで検証する。
    /// initialize 応答で受けた session id を後続リクエストに載せ直すのが proxy の肝。
    #[test]
    fn http_forwarder_carries_sticky_session_id() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let mut sid_on_second: Option<String> = None;
            for i in 0..2 {
                let (mut s, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                if i == 1 {
                    sid_on_second = req
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("mcp-session-id:"))
                        .and_then(|l| l.split_once(':').map(|x| x.1))
                        .map(|v| v.trim().to_string());
                }
                let body = "{\"ok\":true}";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                     Mcp-Session-Id: sess-1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = s.write_all(resp.as_bytes());
            }
            sid_on_second
        });

        let mut fwd = HttpForwarder {
            agent: build_agent(),
            endpoint: format!("http://127.0.0.1:{port}/mcp"),
            session_id: None,
        };
        // 1 回目: 応答の session id を取り込む。
        let r1 = fwd.forward("{\"id\":1,\"method\":\"initialize\"}");
        assert!(r1.is_some());
        assert_eq!(fwd.session_id.as_deref(), Some("sess-1"));
        // 2 回目: 取り込んだ session id をリクエストに載せ直す。
        let _ = fwd.forward("{\"id\":2,\"method\":\"tools/list\"}");

        let sid_on_second = handle.join().unwrap();
        assert_eq!(sid_on_second.as_deref(), Some("sess-1"));
    }

    /// stdin の各行を forwarder に渡し、Some の応答だけ 1 行ずつ stdout に出ることを確認。
    #[test]
    fn pump_forwards_lines_and_writes_responses() {
        struct Fake {
            seen: Vec<String>,
        }
        impl Forward for Fake {
            fn forward(&mut self, line: &str) -> Option<String> {
                self.seen.push(line.to_string());
                if line.contains("\"notify\"") {
                    None // notification: 応答なし
                } else {
                    Some(format!("{{\"echo\":{line}}}"))
                }
            }
        }
        let input = Cursor::new(
            "{\"id\":1,\"method\":\"a\"}\n\
             {\"method\":\"notify\"}\n\
             \n\
             {\"id\":2,\"method\":\"b\"}\n",
        );
        let mut out: Vec<u8> = Vec::new();
        let mut fake = Fake { seen: Vec::new() };
        pump(input, &mut out, &mut fake);

        // 空行は skip、notify/2 行は転送される (空行除く 3 行)。
        assert_eq!(fake.seen.len(), 3);
        let out_str = String::from_utf8(out).unwrap();
        let lines: Vec<&str> = out_str.lines().collect();
        // notify は応答なしなので stdout は 2 行。
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\"id\":1"));
        assert!(lines[1].contains("\"id\":2"));
    }
}
