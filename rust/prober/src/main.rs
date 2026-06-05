//! cdp-prober — M1 の CCoW 側。手元 agent が払い出した quick tunnel URL に GET して
//! 443 到達を確認する (cdp-relay#12 M1)。
//!
//! 使い方:  cargo run -p cdp-prober -- https://<rnd>.trycloudflare.com [/path]
//!
//! 期待: agent の echo server が中継されて `pong from cdp-agent` が返る。
//! これで「CCoW egress(443 only) → cf edge → 手元 cloudflared → agent」の往復が立証される。

use std::time::Duration;

fn main() {
    let mut args = std::env::args().skip(1);
    let base = match args.next() {
        Some(b) => b,
        None => {
            eprintln!("usage: cdp-prober <tunnel_url> [path]   (default path: /ping)");
            std::process::exit(2);
        }
    };
    let path = args.next().unwrap_or_else(|| "/ping".into());
    let url = format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    eprintln!("[cdp-prober] GET {url}");

    // native-tls = OS のシステム CA を使う。CCoW egress gateway の MITM CA は
    // システム store にだけ在るため、これが無いと UnknownIssuer で弾かれる (#12 M1)。
    let agent = ureq::builder()
        .tls_connector(std::sync::Arc::new(
            native_tls::TlsConnector::new().expect("native-tls init"),
        ))
        .timeout(Duration::from_secs(15))
        .build();

    match agent.get(&url).call() {
        Ok(resp) => {
            println!("status: {}", resp.status());
            println!("body:\n{}", resp.into_string().unwrap_or_default());
        }
        Err(ureq::Error::Status(code, resp)) => {
            // 5xx (例: 1033/530 = tunnel down) もここに来る。到達はしている。
            println!("status: {code}");
            println!("body:\n{}", resp.into_string().unwrap_or_default());
        }
        Err(e) => {
            eprintln!("[cdp-prober] transport error (到達失敗の可能性): {e}");
            std::process::exit(1);
        }
    }
}
