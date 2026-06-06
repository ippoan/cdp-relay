//! agent 側の最小 MCP server ロジック (cdp-relay#12 M5)。
//!
//! Streamable HTTP の `/mcp` に来る JSON-RPC を捌く純ロジック。HTTP/socket には
//! 依存しないので unit test しやすい。tool の実体 (CDP) はまだ stub で、M2 (NM 経由で
//! 拡張の chrome.debugger を叩く) で差し込む。tool 表面 (navigate / screenshot) は
//! 現行 worker 版 (`src/mcp/tools.ts`) に合わせる。

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

/// `/mcp` POST 1 件への応答。
pub struct McpReply {
    /// JSON-RPC 応答本体。None は notification (応答なし = 202)。
    pub body: Option<String>,
    /// initialize 時に発行する Mcp-Session-Id。
    pub session_id: Option<String>,
}

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);

/// stub の session id (ランダム性は重要でないので time+counter で一意化)。
fn new_session_id() -> String {
    let n = SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{t:x}-{n:x}")
}

/// JSON-RPC 1 メッセージ (1 行) を処理する。
pub fn handle(body: &str) -> McpReply {
    let req: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => {
            return McpReply {
                body: Some(error_envelope(&Value::Null, -32700, "parse error")),
                session_id: None,
            }
        }
    };

    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let id = req.get("id").cloned();

    // notification (id 無し) は応答を返さない。
    let Some(id) = id else {
        return McpReply {
            body: None,
            session_id: None,
        };
    };

    match method {
        "initialize" => {
            let pv = req
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-03-26");
            let result = json!({
                "protocolVersion": pv,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "cdp-agent", "version": env!("CARGO_PKG_VERSION") }
            });
            McpReply {
                body: Some(result_envelope(&id, result)),
                session_id: Some(new_session_id()),
            }
        }
        "tools/list" => McpReply {
            body: Some(result_envelope(&id, tools_list())),
            session_id: None,
        },
        "tools/call" => McpReply {
            body: Some(tools_call(&id, &req)),
            session_id: None,
        },
        "ping" => McpReply {
            body: Some(result_envelope(&id, json!({}))),
            session_id: None,
        },
        _ => McpReply {
            body: Some(error_envelope(&id, -32601, "method not found")),
            session_id: None,
        },
    }
}

fn tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "browser_navigate",
                "description": "手元 Chrome を指定 URL に遷移する (http/https)。",
                "inputSchema": {
                    "type": "object",
                    "properties": { "url": { "type": "string", "description": "遷移先 URL" } },
                    "required": ["url"]
                }
            },
            {
                "name": "browser_screenshot",
                "description": "手元 Chrome の viewport を撮影し shot_url を返す。",
                "inputSchema": { "type": "object", "properties": {} }
            }
        ]
    })
}

fn tools_call(id: &Value, req: &Value) -> String {
    let name = req
        .pointer("/params/name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let args = req
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "browser_navigate" => {
            let url = args.get("url").and_then(Value::as_str).unwrap_or("");
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return error_envelope(id, -32602, "url must be http(s)");
            }
            // TODO(M2): NM 経由で拡張に navigate を投げて CDP 実行する。今は stub。
            result_envelope(
                id,
                tool_text(&format!("navigated to {url} (stub — CDP は M2/NM で接続)")),
            )
        }
        "browser_screenshot" => {
            // TODO(M2): NM 経由で Page.captureScreenshot → shot 配信。今は stub。
            result_envelope(id, tool_text("screenshot stub (CDP は M2/NM で接続)"))
        }
        other => error_envelope(id, -32601, &format!("unknown tool: {other}")),
    }
}

fn tool_text(text: &str) -> Value {
    json!({ "content": [ { "type": "text", "text": text } ] })
}

fn result_envelope(id: &Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn error_envelope(id: &Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(body: &str) -> Value {
        serde_json::from_str(body).unwrap()
    }

    #[test]
    fn initialize_returns_serverinfo_and_session_id() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#,
        );
        assert!(r.session_id.is_some());
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"]["serverInfo"]["name"], "cdp-agent");
        assert_eq!(v["result"]["protocolVersion"], "2025-03-26");
    }

    #[test]
    fn notification_has_no_response() {
        let r = handle(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert!(r.body.is_none());
        assert!(r.session_id.is_none());
    }

    #[test]
    fn tools_list_exposes_navigate_and_screenshot() {
        let r = handle(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
        let v = parse(r.body.as_deref().unwrap());
        let names: Vec<&str> = v["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["browser_navigate", "browser_screenshot"]);
    }

    #[test]
    fn tools_call_navigate_stub_returns_text() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"https://example.com/"}}}"#,
        );
        let v = parse(r.body.as_deref().unwrap());
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("https://example.com/"));
    }

    #[test]
    fn tools_call_navigate_rejects_non_http() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"ftp://x"}}}"#,
        );
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["error"]["code"], -32602);
    }

    #[test]
    fn unknown_tool_is_method_not_found() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope","arguments":{}}}"#,
        );
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["error"]["code"], -32601);
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        let r = handle(r#"{"jsonrpc":"2.0","id":6,"method":"foo/bar"}"#);
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["error"]["code"], -32601);
    }

    #[test]
    fn invalid_json_is_parse_error() {
        let r = handle("not json");
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["error"]["code"], -32700);
    }
}
