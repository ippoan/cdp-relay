//! agent 内蔵 self-update (cdp-relay#12 M6)。
//!
//! 起動時に GitHub Releases を見て `cdp-agent-dev-N` の最新を解決し、自分より新しければ
//! Windows zip asset を DL → 中の `cdp-agent.exe` を取り出して self_replace で差し替える
//! (実行中プロセスは旧版のまま、次回起動で新版が反映される)。
//!
//! version 比較 / asset 選択 / release JSON 解釈の純ロジックは CCoW で unit test する。
//! 実 DL / 置換は Windows 手元でのみ動く (CCoW では走らせない)。
//!
//! REST レート (anonymous 60/hr) は手元 1 人なら起動毎チェックで十分収まる。tag は
//! build.rs が埋め込む CDP_AGENT_RELEASE_TAG。ローカル dev ビルド (tag 無し) は自動更新
//! しない (= 開発中の自分を上書きしない)。

use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

const RELEASES_API: &str = "https://api.github.com/repos/ippoan/cdp-relay/releases?per_page=100";
const TAG_PREFIX: &str = "cdp-agent-dev-";
const WIN_ASSET_MARK: &str = "x86_64-pc-windows-msvc";

/// build.rs が埋め込んだ現在のリリース tag。ローカル dev ビルドでは None。
pub fn current_release_tag() -> Option<&'static str> {
    option_env!("CDP_AGENT_RELEASE_TAG")
}

/// `cdp-agent-dev-7` → 7。prefix 不一致や非数値は None。
fn dev_counter(tag: &str) -> Option<u64> {
    tag.strip_prefix(TAG_PREFIX)?.parse().ok()
}

/// 更新候補。
#[derive(Debug, PartialEq, Eq)]
pub struct Candidate {
    pub tag: String,
    pub asset_url: String,
}

/// releases JSON (api の配列) から「current より新しい最大 dev-N + その Windows zip asset」を選ぶ。
/// current が None (dev ビルド) なら更新しない。Windows asset が無い release は飛ばす。
pub fn pick_newer(current: Option<&str>, releases: &Value) -> Option<Candidate> {
    let current_n = dev_counter(current?)?; // dev ビルドや解釈不能は更新しない
    let arr = releases.as_array()?;

    let mut best: Option<(u64, Candidate)> = None;
    for rel in arr {
        let tag = rel.get("tag_name").and_then(Value::as_str).unwrap_or("");
        let Some(n) = dev_counter(tag) else { continue };
        if n <= current_n {
            continue;
        }
        let Some(asset_url) = pick_windows_asset(rel) else {
            continue;
        };
        let better = match &best {
            Some((bn, _)) => n > *bn,
            None => true,
        };
        if better {
            best = Some((
                n,
                Candidate {
                    tag: tag.to_string(),
                    asset_url,
                },
            ));
        }
    }
    best.map(|(_, c)| c)
}

/// release の assets から Windows msvc zip の browser_download_url を拾う。
fn pick_windows_asset(release: &Value) -> Option<String> {
    let assets = release.get("assets")?.as_array()?;
    for a in assets {
        let name = a.get("name").and_then(Value::as_str).unwrap_or("");
        if name.contains(WIN_ASSET_MARK) && name.ends_with(".zip") {
            return a
                .get("browser_download_url")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
        }
    }
    None
}

fn build_agent() -> ureq::Agent {
    ureq::builder()
        .tls_connector(Arc::new(
            native_tls::TlsConnector::new().expect("native-tls init"),
        ))
        .timeout(Duration::from_secs(30))
        .build()
}

