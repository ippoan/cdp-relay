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
use std::io::Read as _;
use std::sync::Arc;
use std::time::Duration;

const RELEASES_API: &str = "https://api.github.com/repos/ippoan/cdp-relay/releases?per_page=100";
const TAG_PREFIX: &str = "cdp-agent-dev-";
const WIN_ASSET_MARK: &str = "x86_64-pc-windows-msvc";

/// asset DL を許可する host (GitHub Releases とその CDN のみ)。asset_url は
/// `ippoan/cdp-relay` の releases API (TLS, host 固定) が返すものだが、SSRF / 偽 host
/// への redirect を防ぐ defense-in-depth として host を pin する。
const ASSET_HOST_ALLOWLIST: &[&str] = &["github.com", "objects.githubusercontent.com"];
/// DL / 展開のサイズ上限 (zip bomb / 無制限 DL 対策)。実 release zip より十分大きい。
const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;
/// detached 署名 (`.minisig`) の DL サイズ上限。minisign の .minisig は数百 byte なので
/// 十分すぎる小さい cap を被せる (誤った巨大 body の掴み込み防止)。
const MAX_SIG_BYTES: u64 = 16 * 1024;

/// self-update asset の検証に使う minisign 公開鍵 (base64 1 行)。
///
/// 対応する秘密鍵は CI の GitHub Actions secret `MINISIGN_SECRET_KEY` に `secret-inject`
/// 経由で投入され、release workflow が各 Windows zip を署名して `.zip.minisig` を Release に
/// 添付する。公開鍵は秘密ではないのでここに hard-code してよい (= GitHub アカウント /
/// トークン侵害で偽 asset が release に乗っても、この鍵で署名できなければ self_replace に
/// 進まない、という supply-chain 防御層、#20)。
const MINISIGN_PUBLIC_KEY: &str = "RWSasFZdc3W2IqbOY7FEsZ7MIhwqiFzs+0vpdtEZ2KqrZOUzl+YOEZ9W";

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

/// asset URL を https + host allowlist で検証する (SSRF / 偽 host への置換を防ぐ)。
fn validate_asset_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("asset url parse: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("asset url must be https".into());
    }
    match parsed.host_str() {
        Some(h) if ASSET_HOST_ALLOWLIST.contains(&h) => Ok(()),
        Some(h) => Err(format!("asset host not allowed: {h}")),
        None => Err("asset url has no host".into()),
    }
}

/// detached minisign 署名 (`.minisig` の中身) で `data` を検証する純ロジック。
/// 公開鍵は `MINISIGN_PUBLIC_KEY` 固定。検証失敗 (署名不一致 / 別鍵 / 壊れた署名) は Err。
///
/// minisign 0.11+ の prehashed 署名を想定するので legacy (`allow_legacy=false`)。
fn verify_minisign(data: &[u8], minisig: &str) -> Result<(), String> {
    let pk = minisign_verify::PublicKey::from_base64(MINISIGN_PUBLIC_KEY)
        .map_err(|e| format!("公開鍵 parse 失敗: {e}"))?;
    let sig = minisign_verify::Signature::decode(minisig)
        .map_err(|e| format!("署名 decode 失敗: {e}"))?;
    pk.verify(data, &sig, false)
        .map_err(|e| format!("署名検証失敗: {e}"))
}

/// asset (`url`) に対応する `{url}.minisig` を DL して `data` を検証する。
/// host allowlist / https / サイズ cap は asset 本体と同じガードを通す。
fn verify_asset_signature(agent: &ureq::Agent, asset_url: &str, data: &[u8]) -> Result<(), String> {
    let sig_url = format!("{asset_url}.minisig");
    validate_asset_url(&sig_url)?;
    let resp = agent
        .get(&sig_url)
        .set("User-Agent", "cdp-agent-self-update")
        .call()
        .map_err(|e| format!(".minisig DL 失敗 (署名未添付の release か): {e}"))?;
    let mut sig_bytes: Vec<u8> = Vec::new();
    resp.into_reader()
        .take(MAX_SIG_BYTES + 1)
        .read_to_end(&mut sig_bytes)
        .map_err(|e| e.to_string())?;
    if sig_bytes.len() as u64 > MAX_SIG_BYTES {
        return Err(".minisig が上限サイズを超過".into());
    }
    let sig_text = String::from_utf8(sig_bytes).map_err(|e| format!(".minisig が非 UTF-8: {e}"))?;
    verify_minisign(data, &sig_text)
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
    validate_asset_url(url)?;
    let resp = agent
        .get(url)
        .set("User-Agent", "cdp-agent-self-update")
        .call()
        .map_err(|e| format!("asset DL 失敗: {e}"))?;
    // zip bomb / 無制限 DL 対策で上限を被せる。上限到達は truncate せず reject。
    let mut bytes: Vec<u8> = Vec::new();
    resp.into_reader()
        .take(MAX_ASSET_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        return Err("asset が上限サイズを超過".into());
    }

    // 中身を一切触る前に minisign 署名を検証する。検証に通らない asset は zip を開かず破棄
    // (= GitHub アカウント / トークン侵害で偽 asset が乗っても self_replace に進まない、#20)。
    verify_asset_signature(agent, url, &bytes)?;

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
        let entry = zip.by_index(idx).map_err(|e| e.to_string())?;
        let mut out = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        // 展開も上限で cap (zip bomb 対策)。
        let written = std::io::copy(&mut entry.take(MAX_ASSET_BYTES + 1), &mut out)
            .map_err(|e| e.to_string())?;
        if written > MAX_ASSET_BYTES {
            let _ = std::fs::remove_file(&tmp);
            return Err("展開後サイズが上限超過".into());
        }
    }
    self_replace::self_replace(&tmp).map_err(|e| format!("self_replace 失敗: {e}"))?;
    let _ = std::fs::remove_file(&tmp);
    Ok(())
}

