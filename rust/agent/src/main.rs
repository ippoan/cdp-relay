//! cdp-agent — 手元マシンで動かす agent (cdp-relay#12)。
//!
//! 2 つの HTTP server を立てる:
//!   - MCP server (cloudflared が tunnel 公開する port): `GET /ping` / `POST /mcp`
//!   - ext server (localhost 専用・非公開 port): `GET /ext/poll` / `POST /ext/result`
//!
//! MCP tool が積んだ CDP コマンドを ExtBridge 経由で拡張に渡し (long-poll)、拡張が
//! chrome.debugger で実行した結果を返す。`/ext/*` を別 port に隔離するので、tunnel
//! 経由で remote が command 注入 / 結果偽装できない。
//!
//! CCoW では cloudflared が edge:7844 に届かない (#10) ので tunnel 払い出しは手元で。
//! `CLOUDFLARED_BIN` で path 上書き、`CDP_AGENT_ECHO_ONLY=1` で tunnel を張らず HTTP
//! server だけ起動する。

mod extbridge;
mod mcp;
mod nmhost;
mod register;
mod server;
mod update;

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;

use extbridge::ExtBridge;
use server::HttpReply;
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

type Router = fn(&str, &str, &str, &ExtBridge) -> HttpReply;

/// tiny_http のリクエストを router に橋渡しして応答する。
fn serve(server: Arc<Server>, bridge: Arc<ExtBridge>, router: Router) {
    for mut request in server.incoming_requests() {
        let method = request.method().as_str().to_string();
        let url = request.url().to_string();
        let mut body = String::new();
        let _ = request.as_reader().read_to_string(&mut body);

        let reply = router(&method, &url, &body, &bridge);
        let mut response = Response::from_data(reply.body).with_status_code(reply.status);
        for (k, v) in &reply.headers {
            if let Ok(h) = Header::from_bytes(k.as_bytes(), v.as_bytes()) {
                response.add_header(h);
            }
        }
        let _ = request.respond(response);
    }
}

