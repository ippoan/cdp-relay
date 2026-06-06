//! 直近ログの in-memory リングバッファ (#33)。`/health` で返して remote から
//! agent の状況を見られるようにする。`alog!` マクロが eprintln (stderr) と push を兼ねる。

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// 保持する最大行数。
const CAP: usize = 300;

static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 1 行追加する (UNIX 秒 prefix 付き)。上限を超えたら古い行から捨てる。
pub fn push(line: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut b = LOG.lock().unwrap();
    b.push(format!("{ts} {line}"));
    let len = b.len();
    if len > CAP {
        b.drain(0..len - CAP);
    }
}

/// 現在のログ全行のスナップショット。
pub fn snapshot() -> Vec<String> {
    LOG.lock().unwrap().clone()
}

/// stderr に出しつつリングバッファにも残すログマクロ。`eprintln!` の drop-in。
#[macro_export]
macro_rules! alog {
    ($($arg:tt)*) => {{
        let __s = format!($($arg)*);
        eprintln!("{}", __s);
        $crate::logbuf::push(&__s);
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_and_snapshot_roundtrip() {
        push("hello");
        let snap = snapshot();
        assert!(snap.iter().any(|l| l.ends_with(" hello")));
        // prefix は UNIX 秒 (数字)。
        let last = snap.last().unwrap();
        assert!(last
            .split(' ')
            .next()
            .unwrap()
            .chars()
            .all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn caps_at_limit() {
        for i in 0..(CAP + 50) {
            push(&format!("line{i}"));
        }
        assert!(snapshot().len() <= CAP);
    }
}
