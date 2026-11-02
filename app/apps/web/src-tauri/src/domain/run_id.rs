//! Run Record 与工作流执行的身份：`run_` / `wexec_` + ULID（26 字符，
//! Crockford base32）。
//!
//! 双进程（GUI / CLI）无协调生成：时间戳（48 bit 毫秒）提供可排序性，
//! 随机段（80 bit，取自 uuid v4 的 CSPRNG 字节）避免同毫秒碰撞。
//! 任务键先于落库使用（TaskRegistry 登记），故身份生成必须是纯函数、
//! 不依赖数据库。

/// 生成新执行记录身份：`run_<ULID>`。
pub fn new_run_id() -> String {
    format!("run_{}", ulid_now())
}

/// 生成新工作流执行身份：`wexec_<ULID>`（与 Run Record 同一 ULID 机制，
/// 前缀区分两域——两值域物理不撞，日志与记录按前缀即可辨识归属）。
pub fn new_workflow_execution_id() -> String {
    format!("wexec_{}", ulid_now())
}

/// 当前时刻 ULID（26 字符）。
fn ulid_now() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let uuid = uuid::Uuid::new_v4();
    // 随机段取 uuid 后 10 字节（80 bit）：与时间戳 48 bit 拼成 128 bit 值
    let bytes = uuid.as_bytes();
    let mut random = [0u8; 10];
    random.copy_from_slice(&bytes[6..16]);
    let value: u128 = ((ms as u128) << 80)
        | u128::from_be_bytes({
            let mut full = [0u8; 16];
            full[6..].copy_from_slice(&random);
            full
        });
    crockford_base32(value)
}

/// Crockford base32 编码 128 bit 值为 26 字符（26×5=130 bit，最高位补零）。
const CROCKFORD_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn crockford_base32(mut value: u128) -> String {
    let mut out = [b'0'; 26];
    for slot in out.iter_mut().rev() {
        *slot = CROCKFORD_ALPHABET[(value & 31) as usize];
        value >>= 5;
    }
    String::from_utf8(out.to_vec()).expect("字母表恒为合法 UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_id_shape_is_stable() {
        let id = new_run_id();
        assert!(id.starts_with("run_"));
        assert_eq!(id.len(), 4 + 26);
        // Crockford 字母表（无 I / L / O / U）
        for c in id[4..].chars() {
            assert!(
                c.is_ascii_digit() || "ABCDEFGHJKMNPQRSTVWXYZ".contains(c),
                "非法字符 {c}"
            );
        }
    }

    #[test]
    fn run_ids_are_unique_and_time_sorted() {
        let ids: Vec<String> = (0..200).map(|_| new_run_id()).collect();
        let set: std::collections::HashSet<&String> = ids.iter().collect();
        assert_eq!(set.len(), ids.len(), "同批生成不得重复");
        // 时间可排序＝时间位（前 10 字符）单调不减；同毫秒内随机段不保序（ULID 语义）
        let stamps: Vec<&str> = ids.iter().map(|id| &id[4..14]).collect();
        let mut sorted_stamps = stamps.clone();
        sorted_stamps.sort();
        assert_eq!(sorted_stamps, stamps, "连续生成的 ULID 时间位应保持非降序");
    }
}