// ─── 拡張 (unpacked) の自動更新 ─────────────────────────────────────────────
//
// unpacked 拡張は Chrome が自動更新しない。そこで agent が GitHub の最新拡張 zip を
// install dir の extension\ に上書きし、Chrome 起動/再起動時に新版を読ませる
// (= 実質自動更新)。即時反映は別途 (拡張へ reload 通知) で拡張できる。

/// 拡張 zip asset の名前 prefix (release.yml が `cdp-relay-extension-v*.zip` で出す)。
const EXT_ASSET_PREFIX: &str = "cdp-relay-extension-";

/// releases から最新の拡張 zip asset を選ぶ (releases は新しい順なので最初の一致)。
pub fn pick_latest_extension(releases: &Value) -> Option<(String, String)> {
    for rel in releases.as_array()? {
        let tag = rel
            .get("tag_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let assets = match rel.get("assets").and_then(Value::as_array) {
            Some(a) => a,
            None => continue,
        };
        for a in assets {
            let name = a.get("name").and_then(Value::as_str).unwrap_or("");
            if name.starts_with(EXT_ASSET_PREFIX) && name.ends_with(".zip") {
                if let Some(url) = a.get("browser_download_url").and_then(Value::as_str) {
                    return Some((tag, url.to_string()));
                }
            }
        }
    }
    None
}

/// install dir の extension\ を最新拡張 zip で更新する。前回 tag は .ext-version に記録。
/// extension\ が無い (dev / 手動 exe) なら何もしない。
pub fn update_extension() -> Result<Option<String>, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let ext_dir = exe
        .parent()
        .ok_or_else(|| "exe parent 不明".to_string())?
        .join("extension");
    if !ext_dir.is_dir() {
        return Ok(None); // MSI 同梱拡張が無い
    }
    let marker = ext_dir.join(".ext-version");
    let current = std::fs::read_to_string(&marker).unwrap_or_default();
    let current = current.trim();

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

    let Some((tag, url)) = pick_latest_extension(&releases) else {
        return Ok(None);
    };
    if !current.is_empty() && tag == current {
        return Ok(None); // 最新
    }
    download_extension(&agent, &url, &ext_dir)?;
    let _ = std::fs::write(&marker, &tag);
    Ok(Some(tag))
}

