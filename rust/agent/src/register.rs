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
    let url = build_register_url(rendezvous, session, token);
    match agent
        .post(&url)
        .send_json(json!({ "tunnel_url": tunnel_url }))
    {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(code, _)) => Err(format!("register status {code}")),
        Err(e) => Err(format!("register 失敗: {e}")),
    }
}

/// /register/{session}?token= URL を組み立てる (純関数、test 可能)。
fn build_register_url(rendezvous: &str, session: &str, token: &str) -> String {
    format!(
        "{}/register/{}?token={}",
        rendezvous.trim_end_matches('/'),
        encode(session),
        encode(token),
    )
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
    fn build_register_url_shape_and_encoding() {
        // 末尾スラッシュは正規化、session/token は percent-encode。
        assert_eq!(
            build_register_url("https://cdp-relay.ippoan.org/", "my laptop", "tok/1"),
            "https://cdp-relay.ippoan.org/register/my%20laptop?token=tok%2F1"
        );
        assert_eq!(
            build_register_url("http://127.0.0.1:19222", "s", "t"),
            "http://127.0.0.1:19222/register/s?token=t"
        );
    }
}
