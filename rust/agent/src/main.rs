//! cdp-agent — M1 (土台実証) 用の最小 agent。
//!
//! 1. 127.0.0.1 の任意 port に echo server (std::net) を立てる
//! 2. `cloudflared tunnel --url http://localhost:<port>` を spawn する
//! 3. cloudflared の出力から `https://<rnd>.trycloudflare.com` を拾って stdout に出す
//!
//! これで「手元から張った quick tunnel に CCoW (cdp-prober) が 443 で到達できるか」を
//! 実証する。実トラフィックを手元で受ける agent の骨格でもある (cdp-relay#12 M1)。
//!
//! 依存ゼロ。CCoW では cloudflared が edge:7844 に届かない (#10) ので tunnel 払い出しは
//! 手元で実行する。`CLOUDFLARED_BIN` で cloudflared バイナリの path を上書きできる。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::thread;

fn handle(mut s: TcpStream) {
    let peer = s.peer_addr().map(|a| a.to_string()).unwrap_or_default();
    let mut buf = [0u8; 2048];
    let n = s.read(&mut buf).unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]);
    let line = req.lines().next().unwrap_or("");
    let path = line.split_whitespace().nth(1).unwrap_or("/");
    let body = format!("pong from cdp-agent\npath={path}\npeer={peer}\n");
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = s.write_all(resp.as_bytes());
}

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

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "cdp-agent — cf quick tunnel + echo server (cdp-relay#12 M1)\n\n\
             usage: cdp-agent\n  \
             CDP_AGENT_ECHO_ONLY=1   echo server だけ起動 (tunnel を張らない)\n  \
             CLOUDFLARED_BIN=<path>  cloudflared バイナリの path を上書き"
        );
        return;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("cdp-agent {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind echo server");
    let port = listener.local_addr().unwrap().port();
    eprintln!("[cdp-agent] echo server: http://127.0.0.1:{port}  (GET /ping -> pong)");

    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            thread::spawn(move || handle(stream));
        }
    });

    // CDP_AGENT_ECHO_ONLY=1: cloudflared を spawn せず echo server だけ前面で回す。
    // tunnel を張らずに echo server ⇄ prober の往復ロジックだけを確認する用途 (CCoW でも可)。
    if std::env::var("CDP_AGENT_ECHO_ONLY").is_ok() {
        println!("ECHO_PORT={port}");
        loop {
            thread::sleep(std::time::Duration::from_secs(3600));
        }
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
