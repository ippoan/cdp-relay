//! ビルド時にリリース tag (例: cdp-agent-dev-7) を binary に埋め込む。self-update が
//! 「自分が今どの版か」を知るために使う。
//!
//! 優先: 明示の CDP_AGENT_RELEASE_TAG > GitHub Actions の GITHUB_REF_NAME。
//! ただし `cdp-agent-` prefix の tag だけ採用する (PR / branch ビルドの GITHUB_REF_NAME
//! が紛れ込まないように)。どちらも無い / prefix 不一致なら埋め込まず、self-update は
//! dev ビルド扱いで自動更新を控える。

fn main() {
    let tag = std::env::var("CDP_AGENT_RELEASE_TAG")
        .ok()
        .or_else(|| std::env::var("GITHUB_REF_NAME").ok())
        .filter(|t| t.starts_with("cdp-agent-"));
    if let Some(tag) = tag {
        if !tag.is_empty() {
            println!("cargo:rustc-env=CDP_AGENT_RELEASE_TAG={tag}");
        }
    }
    println!("cargo:rerun-if-env-changed=CDP_AGENT_RELEASE_TAG");
    println!("cargo:rerun-if-env-changed=GITHUB_REF_NAME");
}
