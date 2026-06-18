//! agent 側の最小 MCP server ロジック (cdp-relay#12 M5/M2)。
//!
//! Streamable HTTP の `/mcp` に来る JSON-RPC を捌く純ロジック。tool の実体 (CDP) は
//! `CommandSink` (= ExtBridge) 経由で拡張に投げる。HTTP/socket には依存しないので
//! sink を fake にすれば unit test できる。tool 表面 (navigate / screenshot / eval) は現行
//! worker 版 (`src/mcp/tools.ts`) に合わせる。

use crate::extbridge::CommandSink;
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

/// JSON-RPC 1 メッセージ (1 行) を処理する。tool 実行は sink (拡張) に委譲する。
pub fn handle(body: &str, sink: &dyn CommandSink) -> McpReply {
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
            // version は CARGO_PKG_VERSION (常に 0.0.0) ではなく build.rs が埋め込む
            // release tag (例 cdp-agent-dev-33) を使う。どの版が動いているか = どのツール
            // 面 (browser_eval の有無等) かを initialize だけで判別できるようにする。
            let result = json!({
                "protocolVersion": pv,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": {
                    "name": "cdp-agent",
                    "version": crate::update::current_release_tag().unwrap_or("dev")
                }
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
            body: Some(tools_call(&id, &req, sink)),
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
                "description": "手元 Chrome の viewport を撮影し PNG を返す。",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "browser_eval",
                "description": "手元 Chrome の現在ページで JavaScript 式を評価し結果を返す。\
    text 取得は `document.body.innerText`、特定要素は `document.querySelector('sel').innerText` 等。\
    返り値は文字列ならそのまま、それ以外は JSON 文字列化して text content で返す。",
                "inputSchema": {
                    "type": "object",
                    "properties": { "expression": { "type": "string", "description": "評価する JavaScript 式" } },
                    "required": ["expression"]
                }
            }
        ]
    })
}