fn bind_port(server: &Server) -> u16 {
    server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .expect("server addr")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Chrome が Native Messaging で起動した場合 (argv に chrome-extension://… origin、または
    // 明示の --native-host) は stdio launcher として動き、他は一切立てない (cdp-relay#33)。
    if nmhost::is_native_host_invocation(&args) {
        nmhost::run_native_host();
        return;
    }

    // 手動で native-host を登録する。Chrome/Edge の HKCU registry + manifest を書く。
    if args.iter().any(|a| a == "--install-native-host") {
        match nmhost::install_native_host() {
            Ok(msg) => println!("{msg}"),
            Err(e) => {
                eprintln!("[cdp-agent] native-host 登録失敗: {e}");
                std::process::exit(1);
            }
        }
        return;
    }

    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "cdp-agent — cf quick tunnel + /mcp MCP server + 拡張ブリッジ (cdp-relay#12)\n\n\
             usage: cdp-agent [--install-native-host | --native-host]\n  \
             --install-native-host  Chrome/Edge の Native Messaging host を登録して終了 (#33)\n  \
             --native-host          stdio launcher として動く (通常は Chrome が自動で付与)\n  \
             CDP_AGENT_ECHO_ONLY=1   HTTP server だけ起動 (tunnel を張らない)\n  \
             CLOUDFLARED_BIN=<path>  cloudflared バイナリの path を上書き\n  \
             CDP_AGENT_EXT_PORT=<n>  ext server の port (default 19222、拡張の接続先)\n  \
             CDP_AGENT_NO_SELFUPDATE 起動時 self-update を無効化\n  \
             CDP_AGENT_NO_NM_REGISTER 起動時の native-host 自己登録を無効化\n  \
             CDP_AGENT_SESSION=<s>   rendezvous の session 名 (TOKEN と併せて tunnel URL を登録)\n  \
             CDP_AGENT_TOKEN=<t>     rendezvous の token (= RELAY_TOKEN)\n  \
             CDP_AGENT_RENDEZVOUS=<u> rendezvous base (default https://cdp-relay.ippoan.org)\n\n\
             ports: MCP (/ping,/mcp; tunnel 公開) と ext (/ext/poll,/ext/result; localhost 専用)"
        );
        return;
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("cdp-agent {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let bridge = Arc::new(ExtBridge::new());

    // MCP server (tunnel 公開) は動的 port (cloudflared が拾う)。
    let mcp_server = Arc::new(Server::http("127.0.0.1:0").expect("bind mcp server"));
    // ext server (localhost 専用) は固定 default 19222。起動毎に変わると拡張の
    // Relay URL を入れ直す羽目になるため固定する。CDP_AGENT_EXT_PORT で上書き、
    // 埋まっていれば動的 port に fallback する。
    let ext_pref: u16 = std::env::var("CDP_AGENT_EXT_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(19222);
    let ext_server = Arc::new(
        Server::http(("127.0.0.1", ext_pref))
            .or_else(|_| Server::http("127.0.0.1:0"))
            .expect("bind ext server"),
    );
    let mcp_port = bind_port(&mcp_server);
    let ext_port = bind_port(&ext_server);
    eprintln!("[cdp-agent] MCP http port {mcp_port} (tunnel 公開)  /ping /mcp");
    eprintln!("[cdp-agent] ext http port {ext_port} (localhost 専用)  /ext/poll /ext/result");

    // Native Messaging host を idempotent に自己登録する (#33)。これで一度通常起動すれば、
    // 次回以降は拡張が Native Messaging で agent を自動起動できる (Windows のみ実体)。
    if std::env::var("CDP_AGENT_NO_NM_REGISTER").is_err() {
        match nmhost::install_native_host() {
            Ok(msg) => eprintln!("[cdp-agent] {msg}"),
            Err(e) => eprintln!("[cdp-agent] native-host 自己登録 skip: {e}"),
        }
    }

    {
        let b = Arc::clone(&bridge);
        let s = Arc::clone(&mcp_server);
        thread::spawn(move || serve(s, b, server::handle_mcp));
    }
    let ext_thread = {
        let b = Arc::clone(&bridge);
        let s = Arc::clone(&ext_server);
        thread::spawn(move || serve(s, b, server::handle_ext))
    };

    // CDP_AGENT_ECHO_ONLY=1: cloudflared を spawn せず HTTP server だけ回す。
    if std::env::var("CDP_AGENT_ECHO_ONLY").is_ok() {
        println!("ECHO_PORT={mcp_port}");
        println!("EXT_PORT={ext_port}");
        let _ = ext_thread.join();
        return;
    }

    // 起動時 self-update を背景で実行 (#12 M6)。dev ビルドや最新時は no-op。
    if std::env::var("CDP_AGENT_NO_SELFUPDATE").is_err() {
        thread::spawn(|| {
            match update::check_and_self_update() {
                Ok(Some(tag)) => {
                    eprintln!("[cdp-agent] self-update: {tag} を取得。次回起動で反映されます")
                }
                Ok(None) => {}
                Err(e) => eprintln!("[cdp-agent] self-update skip: {e}"),
            }
            // 同梱拡張 (unpacked) も最新に更新する。Chrome 起動/再起動で反映。
            match update::update_extension() {
                Ok(Some(tag)) => {
                    eprintln!("[cdp-agent] 拡張を更新: {tag} (Chrome 再起動で反映)")
                }
                Ok(None) => {}
                Err(e) => eprintln!("[cdp-agent] 拡張更新 skip: {e}"),
            }
        });
    }

    let bin = std::env::var("CLOUDFLARED_BIN").unwrap_or_else(|_| "cloudflared".into());
    let mut child = match Command::new(&bin)
        .args([
            "tunnel",
            "--url",
            &format!("http://localhost:{mcp_port}"),
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
    let bridge_for_url = Arc::clone(&bridge);
    let url_thread = thread::spawn(move || {
        let mut found = false;
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[cloudflared] {line}");
            if !found {
                if let Some(u) = extract_url(&line) {
                    found = true;
                    // 拡張の /ext/info 用に MCP URL を記録。
                    bridge_for_url.set_mcp_url(format!("{u}/mcp"));
                    println!(
                        "\n=== QUICK TUNNEL URL ===\n{u}\n\
                         MCP として使う:   {u}/mcp\n\
                         拡張の接続先:     http://127.0.0.1:{ext_port} (localhost、tunnel しない)\n\
                         ========================\n"
                    );
                    // rendezvous: session/token があれば tunnel URL を DO に登録する。
                    // CCoW 側 cdp-proxy が同 session/token で /lookup して固定 stdio のまま
                    // 揮発 URL に追従できる。
                    if let (Ok(session), Ok(token)) = (
                        std::env::var("CDP_AGENT_SESSION"),
                        std::env::var("CDP_AGENT_TOKEN"),
                    ) {
                        let rdv = std::env::var("CDP_AGENT_RENDEZVOUS")
                            .unwrap_or_else(|_| "https://cdp-relay.ippoan.org".into());
                        match register::register_tunnel(&rdv, &session, &token, &u) {
                            Ok(()) => {
                                eprintln!("[cdp-agent] rendezvous 登録: {rdv} session={session}")
                            }
                            Err(e) => eprintln!("[cdp-agent] rendezvous 登録失敗: {e}"),
                        }
                    }
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
