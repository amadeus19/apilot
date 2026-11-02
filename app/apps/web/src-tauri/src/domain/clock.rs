//! Rust 侧 UTC RFC3339 时间戳单点（仅展示用途，精度秒）。
//!
//! SQL 侧落库时间戳统一由 SQLite `strftime` 生成（单时钟源纪律）；进程
//! 内存态时间戳（探测完成时刻等，不落库）经本模块生成，格式与 SQL 侧
//! 对齐为 UTC RFC3339。不引入 chrono / time 依赖（技术白名单护栏）。

/// 当前时刻 RFC3339 UTC（秒精度，如 `2026-10-13T06:12:34Z`）。
pub fn now_rfc3339() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map(|secs| {
            let days = secs / 86_400;
            let (year, month, day) = civil_from_days(days as i64);
            let rem = secs % 86_400;
            format!(
                "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
                rem / 3600,
                (rem % 3600) / 60,
                rem % 60
            )
        })
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// 天数→公历年月日（Howard Hinnant 算法，无时区、纯 UTC）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_known_date() {
        // 2026-10-05 对应 Unix 天数 20731（Python datetime 对账）
        assert_eq!(civil_from_days(20_731), (2026, 10, 5));
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }

    #[test]
    fn now_rfc3339_shape_is_utc() {
        let now = now_rfc3339();
        assert_eq!(now.len(), 20);
        assert!(now.ends_with('Z'));
        assert_eq!(&now[4..5], "-");
        assert_eq!(&now[7..8], "-");
        assert_eq!(&now[10..11], "T");
        assert_eq!(&now[13..14], ":");
        assert_eq!(&now[16..17], ":");
    }
}
