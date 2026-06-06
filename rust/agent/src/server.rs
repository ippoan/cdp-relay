//! HTTP ルーティング (cdp-relay#12 M5/M2)。socket 非依存の純関数にして unit test 可能に
//! する。main.rs は **2 つの tiny_http server** を立てる:
//!
//!   - MCP server (cloudflared が tunnel 公開する port): `GET /ping` / `POST /mcp`
//!   - ext server (localhost 専用・非公開 port): `GET /ext/poll` / `POST /ext/result`
//!
//! `/ext/*` を別 port に隔離するのは、tunnel 経由で remote が command を注入 / 結果を
//! 偽装できないようにするため (拡張は手元 localhost からのみ繋ぐ)。

use crate::extbridge::{command_to_json, ExtBridge};
use crate::mcp;
use std::time::Duration;

/// HTTP 応答 (tiny_http に変換して返す素材)。
pub struct HttpReply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpReply {
    fn text(status: u16, body: impl Into<String>) -> Self {
        HttpReply {
            status,
            headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
            body: body.into().into_bytes(),
        }
    }
    fn json(status: u16, body: String) -> Self {
        HttpReply {
            status,
            headers: vec![(
                "Content-Type".into(),
                "application/json; charset=utf-8".into(),
            )],
            body: body.into_bytes(),
        }
    }
}

/// poll の long-poll 上限。拡張はこれで空振りしたら再 poll する。
const POLL_TIMEOUT: Duration = Duration::from_secs(25);

/// MCP server (tunnel 公開 port) のルーティング。
pub fn handle_mcp(method: &str, url: &str, body: &str, bridge: &ExtBridge) -> HttpReply {
    let path = url.split('?').next().unwrap_or(url);
    match (method, path) {
        ("GET", "/ping") => HttpReply::text(200, "pong from cdp-agent\n"),
        ("POST", "/mcp") => {
            let reply = mcp::handle(body, bridge);
            let mut headers = vec![(
                "Content-Type".to_string(),
                "application/json; charset=utf-8".to_string(),
            )];
            if let Some(sid) = reply.session_id {
                headers.push(("Mcp-Session-Id".to_string(), sid));
            }
            match reply.body {
                None => HttpReply {
                    status: 202,
                    headers,
                    body: Vec::new(),
                },
                Some(json) => HttpReply {
                    status: 200,
                    headers,
                    body: json.into_bytes(),
                },
            }
        }
        ("GET", "/mcp") => HttpReply::text(405, "use POST for /mcp\n"),
        _ => HttpReply::text(404, "not found\n"),
    }
}

/// ext server (localhost 専用 port) のルーティング。
pub fn handle_ext(method: &str, url: &str, body: &str, bridge: &ExtBridge) -> HttpReply {
    let path = url.split('?').next().unwrap_or(url);
    match (method, path) {
        // 拡張が CDP コマンドを引き取る (long-poll)。無ければ 204。
        ("GET", "/ext/poll") => match bridge.poll(POLL_TIMEOUT) {
            Some(cmd) => HttpReply::json(200, command_to_json(&cmd).to_string()),
            None => HttpReply {
                status: 204,
                headers: Vec::new(),
                body: Vec::new(),
            },
        },
        // 拡張が CDP 実行結果を返す。
        ("POST", "/ext/result") => match bridge.result_from_json(body) {
            Ok(()) => HttpReply::json(200, "{\"ok\":true}".to_string()),
            Err(e) => HttpReply::json(400, format!("{{\"error\":{:?}}}", e)),
        },
        // 拡張 popup が「接続用プロンプト」を組み立てるために MCP URL を引く。
        ("GET", "/ext/info") => {
            let mcp = bridge.mcp_url().unwrap_or_default();
            HttpReply::json(200, serde_json::json!({ "mcp_url": mcp }).to_string())
        }
        _ => HttpReply::text(404, "not found\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn ping_returns_pong() {
        let b = ExtBridge::new();
        let r = handle_mcp("GET", "/ping", "", &b);
        assert_eq!(r.status, 200);
        assert!(String::from_utf8_lossy(&r.body).contains("pong from cdp-agent"));
    }

    #[test]
    fn mcp_notification_is_202_empty() {
        let b = ExtBridge::new();
        let r = handle_mcp(
            "POST",
            "/mcp",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            &b,
        );
        assert_eq!(r.status, 202);
        assert!(r.body.is_empty());
    }

    #[test]
    fn ext_poll_204_when_empty() {
        let b = ExtBridge::new();
        // handle_ext は POLL_TIMEOUT 待つので、ここでは bridge.poll の短 timeout で
        // 「空なら None」だけ確認する。
        assert!(b.poll(Duration::from_millis(10)).is_none());
    }

    #[test]
    fn ext_info_returns_mcp_url() {
        let b = ExtBridge::new();
        b.set_mcp_url("https://x.trycloudflare.com/mcp".into());
        let r = handle_ext("GET", "/ext/info", "", &b);
        assert_eq!(r.status, 200);
        let v: Value = serde_json::from_slice(&r.body).unwrap();
        assert_eq!(v["mcp_url"], "https://x.trycloudflare.com/mcp");
    }

    #[test]
    fn ext_result_resolves_mcp_tool_call() {
        // navigate を別スレッドで投げ、ext server 経由で result を返して往復を確認。
        let bridge = Arc::new(ExtBridge::new());
        let b2 = Arc::clone(&bridge);
        let caller = thread::spawn(move || {
            handle_mcp(
                "POST",
                "/mcp",
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"https://example.com/"}}}"#,
                &b2,
            )
        });
        // 拡張役: poll で command を引き、result を返す。
        let cmd = bridge.poll(Duration::from_secs(2)).expect("command queued");
        assert_eq!(cmd.method, "navigate");
        let body = format!(
            r#"{{"id":{},"result":{{"url":"https://example.com/"}}}}"#,
            cmd.id
        );
        let res = handle_ext("POST", "/ext/result", &body, &bridge);
        assert_eq!(res.status, 200);

        let reply = caller.join().unwrap();
        assert_eq!(reply.status, 200);
        let v: Value = serde_json::from_slice(&reply.body).unwrap();
        assert!(v["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("https://example.com/"));
    }
}
