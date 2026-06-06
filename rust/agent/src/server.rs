//! HTTP ルーティング (cdp-relay#12 M5)。socket 非依存の純関数にして unit test 可能に
//! する。main.rs の tiny_http ループはこの `handle_http` に method/url/body を渡すだけ。
//!
//!   GET  /ping  … M1 互換の疎通確認 (echo)
//!   POST /mcp   … MCP server (mcp::handle に委譲)

use crate::mcp;

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
}

/// method + url + body を応答に落とす。
pub fn handle_http(method: &str, url: &str, body: &str) -> HttpReply {
    // url はクエリを含みうるので path だけ見る。
    let path = url.split('?').next().unwrap_or(url);

    match (method, path) {
        ("GET", "/ping") => HttpReply::text(200, "pong from cdp-agent\n"),
        ("POST", "/mcp") => {
            let reply = mcp::handle(body);
            let mut headers = vec![(
                "Content-Type".to_string(),
                "application/json; charset=utf-8".to_string(),
            )];
            if let Some(sid) = reply.session_id {
                headers.push(("Mcp-Session-Id".to_string(), sid));
            }
            match reply.body {
                // notification 等、応答本体なし → 202。
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn ping_returns_pong() {
        let r = handle_http("GET", "/ping", "");
        assert_eq!(r.status, 200);
        assert!(String::from_utf8_lossy(&r.body).contains("pong from cdp-agent"));
    }

    #[test]
    fn mcp_initialize_sets_session_header_and_json() {
        let r = handle_http(
            "POST",
            "/mcp",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        );
        assert_eq!(r.status, 200);
        assert!(r
            .headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("Mcp-Session-Id")));
        let v: Value = serde_json::from_slice(&r.body).unwrap();
        assert_eq!(v["result"]["serverInfo"]["name"], "cdp-agent");
    }

    #[test]
    fn mcp_notification_is_202_empty() {
        let r = handle_http(
            "POST",
            "/mcp",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        );
        assert_eq!(r.status, 202);
        assert!(r.body.is_empty());
    }

    #[test]
    fn unknown_path_is_404() {
        let r = handle_http("GET", "/nope", "");
        assert_eq!(r.status, 404);
    }

    #[test]
    fn get_mcp_is_405() {
        let r = handle_http("GET", "/mcp", "");
        assert_eq!(r.status, 405);
    }
}
