//! rendezvous register — agent が起動時に quick tunnel URL を DO に登録する
//! (cdp-relay#12 rendezvous 経由)。
//!
//! CDP_AGENT_SESSION / CDP_AGENT_TOKEN が設定されていれば、tunnel URL が出た時点で
//! rendezvous DO の `/register/{session}?token=<token>` に POST する。CCoW 側の
//! cdp-proxy が同じ session/token で `/lookup` して tunnel_url を引き、Claude は
//! 固定 stdio のまま揮発 URL に追従できる (= 「最初だけ DO、あと手元」)。
//!
//! token は cdp-relay の RELAY_TOKEN (= /register /lookup の shared secret) を想定。
//! TLS は native-tls (システム CA、#14 M1 の学び)。

use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

fn build_agent() -> ureq::Agent {
    ureq::builder()
        .tls_connector(Arc::new(
            native_tls::TlsConnector::new().expect("native-tls init"),
        ))
        .timeout(Duration::from_secs(15))
        .build()
}

/// quick tunnel URL を rendezvous DO の /register/{session} に登録する。
pub fn register_tunnel(
    rendezvous: &str,
    session: &str,
    token: &str,
    tunnel_url: &str,
) -> Result<(), String> {
    register_with(&build_agent(), rendezvous, session, token, tunnel_url)
}

/// agent を注入できる本体 (test で mock server に向ける)。
fn register_with(
    agent: &ureq::Agent,
    rendezvous: &str,
    session: &str,
    token: &str,
    tunnel_url: &str,
) -> Result<(), String> {
    let url = format!(
        "{}/register/{}?token={}",
        rendezvous.trim_end_matches('/'),
        encode(session),
        encode(token),
    );
    match agent
        .post(&url)
        .send_json(json!({ "tunnel_url": tunnel_url }))
    {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(code, _)) => Err(format!("register status {code}")),
        Err(e) => Err(format!("register 失敗: {e}")),
    }
}

/// path/query segment 用の最小 percent-encode。session/token は英数 hex 想定だが念のため。
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_passes_safe_and_escapes_others() {
        assert_eq!(encode("abcXYZ-09_.~"), "abcXYZ-09_.~");
        assert_eq!(encode("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn register_posts_tunnel_url_and_ok_on_200() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = "{\"ok\":true}";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = s.write_all(resp.as_bytes());
            req
        });

        let agent = ureq::builder().timeout(Duration::from_secs(5)).build();
        let r = register_with(
            &agent,
            &format!("http://127.0.0.1:{port}"),
            "mylaptop",
            "tok123",
            "https://x.trycloudflare.com",
        );
        assert!(r.is_ok());
        let req = handle.join().unwrap();
        assert!(req.starts_with("POST /register/mylaptop?token=tok123 "));
        assert!(req.contains("x.trycloudflare.com"));
    }

    #[test]
    fn register_err_on_401() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = s.read(&mut buf);
            let resp =
                "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = s.write_all(resp.as_bytes());
        });

        let agent = ureq::builder().timeout(Duration::from_secs(5)).build();
        let r = register_with(
            &agent,
            &format!("http://127.0.0.1:{port}"),
            "s",
            "bad",
            "https://x/",
        );
        assert_eq!(r.unwrap_err(), "register status 401");
        handle.join().unwrap();
    }
}