/// 拡張 zip を DL して ext_dir に展開する (flat 構成のみ、path traversal は弾く)。
fn download_extension(
    agent: &ureq::Agent,
    url: &str,
    ext_dir: &std::path::Path,
) -> Result<(), String> {
    validate_asset_url(url)?;
    let resp = agent
        .get(url)
        .set("User-Agent", "cdp-agent-self-update")
        .call()
        .map_err(|e| format!("ext asset DL 失敗: {e}"))?;
    let mut bytes: Vec<u8> = Vec::new();
    resp.into_reader()
        .take(MAX_ASSET_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        return Err("ext asset が上限サイズを超過".into());
    }
    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("ext zip: {e}"))?;
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        // 拡張は flat (manifest.json 等)。サブディレクトリ / traversal は弾く。
        if name.is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') {
            continue;
        }
        let out_path = ext_dir.join(&name);
        let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry.take(MAX_ASSET_BYTES + 1), &mut out).map_err(|e| e.to_string())?;
    }
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
    fn validate_asset_url_allows_github_https() {
        assert!(validate_asset_url(
            "https://github.com/ippoan/cdp-relay/releases/download/cdp-agent-dev-7/x.zip"
        )
        .is_ok());
        assert!(validate_asset_url("https://objects.githubusercontent.com/abc/def").is_ok());
    }

    #[test]
    fn validate_asset_url_rejects_bad_host_and_scheme() {
        assert!(validate_asset_url("https://evil.example.com/x.zip").is_err());
        assert!(validate_asset_url("http://github.com/x.zip").is_err());
        assert!(validate_asset_url("not-a-url").is_err());
    }

    #[test]
    fn pick_latest_extension_finds_first_extension_zip() {
        let releases = json!([
            // 新しい順。最初に拡張 zip を持つ release を採用。
            { "tag_name": "cdp-agent-dev-9", "assets": [
                { "name": "cdp-agent-0.0.9-x86_64.msi", "browser_download_url": "u-msi" }
            ]},
            { "tag_name": "v0.1.2-dev", "assets": [
                { "name": "cdp-relay-extension-v0.1.2-dev.zip", "browser_download_url": "u-ext2" },
                { "name": "cdp-relay-extension-v0.1.2-dev.zip.sha256", "browser_download_url": "u-sha" }
            ]},
            { "tag_name": "v0.1.1-dev", "assets": [
                { "name": "cdp-relay-extension-v0.1.1-dev.zip", "browser_download_url": "u-ext1" }
            ]},
        ]);
        let (tag, url) = pick_latest_extension(&releases).unwrap();
        assert_eq!(tag, "v0.1.2-dev");
        assert_eq!(url, "u-ext2");
    }

    #[test]
    fn pick_latest_extension_none_when_no_extension_asset() {
        let releases = json!([
            { "tag_name": "cdp-agent-dev-9", "assets": [
                { "name": "cdp-agent-0.0.9-x86_64.msi", "browser_download_url": "u" }
            ]}
        ]);
        assert!(pick_latest_extension(&releases).is_none());
    }

    // minisign 署名検証のテストベクタ。`MINISIGN_PUBLIC_KEY` (本番鍵) とは別の使い捨て
    // テスト鍵で `TEST_PAYLOAD` を署名したもの。検証ロジックの形式互換 (prehashed,
    // legacy=false) を pin する。本番鍵の秘密鍵はリポジトリに無いので、テストでは
    // verify_minisign を一時的にテスト公開鍵で呼ぶ薄いヘルパ verify_with を使う。
    const TEST_PUBKEY: &str = "RWRvjwoiICZRffaMjCQLUgyCCLC972LhEQ1qDtjOzP8sEfqedBsyXUdH";
    const TEST_PAYLOAD: &[u8] = b"hello cdp-relay update";
    const TEST_MINISIG: &str = "untrusted comment: signature from minisign secret key\n\
RURvjwoiICZRfSGB5ZsAjWbmSyQFG+XsEAKhOhSNkwbZpq94YLn01gDiYRu7AYVbQjUJlNrPtrJWUZp3wwHdMNClyLKcNDxo7ws=\n\
trusted comment: timestamp:1780898107\tfile:payload.bin\thashed\n\
8wdBFxYcFci3jgloi3NU3FJr0APX5vPf65SZs8RMJGa4qWsrUNH9l0f1tb7qFiRzPo0vu0QX/I2jHf4vONJsDw==\n";

    /// テスト用: 任意の公開鍵で検証する (verify_minisign は本番鍵固定なので、テスト鍵を
    /// 使うためのヘルパ。本番ロジックと同じ呼び出し形 (prehashed, legacy=false) を保つ)。
    fn verify_with(pubkey: &str, data: &[u8], minisig: &str) -> Result<(), String> {
        let pk = minisign_verify::PublicKey::from_base64(pubkey)
            .map_err(|e| format!("公開鍵 parse 失敗: {e}"))?;
        let sig = minisign_verify::Signature::decode(minisig)
            .map_err(|e| format!("署名 decode 失敗: {e}"))?;
        pk.verify(data, &sig, false)
            .map_err(|e| format!("署名検証失敗: {e}"))
    }

    #[test]
    fn verify_minisign_accepts_valid_signature() {
        assert!(verify_with(TEST_PUBKEY, TEST_PAYLOAD, TEST_MINISIG).is_ok());
    }

    #[test]
    fn verify_minisign_rejects_tampered_data() {
        // 1 byte でも変われば検証は失敗する。
        let mut tampered = TEST_PAYLOAD.to_vec();
        tampered[0] ^= 0x01;
        assert!(verify_with(TEST_PUBKEY, &tampered, TEST_MINISIG).is_err());
    }

    #[test]
    fn verify_minisign_rejects_wrong_public_key() {
        // 本番鍵 (別鍵) では テスト署名は通らない = 偽 asset を弾けることの証明。
        assert!(verify_with(MINISIGN_PUBLIC_KEY, TEST_PAYLOAD, TEST_MINISIG).is_err());
    }

    #[test]
    fn verify_minisign_rejects_malformed_signature() {
        assert!(verify_with(TEST_PUBKEY, TEST_PAYLOAD, "not a minisig").is_err());
    }

    #[test]
    fn production_public_key_is_valid() {
        // hard-code した本番公開鍵が parse 可能であること (typo 検出)。
        assert!(minisign_verify::PublicKey::from_base64(MINISIGN_PUBLIC_KEY).is_ok());
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
