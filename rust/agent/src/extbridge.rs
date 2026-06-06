//! ExtBridge — agent と手元拡張をつなぐ long-poll ブリッジ (cdp-relay#12 M2)。
//!
//! MCP tool (`tools_call`) が CDP コマンドを積み、拡張が `/ext/poll` で引き取り、
//! `chrome.debugger` で実行した結果を `/ext/result` で返す。WS ライブラリ不要 (tiny_http
//! の long-poll で完結) で、拡張 ⇄ agent は **localhost 専用 port** に閉じる。
//!
//! **security**: `/ext/*` は cloudflared が公開する MCP port とは **別 port** に置く。
//! cloudflared は MCP port だけを tunnel するので、ext エンドポイント (command 配信 /
//! 結果投入) はインターネットから到達できない (remote からの command 注入を防ぐ)。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

/// MCP tool → CDP の 1 コマンド。
#[derive(Debug, Clone, PartialEq)]
pub struct Command {
    pub id: u64,
    pub method: String,
    pub params: Value,
}

/// tools_call が CDP コマンドを投げる先の抽象。mcp.rs を ExtBridge 実体から切り離して
/// テストするための trait。
pub trait CommandSink {
    fn send(&self, method: &str, params: Value) -> Result<Value, String>;
}

/// 1 往復のタイムアウト。
const CMD_TIMEOUT: Duration = Duration::from_secs(30);

pub struct ExtBridge {
    cmd_tx: Sender<Command>,
    cmd_rx: Mutex<Receiver<Command>>,
    pending: Mutex<HashMap<u64, Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    /// quick tunnel の MCP URL (cloudflared が出たら main が set)。拡張の /ext/info が
    /// これを返し、popup が「接続用プロンプト」に埋め込む。
    mcp_url: Mutex<Option<String>>,
}

impl Default for ExtBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl ExtBridge {
    pub fn new() -> Self {
        let (cmd_tx, cmd_rx) = channel();
        ExtBridge {
            cmd_tx,
            cmd_rx: Mutex::new(cmd_rx),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            mcp_url: Mutex::new(None),
        }
    }

    /// quick tunnel の MCP URL を記録する (main が cloudflared URL 取得時に呼ぶ)。
    pub fn set_mcp_url(&self, url: String) {
        *self.mcp_url.lock().unwrap() = Some(url);
    }

    /// 記録済みの MCP URL を返す (未確定なら None)。
    pub fn mcp_url(&self) -> Option<String> {
        self.mcp_url.lock().unwrap().clone()
    }

    /// 拡張が `/ext/poll` で 1 コマンドを引き取る。最大 `timeout` 待って無ければ None。
    pub fn poll(&self, timeout: Duration) -> Option<Command> {
        let rx = self.cmd_rx.lock().unwrap();
        rx.recv_timeout(timeout).ok()
    }

    /// 拡張が `/ext/result` で結果を返す。対応する pending を resolve する。
    pub fn result(&self, id: u64, res: Result<Value, String>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(res);
        }
    }

    /// `/ext/result` の body ({id, result?|error?}) を解釈して resolve する。
    pub fn result_from_json(&self, body: &str) -> Result<(), String> {
        let v: Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
        let id = v
            .get("id")
            .and_then(Value::as_u64)
            .ok_or("id (u64) required")?;
        if let Some(err) = v.get("error") {
            if !err.is_null() {
                let msg = err
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| err.to_string());
                self.result(id, Err(msg));
                return Ok(());
            }
        }
        let result = v.get("result").cloned().unwrap_or(Value::Null);
        self.result(id, Ok(result));
        Ok(())
    }
}

impl CommandSink for ExtBridge {
    /// コマンドを積んで拡張の結果を待つ。拡張未接続 (poll されない) なら CMD_TIMEOUT で
    /// `extension_not_connected` 相当のタイムアウト。
    fn send(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.cmd_tx
            .send(Command {
                id,
                method: method.to_string(),
                params,
            })
            .map_err(|_| "bridge closed".to_string())?;
        match rx.recv_timeout(CMD_TIMEOUT) {
            Ok(r) => r,
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err("cdp_timeout (extension not connected?)".to_string())
            }
        }
    }
}

/// Command を `/ext/poll` 応答 JSON にする。
pub fn command_to_json(cmd: &Command) -> Value {
    json!({ "id": cmd.id, "method": cmd.method, "params": cmd.params })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn round_trip_send_poll_result() {
        let bridge = Arc::new(ExtBridge::new());
        // 拡張役: poll → result を返す。
        let b2 = Arc::clone(&bridge);
        let ext = thread::spawn(move || {
            let cmd = b2.poll(Duration::from_secs(2)).expect("got command");
            assert_eq!(cmd.method, "navigate");
            assert_eq!(cmd.params["url"], "https://example.com/");
            b2.result(cmd.id, Ok(json!({ "url": "https://example.com/" })));
        });
        // tools_call 役: send して結果を待つ。
        let r = bridge
            .send("navigate", json!({ "url": "https://example.com/" }))
            .unwrap();
        assert_eq!(r["url"], "https://example.com/");
        ext.join().unwrap();
    }

    #[test]
    fn result_from_json_resolves_error() {
        let bridge = Arc::new(ExtBridge::new());
        let b2 = Arc::clone(&bridge);
        let ext = thread::spawn(move || {
            let cmd = b2.poll(Duration::from_secs(2)).unwrap();
            let body = format!(r#"{{"id":{},"error":"debugger detached"}}"#, cmd.id);
            b2.result_from_json(&body).unwrap();
        });
        let err = bridge.send("screenshot", json!({})).unwrap_err();
        assert_eq!(err, "debugger detached");
        ext.join().unwrap();
    }

    #[test]
    fn poll_times_out_when_no_command() {
        let bridge = ExtBridge::new();
        assert!(bridge.poll(Duration::from_millis(50)).is_none());
    }

    #[test]
    fn mcp_url_set_and_get() {
        let bridge = ExtBridge::new();
        assert!(bridge.mcp_url().is_none());
        bridge.set_mcp_url("https://x.trycloudflare.com/mcp".into());
        assert_eq!(
            bridge.mcp_url().as_deref(),
            Some("https://x.trycloudflare.com/mcp")
        );
    }

    #[test]
    fn command_to_json_shape() {
        let c = Command {
            id: 7,
            method: "navigate".into(),
            params: json!({"url":"https://x/"}),
        };
        let v = command_to_json(&c);
        assert_eq!(v["id"], 7);
        assert_eq!(v["method"], "navigate");
        assert_eq!(v["params"]["url"], "https://x/");
    }
}