fn tools_call(id: &Value, req: &Value, sink: &dyn CommandSink) -> String {
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
            // 拡張に navigate を投げて CDP 実行を待つ (M2)。
            match sink.send("navigate", json!({ "url": url })) {
                Ok(_) => result_envelope(id, tool_text(&format!("navigated to {url}"))),
                Err(e) => error_envelope(id, -32000, &e),
            }
        }
        "browser_screenshot" => {
            // 拡張が Page.captureScreenshot した base64 PNG を MCP image content で返す。
            match sink.send("screenshot", json!({})) {
                Ok(v) => {
                    let data = v.get("data").and_then(Value::as_str).unwrap_or("");
                    result_envelope(
                        id,
                        json!({
                            "content": [
                                { "type": "image", "data": data, "mimeType": "image/png" }
                            ]
                        }),
                    )
                }
                Err(e) => error_envelope(id, -32000, &e),
            }
        }
        "browser_eval" => {
            let expr = args.get("expression").and_then(Value::as_str).unwrap_or("");
            if expr.is_empty() {
                return error_envelope(id, -32602, "expression is required");
            }
            // 拡張が Runtime.evaluate (returnByValue) した結果 { value } を text content で返す。
            match sink.send("eval", json!({ "expression": expr })) {
                Ok(v) => {
                    let value = v.get("value").cloned().unwrap_or(Value::Null);
                    let text = match value {
                        Value::String(s) => s,
                        other => other.to_string(),
                    };
                    result_envelope(id, tool_text(&text))
                }
                Err(e) => error_envelope(id, -32000, &e),
            }
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

    /// 固定応答を返す fake sink。
    struct FakeSink(Result<Value, String>);
    impl CommandSink for FakeSink {
        fn send(&self, _method: &str, _params: Value) -> Result<Value, String> {
            self.0.clone()
        }
    }
    fn ok_sink() -> FakeSink {
        FakeSink(Ok(
            json!({ "url": "https://example.com/", "data": "QUFBQQ==" }),
        ))
    }

    fn parse(body: &str) -> Value {
        serde_json::from_str(body).unwrap()
    }

    #[test]
    fn initialize_returns_serverinfo_and_session_id() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#,
            &ok_sink(),
        );
        assert!(r.session_id.is_some());
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"]["serverInfo"]["name"], "cdp-agent");
        assert_eq!(v["result"]["protocolVersion"], "2025-03-26");
    }

    #[test]
    fn notification_has_no_response() {
        let r = handle(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            &ok_sink(),
        );
        assert!(r.body.is_none());
        assert!(r.session_id.is_none());
    }

    #[test]
    fn tools_list_exposes_navigate_and_screenshot() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            &ok_sink(),
        );
        let v = parse(r.body.as_deref().unwrap());
        let names: Vec<&str> = v["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            ["browser_navigate", "browser_screenshot", "browser_eval"]
        );
    }

    #[test]
    fn eval_returns_string_value_as_text() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"browser_eval","arguments":{"expression":"document.title"}}}"#,
            &FakeSink(Ok(json!({ "value": "Example Domain" }))),
        );
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["result"]["content"][0]["type"], "text");
        assert_eq!(v["result"]["content"][0]["text"], "Example Domain");
    }

    #[test]
    fn eval_stringifies_non_string_value() {
        // 数値や object は JSON 文字列化して返す (other => to_string 経路)。
        let r = handle(
            r#"{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"browser_eval","arguments":{"expression":"1+2"}}}"#,
            &FakeSink(Ok(json!({ "value": 3 }))),
        );
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["result"]["content"][0]["text"], "3");
    }

    #[test]
    fn eval_missing_value_becomes_null_text() {
        // value 欠落時は Value::Null → "null" (unwrap_or(Null) 経路)。
        let r = handle(
            r#"{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"browser_eval","arguments":{"expression":"void 0"}}}"#,
            &FakeSink(Ok(json!({}))),
        );
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["result"]["content"][0]["text"], "null");
    }

    #[test]
    fn eval_rejects_empty_expression_without_calling_sink() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"browser_eval","arguments":{"expression":""}}}"#,
            &FakeSink(Err("should not be called".into())),
        );
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["error"]["code"], -32602);
    }

    #[test]
    fn eval_error_propagates_as_jsonrpc_error() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":24,"method":"tools/call","params":{"name":"browser_eval","arguments":{"expression":"throw 1"}}}"#,
            &FakeSink(Err("eval exception".into())),
        );
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["error"]["code"], -32000);
        assert!(v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("eval exception"));
    }

    #[test]
    fn navigate_sends_to_sink_and_returns_text() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"https://example.com/"}}}"#,
            &ok_sink(),
        );
        let v = parse(r.body.as_deref().unwrap());
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("https://example.com/"));
    }

    #[test]
    fn navigate_rejects_non_http_without_calling_sink() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"ftp://x"}}}"#,
            &FakeSink(Err("should not be called".into())),
        );
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["error"]["code"], -32602);
    }

    #[test]
    fn screenshot_returns_image_content() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"browser_screenshot","arguments":{}}}"#,
            &ok_sink(),
        );
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["result"]["content"][0]["type"], "image");
        assert_eq!(v["result"]["content"][0]["mimeType"], "image/png");
        assert_eq!(v["result"]["content"][0]["data"], "QUFBQQ==");
    }

    #[test]
    fn tool_error_propagates_as_jsonrpc_error() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"browser_navigate","arguments":{"url":"https://x/"}}}"#,
            &FakeSink(Err("cdp_timeout".into())),
        );
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["error"]["code"], -32000);
        assert!(v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("cdp_timeout"));
    }

    #[test]
    fn unknown_tool_is_method_not_found() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"nope","arguments":{}}}"#,
            &ok_sink(),
        );
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["error"]["code"], -32601);
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        let r = handle(r#"{"jsonrpc":"2.0","id":8,"method":"foo/bar"}"#, &ok_sink());
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["error"]["code"], -32601);
    }

    #[test]
    fn invalid_json_is_parse_error() {
        let r = handle("not json", &ok_sink());
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["error"]["code"], -32700);
    }

    #[test]
    fn ping_returns_empty_result() {
        let r = handle(r#"{"jsonrpc":"2.0","id":9,"method":"ping"}"#, &ok_sink());
        assert!(r.session_id.is_none());
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["id"], 9);
        assert!(v["result"].is_object());
    }

    #[test]
    fn tools_call_without_arguments_defaults_to_empty() {
        // params.arguments を省略 → args は json!({}) に fallback (unwrap_or_else 経路)。
        let r = handle(
            r#"{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"browser_screenshot"}}"#,
            &ok_sink(),
        );
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["result"]["content"][0]["type"], "image");
    }

    #[test]
    fn screenshot_error_propagates_as_jsonrpc_error() {
        let r = handle(
            r#"{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"browser_screenshot","arguments":{}}}"#,
            &FakeSink(Err("debugger detached".into())),
        );
        let v = parse(r.body.as_deref().unwrap());
        assert_eq!(v["error"]["code"], -32000);
        assert!(v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("debugger detached"));
    }
}