/// 起動時チェック本体。新版があれば DL + 差し替えし、適用した tag を返す。
/// 更新不要 / dev ビルド / 取得失敗は Ok(None) or Err (呼び出し側で log するだけ)。
pub fn check_and_self_update() -> Result<Option<String>, String> {
    let Some(current) = current_release_tag() else {
        return Ok(None); // dev ビルドは自動更新しない
    };
    let agent = build_agent();
    let body = agent
        .get(RELEASES_API)
        .set("User-Agent", "cdp-agent-self-update")
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("releases 取得失敗: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let releases: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;

    let Some(cand) = pick_newer(Some(current), &releases) else {
        return Ok(None); // 最新
    };
    download_and_replace(&agent, &cand.asset_url)?;
    Ok(Some(cand.tag))
}

/// zip asset を DL → 中の cdp-agent.exe を temp に取り出して self_replace で現 exe を差し替える。
fn download_and_replace(agent: &ureq::Agent, url: &str) -> Result<(), String> {
    let resp = agent
        .get(url)
        .set("User-Agent", "cdp-agent-self-update")
        .call()
        .map_err(|e| format!("asset DL 失敗: {e}"))?;
    let mut bytes: Vec<u8> = Vec::new();
    std::io::copy(&mut resp.into_reader(), &mut bytes).map_err(|e| e.to_string())?;

    let reader = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| format!("zip 展開失敗: {e}"))?;

    // zip 内の cdp-agent.exe を探す。
    let mut exe_index = None;
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name();
        if name.ends_with("cdp-agent.exe") || name.ends_with("cdp-agent") {
            exe_index = Some(i);
            break;
        }
    }
    let idx = exe_index.ok_or_else(|| "zip 内に cdp-agent.exe が無い".to_string())?;

    let tmp = std::env::temp_dir().join("cdp-agent-update.tmp");
    {
        let mut entry = zip.by_index(idx).map_err(|e| e.to_string())?;
        let mut out = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    self_replace::self_replace(&tmp).map_err(|e| format!("self_replace 失敗: {e}"))?;
    let _ = std::fs::remove_file(&tmp);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dev_counter_parses_and_rejects() {
        assert_eq!(dev_counter("cdp-agent-dev-7"), Some(7));
        assert_eq!(dev_counter("cdp-agent-dev-0"), Some(0));
        assert_eq!(dev_counter("cdp-agent-v1.2.3"), None);
        assert_eq!(dev_counter("dev"), None);
        assert_eq!(dev_counter("cdp-agent-dev-x"), None);
    }

    fn rel(tag: &str, asset: Option<&str>) -> Value {
        let assets = match asset {
            Some(name) => json!([{
                "name": name,
                "browser_download_url": format!("https://example.com/{name}")
            }]),
            None => json!([]),
        };
        json!({ "tag_name": tag, "assets": assets })
    }

    #[test]
    fn pick_newer_returns_highest_with_windows_asset() {
        let releases = json!([
            rel(
                "cdp-agent-dev-5",
                Some("cdp-agent-dev-5-x86_64-pc-windows-msvc.zip")
            ),
            rel(
                "cdp-agent-dev-7",
                Some("cdp-agent-dev-7-x86_64-pc-windows-msvc.zip")
            ),
            rel(
                "cdp-agent-dev-6",
                Some("cdp-agent-dev-6-x86_64-pc-windows-msvc.zip")
            ),
        ]);
        let c = pick_newer(Some("cdp-agent-dev-5"), &releases).unwrap();
        assert_eq!(c.tag, "cdp-agent-dev-7");
        assert!(c.asset_url.ends_with("dev-7-x86_64-pc-windows-msvc.zip"));
    }

    #[test]
    fn pick_newer_none_when_up_to_date() {
        let releases = json!([rel(
            "cdp-agent-dev-7",
            Some("cdp-agent-dev-7-x86_64-pc-windows-msvc.zip")
        )]);
        assert!(pick_newer(Some("cdp-agent-dev-7"), &releases).is_none());
        // 自分より古いだけ
        assert!(pick_newer(Some("cdp-agent-dev-9"), &releases).is_none());
    }

    #[test]
    fn pick_newer_skips_release_without_windows_asset() {
        let releases = json!([
            rel(
                "cdp-agent-dev-8",
                Some("cdp-agent-dev-8-x86_64-unknown-linux-gnu.tar.gz")
            ),
            rel(
                "cdp-agent-dev-7",
                Some("cdp-agent-dev-7-x86_64-pc-windows-msvc.zip")
            ),
        ]);
        // dev-8 は linux only なので飛ばし、dev-7 を選ぶ。
        let c = pick_newer(Some("cdp-agent-dev-6"), &releases).unwrap();
        assert_eq!(c.tag, "cdp-agent-dev-7");
    }

    #[test]
    fn pick_newer_none_for_dev_build() {
        let releases = json!([rel(
            "cdp-agent-dev-7",
            Some("cdp-agent-dev-7-x86_64-pc-windows-msvc.zip")
        )]);
        // current None (ローカル dev) は自動更新しない。
        assert!(pick_newer(None, &releases).is_none());
    }

    #[test]
    fn pick_windows_asset_prefers_zip_msvc() {
        let r = json!({
            "assets": [
                { "name": "cdp-agent-dev-7-x86_64-unknown-linux-gnu.tar.gz", "browser_download_url": "u1" },
                { "name": "cdp-agent-dev-7-x86_64-pc-windows-msvc.zip", "browser_download_url": "u2" }
            ]
        });
        assert_eq!(pick_windows_asset(&r).as_deref(), Some("u2"));
    }
}
