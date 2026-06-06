//! cdp-agent — 手元マシンで動かす agent (cdp-relay#12)。
//!
//! 1. 127.0.0.1 の任意 port に HTTP server (tiny_http) を立てる
//!    - `GET  /ping` … M1 互換の疎通確認 (echo)
//!    - `POST /mcp`  … MCP server (M5、tool は今 stub。CDP 実体は M2/NM で接続)
//! 2. `cloudflared tunnel --url http://localhost:<port>` を spawn する
//! 3. cloudflared の出力から `https://<rnd>.trycloudflare.com` を拾って stdout に出す
//!
//! CCoW では cloudflared が edge:7844 に届かない (#10) ので tunnel 払い出しは手元で
//! 実行する。`CLOUDFLARED_BIN` で cloudflared バイナリの path を上書きできる。
//! `CDP_AGENT_ECHO_ONLY=1` で cloudflared を spawn せず HTTP server だけ起動する。

mod mcp;
mod server;

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;

use tiny_http::{Header, Response, Server};

/// cloudflared のログ 1 行から quick tunnel URL を抽出する。
fn extract_url(line: &str) -> Option<String> {
    let i = line.find("https://")?;
    let rest = &line[i..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|')
        .unwrap_or(rest.len());
    let url = rest[..end].to_string();
    if url.contains(".trycloudflare.com") {
        Some(url)
    } else {
        None
    }
}

/// tiny_http のリクエストを server::handle_http に橋渡しして応答する。
fn serve(server: Arc<Server>) {
    for mut request in server.incoming_requests() {
        let method = request.method().as_str().to_string();
        let url = request.url().to_string();
        let mut body = String::new();
        let _ = request.as_reader().read_to_string(&mut body);

        let reply = server::handle_http(&method, &url, &body);
        let mut response = Response::from_data(reply.body).with_status_code(reply.status);
        for (k, v) in &reply.headers {
            if let Ok(h) = Header::from_bytes(k.as_bytes(), v.as_bytes()) {
                response.add_header(h);
            }
        }
        let _ = request.respond(response);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "cdp-agent — cf quick tunnel + /mcp MCP server (cdp-relay#12)\n\n\
             usage: cdp-agent\n  \
             CDP_AGENT_ECHO_ONLY=1   HTTP server だけ起動 (tunnel を張らない)\n  \
             CLOUDFLARED_BIN=<path>  cloudflared バイナリの path を上書き\n\n\
             endpoints: GET /ping (echo) / POST /mcp (MCP server)"
        );
        return;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("cdp-agent {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let server = Arc::new(Server::http("127.0.0.1:0").expect("bind http server"));
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .expect("server addr");
    eprintln!("[cdp-agent] http server: http://127.0.0.1:{port}  (GET /ping, POST /mcp)");

    let serve_server = Arc::clone(&server);
    let serve_thread = thread::spawn(move || serve(serve_server));

    // CDP_AGENT_ECHO_ONLY=1: cloudflared を spawn せず HTTP server だけ回す。
    if std::env::var("CDP_AGENT_ECHO_ONLY").is_ok() {
        println!("ECHO_PORT={port}");
        let _ = serve_thread.join();
        return;
    }

    let bin = std::env::var("CLOUDFLARED_BIN").unwrap_or_else(|_| "cloudflared".into());
    let mut child = match Command::new(&bin)
        .args([
            "tunnel",
            "--url",
            &format!("http://localhost:{port}"),
            "--no-autoupdate",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "[cdp-agent] cloudflared の起動に失敗: {e}\n  \
                 CLOUDFLARED_BIN で path を指定するか cloudflared を install してください"
            );
            std::process::exit(1);
        }
    };

    // cloudflared はログを stderr に出す。1 行ずつ読んで URL を拾う。
    let stderr = child.stderr.take().unwrap();
    let url_thread = thread::spawn(move || {
        let mut found = false;
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[cloudflared] {line}");
            if !found {
                if let Some(u) = extract_url(&line) {
                    found = true;
                    println!(
                        "\n=== QUICK TUNNEL URL ===\n{u}\n\
                         CCoW で到達確認:  cargo run -p cdp-prober -- {u}\n\
                         MCP として使う:   {u}/mcp\n\
                         ========================\n"
                    );
                }
            }
        }
    });

    if let Some(out) = child.stdout.take() {
        thread::spawn(move || {
            for l in BufReader::new(out).lines().map_while(Result::ok) {
                eprintln!("[cloudflared:out] {l}");
            }
        });
    }

    let _ = child.wait();
    let _ = url_thread.join();
}

#[cfg(test)]
mod tests {
    use super::extract_url;

    #[test]
    fn extracts_url_from_table_line() {
        let line = "2026-... INF |  https://director-flex-eye-dress.trycloudflare.com    |";
        assert_eq!(
            extract_url(line).as_deref(),
            Some("https://director-flex-eye-dress.trycloudflare.com")
        );
    }

    #[test]
    fn ignores_non_trycloudflare_url() {
        assert_eq!(extract_url("see https://example.com/foo"), None);
    }

    #[test]
    fn none_when_no_url() {
        assert_eq!(
            extract_url("2026-... INF Requesting new quick Tunnel..."),
            None
        );
    }
}
