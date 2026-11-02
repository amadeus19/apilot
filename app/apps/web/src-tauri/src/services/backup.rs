//! 备份域服务（手动导出 / 恢复）。
//!
//! 导出＝`VACUUM INTO` 产出一致性单库副本 → 副本内清空易失三表 → 打包为
//! 单条目 deflate zip。恢复＝校验（合法 zip / quick_check / schema 版本不
//! 新于当前）→ 暂存库＋标记文件落盘 → 提示重启。
//!
//! 启动替换链两段（由 `init_db` 编排）：
//! - 段一（开库前）：标记存在则校验暂存库（头部魔数＋`PRAGMA quick_check`
//!   深校验）后原子替换主库文件并清理 WAL 伴生；标记不存在时顺手收敛暂存
//!   残留（标记先于暂存消失的孤儿面）。所有失败在此消化为跳过 / 延迟
//!   （错误留痕），绝不阻断启动；
//! - 段二（迁移后）：从旧库 ATTACH 搬回易失三表（旧 schema 备份已随启动
//!   迁移升到当前，两侧同为当前 schema），随后清理旧库与标记。
//!
//! 一次性 IPC 动作，不进 TaskRegistry；路径由前端对话框选定后传入，不落
//! 设置；日志只记路径与字节数，不落备份内容。

use std::io::Read;
use std::path::{Path, PathBuf};

use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};

use crate::constants::{
    BACKUP_MARKER_FILE_NAME, BACKUP_OLD_DB_FILE_NAME, BACKUP_STAGE_FILE_NAME, BACKUP_ZIP_ENTRY_NAME,
};
use crate::error::{AppError, codes};

/// 易失三表：导出副本中清空、恢复后从旧库搬回（易失数据一律不走备份）
const VOLATILE_TABLES: [&str; 3] = ["run_records", "settings", "workspace_sessions"];

/// 导出一致性单库副本为单条目 zip，返回产物字节数（路径调用方已知，不回带）。
pub async fn export(pool: &SqlitePool, target: &Path) -> Result<u64, AppError> {
    // 副本与目标 zip 同目录：打包免跨盘拷贝；命名带进程号与毫秒时间戳，
    // 防并发导出残留互撞
    let target_dir = target
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| {
            AppError::new(
                codes::INVALID_ARGUMENT,
                format!(
                    "backup target has no parent directory: {}",
                    target.display()
                ),
            )
        })?;
    let copy_path = target_dir.join(format!(
        "apilot-backup-staging-{}-{}.sqlite",
        std::process::id(),
        unix_ms(),
    ));
    // VACUUM INTO 要求目标不存在：防御性清掉同形目标（命名含进程号与毫秒
    // 时间戳、与并发的其他导出互不冲突，正常流程不会命中此删除；历史中断
    // 的异名残留不做启动期清扫——无法与在途导出区分）
    let _ = std::fs::remove_file(&copy_path);
    sqlx::query("VACUUM INTO ?")
        .bind(copy_path.to_string_lossy().into_owned())
        .execute(pool)
        .await
        .map_err(|err| {
            AppError::new(
                codes::BACKUP_EXPORT_WRITE_FAILED,
                format!("vacuum into {} failed: {err}", copy_path.display()),
            )
        })?;

    // 副本内清空易失三表（裸连接：VACUUM 产物为非 WAL 库，打开不产生伴生文件）
    let copy_pool = open_plain(&copy_path).await.map_err(|err| {
        // 打开失败即放弃：清掉 staging 副本再报，不留孤儿文件
        let _ = std::fs::remove_file(&copy_path);
        AppError::new(
            codes::BACKUP_EXPORT_WRITE_FAILED,
            format!(
                "opened copy at {} is unreadable: {err}",
                copy_path.display()
            ),
        )
    })?;
    let scrubbed = async {
        for table in VOLATILE_TABLES {
            // 表名来自编译期白名单常量，无注入面
            let sql = format!("DELETE FROM {table}");
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&copy_pool)
                .await?;
        }
        Ok::<(), AppError>(())
    }
    .await;
    copy_pool.close().await;
    scrubbed.map_err(|err| {
        let _ = std::fs::remove_file(&copy_path);
        AppError::new(
            codes::BACKUP_EXPORT_WRITE_FAILED,
            format!("backup copy scrub failed: {err}"),
        )
    })?;

    // 打包为单条目 deflate zip（同步文件 IO 放阻塞线程，不卡执行器）
    let pack_source = copy_path.clone();
    let pack_target = target.to_path_buf();
    let packed = tokio::task::spawn_blocking(move || {
        pack_zip(&pack_source, BACKUP_ZIP_ENTRY_NAME, &pack_target)
    })
    .await
    .map_err(|err| {
        // 打包任务 panic 即整体失败：清掉 staging 副本再报
        let _ = std::fs::remove_file(&copy_path);
        AppError::internal(format!("backup zip task panicked: {err}"))
    })?;
    let _ = std::fs::remove_file(&copy_path);
    let size_bytes = packed?;
    tracing::info!(target = %target.display(), size_bytes, "backup exported");
    Ok(size_bytes)
}

/// 恢复预检：校验所选备份包（合法 zip / quick_check / schema 版本不新于
/// 当前），无任何持久副作用——校验用解包临时文件即验即清，不触碰暂存与
/// 标记。两段式确认的前段：用户确认后才由 [`restore`] 落盘执行。
pub async fn validate(zip_path: &Path, work_dir: &Path) -> Result<(), AppError> {
    // 探针文件与暂存同名域隔离（带进程号与毫秒时间戳防并发互撞），失败
    // 残留先清——与 restore 的暂存面收敛同口径，连伴生一并清
    let probe = work_dir.join(format!(
        "apilot-backup-probe-{}-{}.sqlite",
        std::process::id(),
        unix_ms(),
    ));
    remove_staged_with_companions(&probe);
    let unpack_source = zip_path.to_path_buf();
    let unpack_target = probe.clone();
    let unpacked =
        tokio::task::spawn_blocking(move || unpack_db_from_zip(&unpack_source, &unpack_target))
            .await
            .map_err(|err| AppError::internal(format!("backup unpack task panicked: {err}")))
            .and_then(|unpacked| unpacked);
    let outcome = async {
        unpacked?;
        validate_staged_db(&probe).await
    }
    .await;
    // 校验连接若为 WAL 头库可能留下 -wal / -shm 伴生，随探针一并收敛
    remove_staged_with_companions(&probe);
    outcome
}

/// 恢复受理：校验所选备份包，通过后写暂存库与标记文件（重启后由启动
/// 序列替换生效）。校验失败不留任何半成品（暂存即写即清）。
pub async fn restore(zip_path: &Path, app_data_dir: &Path) -> Result<(), AppError> {
    let staged = app_data_dir.join(BACKUP_STAGE_FILE_NAME);
    let unpack_source = zip_path.to_path_buf();
    let unpack_target = staged.clone();
    tokio::task::spawn_blocking(move || unpack_db_from_zip(&unpack_source, &unpack_target))
        .await
        .map_err(|err| AppError::internal(format!("backup unpack task panicked: {err}")))?
        .inspect_err(|_| {
            remove_staged_with_companions(&staged);
        })?;

    if let Err(err) = validate_staged_db(&staged).await {
        remove_staged_with_companions(&staged);
        return Err(err);
    }

    // 标记存在性即语义；内容只留诊断线索（写哪些字节不影响替换链判定）
    let marker = app_data_dir.join(BACKUP_MARKER_FILE_NAME);
    if let Err(err) = std::fs::write(&marker, format!("staged_at_ms={}", unix_ms())) {
        // 标记写失败＝重启替换链不会触发，暂存将成为启动链不可达的孤儿：
        // 先清暂存再报错，受理整体回到「未生效」态，可重试
        remove_staged_with_companions(&staged);
        return Err(AppError::new(
            codes::BACKUP_RESTORE_WRITE_FAILED,
            format!(
                "writing backup marker at {} failed: {err}",
                marker.display()
            ),
        ));
    }
    tracing::info!(source = %zip_path.display(), "backup staged; takes effect after restart");
    Ok(())
}

/// 段一处置结果：失败被消化为跳过 / 延迟，不阻断启动。
#[derive(Debug)]
pub(crate) enum PendingRestore {
    /// 无待恢复
    None,
    /// 主库已是备份库，旧库待段二搬回
    Applied,
    /// 永久性失败：标记已清理收敛（下次启动不再重试），原库未动
    Skipped(AppError),
    /// 暂时性失败：标记与暂存保留，下次启动重试
    Deferred(AppError),
}

/// 段一（开库前）：标记存在则校验并执行替换。头部魔数秒判挡掉整文件级
/// 损坏，`PRAGMA quick_check` 深校验挡掉头部之后的深层损坏——两道都过才
/// 允许替换主库，否则启动期 quick_check 将反复硬失败。
pub(crate) async fn apply_pending_before_open(app_data_dir: &Path) -> PendingRestore {
    let marker = app_data_dir.join(BACKUP_MARKER_FILE_NAME);
    let staged = app_data_dir.join(BACKUP_STAGE_FILE_NAME);
    if !marker.exists() {
        // 无标记＝无待恢复；标记先于暂存消失的孤儿暂存（受理失败收尾中断
        // 等）在此收敛——暂存连同伴生一并清理，兑现常量注释承诺的启动收敛
        remove_staged_with_companions(&staged);
        return PendingRestore::None;
    }
    let old = app_data_dir.join(BACKUP_OLD_DB_FILE_NAME);
    if staged.exists() {
        // 暂存损坏（头部非法或深层页面损坏）＝永久性故障：清理收敛、安全
        // 跳过，原库未动（错误留痕由编排层统一执行，见 init_db）
        if !has_sqlite_header(&staged) {
            let err = AppError::new(
                codes::BACKUP_INVALID_DB,
                "staged backup file is corrupt; pending restore skipped",
            );
            remove_staged_with_companions(&staged);
            let _ = std::fs::remove_file(&marker);
            return PendingRestore::Skipped(err);
        }
        if let Err(err) = staged_deep_check(&staged).await {
            remove_staged_with_companions(&staged);
            let _ = std::fs::remove_file(&marker);
            return PendingRestore::Skipped(err);
        }
        match replace_main_db(app_data_dir, &staged, &old) {
            Ok(()) => {
                tracing::info!(
                    "pending backup restore: main database replaced, volatile carryover pending"
                );
                PendingRestore::Applied
            }
            Err(err) => PendingRestore::Deferred(err),
        }
    } else if old.exists() {
        // 上次启动替换完成、搬回未完成（段二中断）：直接续段二
        tracing::info!(
            "pending backup restore: replacement already done, resuming volatile carryover"
        );
        PendingRestore::Applied
    } else {
        // 孤儿标记（替换与搬回均已完成、只剩收尾中断）：收敛清理
        let _ = std::fs::remove_file(&marker);
        PendingRestore::None
    }
}

/// 段二（迁移后）：从旧库搬回易失三表。旧 schema 备份此时已随启动迁移
/// 升到当前，与主库同构，`SELECT *` 列序一致；`INSERT OR IGNORE` 使中断
/// 重入幂等（上次已搬回的行不重复写入）。完成时清理旧库伴生与标记。
pub(crate) async fn carry_volatile_back(
    pool: &SqlitePool,
    app_data_dir: &Path,
) -> Result<(), AppError> {
    let old = app_data_dir.join(BACKUP_OLD_DB_FILE_NAME);
    // 旧库不存在（全新机器恢复）：搬回为空——易失表保持空、设置回落默认
    if !old.exists() {
        let _ = std::fs::remove_file(app_data_dir.join(BACKUP_MARKER_FILE_NAME));
        tracing::info!(
            "backup restore: no previous database; volatile data falls back to defaults"
        );
        return Ok(());
    }
    sqlx::query("ATTACH DATABASE ? AS backup_old")
        .bind(old.to_string_lossy().into_owned())
        .execute(pool)
        .await
        .map_err(|err| {
            AppError::new(
                codes::DB_QUERY_FAILED,
                format!("attach previous database failed: {err}"),
            )
        })?;
    let carried = async {
        // 关外键搬回：易失行引用的持久域可能不在备份库（如恢复到更早备份
        // 后，恢复前新建工作空间的会话行），孤儿易失行不可达、无 UI 呈现，
        // 不让它阻塞整段搬回。PRAGMA 在事务内是 no-op，须在事务外关 / 开
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(pool)
            .await?;
        let mut tx = pool.begin().await?;
        for table in VOLATILE_TABLES {
            // 表名来自编译期白名单常量，无注入面
            let sql =
                format!("INSERT OR IGNORE INTO main.{table} SELECT * FROM backup_old.{table}");
            let carried = sqlx::query(sqlx::AssertSqlSafe(sql))
                .execute(&mut *tx)
                .await?;
            // INSERT OR IGNORE 会静默吞掉主键冲突行（重入幂等的代价）：搬回
            // 行数与源行数比对，不一致留痕——非重入场景下被忽略的行值得
            // 人工可见（如源库与目标库的键位撞车）
            let source: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "SELECT COUNT(*) FROM backup_old.{table}"
            )))
            .fetch_one(&mut *tx)
            .await?;
            if carried.rows_affected() != source.unsigned_abs() {
                tracing::warn!(
                    table = table,
                    carried = carried.rows_affected(),
                    source = source,
                    "volatile carryover skipped conflicting rows (re-entry or key conflicts)"
                );
            }
        }
        tx.commit().await?;
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(pool)
            .await?;
        Ok::<(), AppError>(())
    }
    .await;
    // 无论成败都摘除别名并恢复连接外键态：连接归还连接池后不得残留
    // ATTACH 态或关闭态的外键约束
    let _ = sqlx::query("DETACH DATABASE backup_old")
        .execute(pool)
        .await;
    if carried.is_err() {
        let _ = sqlx::query("PRAGMA foreign_keys = ON").execute(pool).await;
    }
    carried?;

    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(with_suffix(&old, suffix));
    }
    let _ = std::fs::remove_file(app_data_dir.join(BACKUP_MARKER_FILE_NAME));
    tracing::info!("backup restore: volatile tables carried over, staging cleaned up");
    Ok(())
}

/// 替换主库（旧库让位 → WAL 伴生随迁 → 暂存顶替）。占用（如 CLI 进程持
/// 库）映射 `BACKUP_FILE_LOCKED`，标记保留待下次启动重试；中途失败回滚
/// 让位动作，原库无损。让位前若 old 落点已残留（上次替换后搬回未完成又
/// 受理了新恢复），先整体搬为旁名留档，不让其中易失数据被静默覆盖。
fn replace_main_db(app_data_dir: &Path, staged: &Path, old: &Path) -> Result<(), AppError> {
    let db_path = app_data_dir.join(crate::db::DB_FILE_NAME);
    let db_wal = with_suffix(&db_path, "-wal");
    let db_journal = with_suffix(&db_path, "-journal");
    // -shm 是共享内存索引、无持久数据，可直接删除；-wal 含未 checkpoint 的
    // 已提交事务，必须随旧库落点保留（段二 ATTACH 时热恢复），否则搬回丢数据
    let old_wal = with_suffix(old, "-wal");
    let old_journal = with_suffix(old, "-journal");

    // 1. 主库让位（不存在＝全新机器，直接顶替）
    let had_old = db_path.exists();
    if had_old {
        // 三态并存防御（主库＋暂存＋old 同在）：old 残留＝上次替换后搬回未
        // 完成又受理了新恢复，下面的让位动作会改名盖掉 old——先连同伴生整
        // 体搬到旁名留档（易失数据仍在盘上，供人工恢复），再继续替换
        if old.exists() {
            let sidecar = app_data_dir.join(format!("backup-old-{}.sqlite", unix_ms()));
            // 伴生先行、主文件殿后：中途失败时 old 主文件仍在原位，下次启动
            // 重试整体重搬（旁名已存在会被替换，无累积）
            for suffix in ["-journal", "-wal", ""] {
                let from = with_suffix(old, suffix);
                if from.exists() {
                    std::fs::rename(&from, with_suffix(&sidecar, suffix)).map_err(|err| {
                        classify_replace_error(err, "preserving leftover previous database")
                    })?;
                }
            }
            // -shm 是共享内存索引、无持久数据，直接删除
            let _ = std::fs::remove_file(with_suffix(old, "-shm"));
            tracing::warn!(
                sidecar = %sidecar.display(),
                "leftover previous database found before replace; moved aside for manual recovery"
            );
        }
        std::fs::rename(&db_path, old)
            .map_err(|err| classify_replace_error(err, "retiring current database"))?;
        if db_wal.exists()
            && let Err(err) = std::fs::rename(&db_wal, &old_wal)
        {
            rollback_retire(old, &db_path, &old_wal, &db_wal);
            return Err(classify_replace_error(err, "moving database wal alongside"));
        }
        if db_journal.exists()
            && let Err(err) = std::fs::rename(&db_journal, &old_journal)
        {
            rollback_retire(old, &db_path, &old_wal, &db_wal);
            return Err(classify_replace_error(
                err,
                "moving database journal alongside",
            ));
        }
        let _ = std::fs::remove_file(with_suffix(&db_path, "-shm"));
    }
    // 2. 暂存顶替主库
    if let Err(err) = std::fs::rename(staged, &db_path) {
        rollback_retire(old, &db_path, &old_wal, &db_wal);
        return Err(classify_replace_error(err, "installing staged database"));
    }
    // 3. 清暂存残名伴生（暂存从未以 WAL 打开，防御性清理）
    let _ = std::fs::remove_file(with_suffix(staged, "-wal"));
    let _ = std::fs::remove_file(with_suffix(staged, "-shm"));
    Ok(())
}

/// 让位动作回滚：旧库与其 -wal 还回主库落点，原库无损（-shm 已删无妨，
/// SQLite 打开时自动重建）。回滚自身失败＝主库落点可能空缺、下次启动将建
/// 空库的数据丢失窗口：必须留痕记录数据实际落点（old 路径）供人工恢复。
fn rollback_retire(old: &Path, db_path: &Path, old_wal: &Path, db_wal: &Path) {
    if let Err(err) = std::fs::rename(old, db_path) {
        tracing::error!(
            error = %err,
            old = %old.display(),
            "rollback failed: original database still resides at the old location"
        );
    }
    if old_wal.exists()
        && let Err(err) = std::fs::rename(old_wal, db_wal)
    {
        tracing::error!(
            error = %err,
            old_wal = %old_wal.display(),
            "rollback failed: database wal still resides at the old location"
        );
    }
}

/// 替换期 IO 错误分类：占用（另一进程持库，Windows 上打开中的文件不可
/// rename）→ `BACKUP_FILE_LOCKED`；其余归暂存落盘失败
fn classify_replace_error(err: std::io::Error, step: &'static str) -> AppError {
    if is_file_locked(&err) {
        AppError::new(
            codes::BACKUP_FILE_LOCKED,
            format!(
                "database file is locked by another process while {step}; close other apilot processes and retry"
            ),
        )
    } else {
        AppError::new(
            codes::BACKUP_RESTORE_WRITE_FAILED,
            format!("database replace failed while {step}: {err}"),
        )
    }
}

fn is_file_locked(err: &std::io::Error) -> bool {
    if err.kind() == std::io::ErrorKind::ResourceBusy {
        return true;
    }
    // Windows 占用两态：共享冲突(32) / 锁冲突(33)。拒绝访问(5) 是纯 ACL
    // 权限问题、非进程占用，归落盘失败族——不该指引「关闭其他进程」
    #[cfg(windows)]
    {
        matches!(err.raw_os_error(), Some(32 | 33))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 暂存库深校验（段一）：`PRAGMA quick_check` 通过才放行替换。暂存文件是
/// 普通 SQLite 文件（zip 解包产物，非 zip）；校验用只读连接——不写库页，
/// 非 WAL 头的暂存不产生伴生；头声明 WAL 模式的暂存（外来 zip 装入）可能
/// 留下 `-wal` / `-shm` 伴生，由跳过路径统一收敛。临时连接用后即关。
async fn staged_deep_check(staged: &Path) -> Result<(), AppError> {
    let options = SqliteConnectOptions::new()
        .filename(staged)
        .read_only(true)
        .busy_timeout(std::time::Duration::from_millis(5000));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|err| {
            AppError::new(
                codes::BACKUP_INVALID_DB,
                format!(
                    "staged backup file at {} is not a valid sqlite database: {err}",
                    staged.display()
                ),
            )
        })?;
    let verdict = crate::db::quick_check(&pool).await;
    pool.close().await;
    verdict.map_err(|err| {
        AppError::new(
            codes::BACKUP_INVALID_DB,
            format!(
                "staged backup file at {} is corrupt: {}",
                staged.display(),
                err.message
            ),
        )
    })
}

/// SQLite 文件头快速判定（段一暂存校验的第一道：整文件级损坏秒判，免开
/// 连接；头部之后的深层损坏由 [`staged_deep_check`] 收敛）
fn has_sqlite_header(path: &Path) -> bool {
    let mut magic = [0u8; 16];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .is_ok()
        && magic == *b"SQLite format 3\0"
}

/// zip 内唯一 .sqlite 条目解包为暂存库。非 zip / 条目缺失或多于一个均拒绝。
fn unpack_db_from_zip(zip_path: &Path, staged: &Path) -> Result<(), AppError> {
    let file = std::fs::File::open(zip_path).map_err(|err| {
        AppError::new(
            codes::BACKUP_INVALID_ZIP,
            format!("cannot read backup file at {}: {err}", zip_path.display()),
        )
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|err| {
        AppError::new(
            codes::BACKUP_INVALID_ZIP,
            format!("not a valid zip archive: {err}"),
        )
    })?;
    let mut entries: Vec<usize> = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|err| {
            AppError::new(
                codes::BACKUP_INVALID_ZIP,
                format!("corrupt zip entry: {err}"),
            )
        })?;
        let name = entry.name().map_err(|err| {
            AppError::new(
                codes::BACKUP_INVALID_ZIP,
                format!("corrupt zip entry name: {err}"),
            )
        })?;
        if !entry.is_dir() && name.ends_with(".sqlite") {
            entries.push(index);
        }
    }
    let [only] = entries.as_slice() else {
        return Err(AppError::new(
            codes::BACKUP_INVALID_ZIP,
            format!(
                "expected exactly one .sqlite entry in backup zip, found {}",
                entries.len()
            ),
        ));
    };
    let mut entry = archive.by_index(*only).map_err(|err| {
        AppError::new(
            codes::BACKUP_INVALID_ZIP,
            format!("corrupt zip entry: {err}"),
        )
    })?;
    let mut out = std::fs::File::create(staged).map_err(|err| {
        AppError::new(
            codes::BACKUP_RESTORE_WRITE_FAILED,
            format!("cannot create staged file at {}: {err}", staged.display()),
        )
    })?;
    std::io::copy(&mut entry, &mut out).map_err(|err| {
        AppError::new(
            codes::BACKUP_RESTORE_WRITE_FAILED,
            format!("writing staged database failed: {err}"),
        )
    })?;
    Ok(())
}

/// 暂存库校验：quick_check 通过、迁移登记存在且 max(version) 不超前当前
/// 嵌入迁移（新版备份拒绝，防降级打开）。校验连接非 WAL 打开，不产伴生。
async fn validate_staged_db(staged: &Path) -> Result<(), AppError> {
    let pool = open_plain(staged).await.map_err(|err| {
        // 透传底层 open 失败原因：磁盘 IO 故障与文件损坏在错误信息里可分辨
        AppError::new(
            codes::BACKUP_INVALID_DB,
            format!(
                "staged file at {} is not a valid sqlite database: {}",
                staged.display(),
                err.message
            ),
        )
    })?;
    let outcome = async {
        crate::db::quick_check(&pool)
            .await
            .map_err(|err| AppError::new(codes::BACKUP_INVALID_DB, err.message))?;
        let max_version: Option<i64> = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
            .fetch_one(&pool)
            .await
            .map_err(|err| {
                AppError::new(
                    codes::BACKUP_INVALID_DB,
                    format!("backup has no migration ledger; not an apilot database: {err}"),
                )
            })?;
        let current = embedded_max_version();
        match max_version {
            Some(backup_version) if backup_version > current => Err(AppError::new(
                codes::BACKUP_SCHEMA_NEWER,
                format!("backup schema version {backup_version} is newer than this app supports ({current})"),
            )
            .with_details(serde_json::json!({ "backupVersion": backup_version, "currentVersion": current }))),
            _ => Ok(()),
        }
    }
    .await;
    pool.close().await;
    outcome
}

/// 裸 SQLite 连接（不设 journal_mode、不建缺失文件）：VACUUM 产物 / 暂存
/// 库都是非 WAL 库，裸打开不产生伴生文件
async fn open_plain(path: &Path) -> Result<SqlitePool, AppError> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .busy_timeout(std::time::Duration::from_millis(5000));
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|err| {
            AppError::new(
                codes::DB_OPEN_FAILED,
                format!("failed to open database at {}: {err}", path.display()),
            )
        })
}

/// 把单个 sqlite 文件打包为单条目 zip（默认压缩即 deflate）。半成品产物
/// 有害：失败时清掉目标再报。
fn pack_zip(source_db: &Path, entry_name: &str, target_zip: &Path) -> Result<u64, AppError> {
    let result = (|| -> std::io::Result<u64> {
        let file = std::fs::File::create(target_zip)?;
        let mut writer = zip::ZipWriter::new(file);
        writer.start_file(entry_name, zip::write::SimpleFileOptions::default())?;
        let mut db = std::fs::File::open(source_db)?;
        std::io::copy(&mut db, &mut writer)?;
        writer.finish()?;
        Ok(std::fs::metadata(target_zip)?.len())
    })();
    match result {
        Ok(size) => Ok(size),
        Err(err) => {
            let _ = std::fs::remove_file(target_zip);
            Err(AppError::new(
                codes::BACKUP_EXPORT_WRITE_FAILED,
                format!(
                    "writing backup zip at {} failed: {err}",
                    target_zip.display()
                ),
            ))
        }
    }
}

fn embedded_max_version() -> i64 {
    sqlx::migrate!("./migrations")
        .migrations
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap_or(0)
}

/// 文件路径拼后缀（-wal / -shm / -journal 伴生命名；OsString 拼接，非 UTF-8
/// 路径不损失）
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_os_string();
    os.push(suffix);
    PathBuf::from(os)
}

/// 暂存面收敛：暂存文件连同伴生（-wal / -shm / -journal）一并删除。伴生
/// 只可能来自损坏文件被异常打开的残留（正常暂存从未以 WAL 打开、VACUUM
/// 产物为非 WAL 库），删除不损失任何有效数据。
fn remove_staged_with_companions(staged: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(with_suffix(staged, suffix));
    }
}

fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// 测试专用临时目录（与 db 模块测试同款 stdlib 组合，不引 tempfile）
    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("apilot2-backup-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 建真文件库（全套迁移）并铺持久域＋易失域代表数据
    async fn seeded_db(dir: &Path) -> SqlitePool {
        let pool = crate::db::init_headless(dir).await.unwrap();
        insert_fixture(&pool).await;
        pool
    }

    /// 持久域跨各子域各铺一行＋易失三表各一行
    async fn insert_fixture(pool: &SqlitePool) {
        sqlx::query("INSERT INTO workspaces (id, name, base_url, created_at, updated_at, sort_order) VALUES ('ws-1', '工作空间A', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO services (id, workspace_id, name, doc_url, doc_type, sort_order, created_at, updated_at) VALUES ('svc-1', 'ws-1', '服务A', NULL, 'openapi', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO categories (id, service_id, name, sort_order, created_at) VALUES ('cat-1', 'svc-1', '分类A', 0, '2026-01-01T00:00:00Z')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO endpoints (service_id, key, title, category_id, definition, created_at) VALUES ('svc-1', 'GET /a', '接口A', 'cat-1', '{}', '2026-01-01T00:00:00Z')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO endpoint_user_data (service_id, key, body, params, headers, updated_at) VALUES ('svc-1', 'GET /a', NULL, '{}', '{}', '2026-01-01T00:00:00Z')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO pinned_endpoints (service_id, key) VALUES ('svc-1', 'GET /a')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO variable_categories (id, workspace_id, name, sort_order, created_at) VALUES ('vc-1', 'ws-1', '默认分类', 0, '2026-01-01T00:00:00Z')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO variables (category_id, key, value, secret, sort_order, updated_at) VALUES ('vc-1', 'token', 'secret-value', 1, 0, '2026-01-01T00:00:00Z')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO workspace_base_urls (id, workspace_id, url, created_at) VALUES ('wbu-1', 'ws-1', 'https://example.com', '2026-01-01T00:00:00Z')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO snapshots (service_id, generation, content, sha256, fetched_at) VALUES ('svc-1', 1, '{}', 'abc', '2026-01-01T00:00:00Z')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO run_records (id, workspace_id, service_id, endpoint_key, method, url, status_code, duration_ms, state, error_code, error_message, request_json, response_json, source, created_at) VALUES ('run-1', 'ws-1', 'svc-1', 'GET /a', 'GET', 'https://example.com/a', 200, 12, 'passed', NULL, NULL, '{}', '{}', 'gui', '2026-01-01T00:00:00Z')").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES ('theme', '\"dark\"')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspace_sessions (workspace_id, tabs, tree_expanded, updated_at) VALUES ('ws-1', '[]', '[]', '2026-01-01T00:00:00Z')").execute(pool).await.unwrap();
    }

    async fn count(pool: &SqlitePool, sql: &'static str) -> i64 {
        sqlx::query_scalar::<_, i64>(sql)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    fn marker_path(dir: &Path) -> PathBuf {
        dir.join(BACKUP_MARKER_FILE_NAME)
    }

    fn staged_path(dir: &Path) -> PathBuf {
        dir.join(BACKUP_STAGE_FILE_NAME)
    }

    fn old_path(dir: &Path) -> PathBuf {
        dir.join(BACKUP_OLD_DB_FILE_NAME)
    }

    /// 把 sqlite 文件打成单条目 zip（复用生产打包函数）
    fn zip_db(db: &Path, zip: &Path) {
        pack_zip(db, BACKUP_ZIP_ENTRY_NAME, zip).unwrap();
    }

    /// 构造条目数可控的合成 zip（条目数约束测试用，非备份形态）
    fn write_zip_entries(zip: &Path, entries: &[(&str, &[u8])]) {
        use std::io::Write as _;
        let file = std::fs::File::create(zip).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        for (name, bytes) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    /// tracing fmt 层的 MakeWriter：逐事件整行写入共享缓冲
    #[derive(Clone)]
    struct LinesWriter(Arc<Mutex<Vec<String>>>);

    impl std::io::Write for LinesWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(buf).into_owned());
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// 捕获当前线程的 tracing 事件到内存缓冲（error 留痕断言用）：
    /// `set_default` 线程局部生效，`#[tokio::test]` 单线程运行时下 async
    /// 代码全程在本线程，await 期间发出的事件同样被捕获；守卫随作用域撤销
    fn capture_logs() -> (tracing::subscriber::DefaultGuard, Arc<Mutex<Vec<String>>>) {
        use tracing_subscriber::layer::SubscriberExt as _;
        let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let writer = {
            let lines = lines.clone();
            move || LinesWriter(lines.clone())
        };
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writer),
        );
        let guard = tracing::subscriber::set_default(subscriber);
        (guard, lines)
    }

    #[tokio::test]
    async fn export_zip_holds_single_sqlite_with_scrubbed_volatile_tables() {
        let dir = temp_dir("export-scrub");
        let pool = seeded_db(&dir).await;
        let target = dir.join("out.zip");
        export(&pool, &target).await.unwrap();
        pool.close().await;

        // zip 内恰好一个 .sqlite 条目，条目名锁定常量
        let file = std::fs::File::open(&target).unwrap();
        let archive = zip::ZipArchive::new(file).unwrap();
        assert_eq!(archive.len(), 1);
        let names: Vec<String> = archive
            .file_names()
            .map(|result| result.unwrap().to_string())
            .collect();
        assert_eq!(names, vec![BACKUP_ZIP_ENTRY_NAME.to_string()]);

        // scrub 断言：持久域各表全量、易失三表为空
        let unpacked = dir.join("unpacked.sqlite");
        unpack_db_from_zip(&target, &unpacked).unwrap();
        let copy = open_plain(&unpacked).await.unwrap();
        assert_eq!(count(&copy, "SELECT COUNT(*) FROM workspaces").await, 1);
        assert_eq!(count(&copy, "SELECT COUNT(*) FROM services").await, 1);
        assert_eq!(count(&copy, "SELECT COUNT(*) FROM categories").await, 1);
        assert_eq!(count(&copy, "SELECT COUNT(*) FROM endpoints").await, 1);
        assert_eq!(
            count(&copy, "SELECT COUNT(*) FROM endpoint_user_data").await,
            1
        );
        assert_eq!(
            count(&copy, "SELECT COUNT(*) FROM pinned_endpoints").await,
            1
        );
        assert_eq!(
            count(&copy, "SELECT COUNT(*) FROM variable_categories").await,
            1
        );
        assert_eq!(count(&copy, "SELECT COUNT(*) FROM variables").await, 1);
        assert_eq!(
            count(&copy, "SELECT COUNT(*) FROM workspace_base_urls").await,
            1
        );
        assert_eq!(count(&copy, "SELECT COUNT(*) FROM snapshots").await, 1);
        assert_eq!(count(&copy, "SELECT COUNT(*) FROM run_records").await, 0);
        assert_eq!(count(&copy, "SELECT COUNT(*) FROM settings").await, 0);
        assert_eq!(
            count(&copy, "SELECT COUNT(*) FROM workspace_sessions").await,
            0
        );
        copy.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// VACUUM INTO 语义：导出后源库的后续写入不进入副本（时点一致）
    #[tokio::test]
    async fn export_copy_is_point_in_time_consistent() {
        let dir = temp_dir("export-consistent");
        let pool = seeded_db(&dir).await;
        let target = dir.join("out.zip");
        export(&pool, &target).await.unwrap();
        // 导出后再写：副本不得携带
        sqlx::query("INSERT INTO workspaces (id, name, base_url, created_at, updated_at, sort_order) VALUES ('ws-2', '工作空间B', NULL, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', 1)")
            .execute(&pool).await.unwrap();
        pool.close().await;

        let unpacked = dir.join("unpacked.sqlite");
        unpack_db_from_zip(&target, &unpacked).unwrap();
        let copy = open_plain(&unpacked).await.unwrap();
        assert_eq!(count(&copy, "SELECT COUNT(*) FROM workspaces").await, 1);
        let (name,): (String,) = sqlx::query_as("SELECT name FROM workspaces")
            .fetch_one(&copy)
            .await
            .unwrap();
        assert_eq!(name, "工作空间A");
        copy.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn restore_rejects_invalid_zip() {
        let dir = temp_dir("restore-badzip");
        let bad = dir.join("bad.zip");
        std::fs::write(&bad, b"this is not a zip archive").unwrap();
        let err = restore(&bad, &dir).await.unwrap_err();
        assert_eq!(err.code, codes::BACKUP_INVALID_ZIP);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// zip 合法但内嵌库损坏 → `BACKUP_INVALID_DB`
    #[tokio::test]
    async fn restore_rejects_corrupt_db() {
        let dir = temp_dir("restore-baddb");
        let junk_db = dir.join("junk.sqlite");
        std::fs::write(&junk_db, b"not a sqlite database at all").unwrap();
        let zip = dir.join("junk.zip");
        zip_db(&junk_db, &zip);
        let err = restore(&zip, &dir).await.unwrap_err();
        assert_eq!(err.code, codes::BACKUP_INVALID_DB);
        // 校验失败不留暂存半成品
        assert!(!staged_path(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 备份 schema 版本超前当前嵌入迁移 → 新版备份拒绝
    #[tokio::test]
    async fn restore_rejects_newer_schema() {
        let dir = temp_dir("restore-newer");
        let source_dir = temp_dir("restore-newer-src");
        let pool = seeded_db(&source_dir).await;
        let zip = dir.join("future.zip");
        export(&pool, &zip).await.unwrap();
        pool.close().await;

        // 把迁移登记版本改到超前当前：模拟更新版本应用产出的备份
        let unpacked = dir.join("future.sqlite");
        unpack_db_from_zip(&zip, &unpacked).unwrap();
        let tampered = open_plain(&unpacked).await.unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET version = 999999 WHERE version = (SELECT MAX(version) FROM _sqlx_migrations)")
            .execute(&tampered).await.unwrap();
        tampered.close().await;
        let zip2 = dir.join("future2.zip");
        zip_db(&unpacked, &zip2);

        let err = restore(&zip2, &dir).await.unwrap_err();
        assert_eq!(err.code, codes::BACKUP_SCHEMA_NEWER);
        assert_eq!(err.details.as_ref().unwrap()["backupVersion"], 999999);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&source_dir);
    }

    /// 预检通过：合法备份包放行，且不触碰暂存与标记（确认前零副作用）
    #[tokio::test]
    async fn validate_accepts_fresh_export_without_side_effects() {
        let dir = temp_dir("validate-ok");
        let pool = seeded_db(&dir).await;
        let zip = dir.join("backup.zip");
        export(&pool, &zip).await.unwrap();
        pool.close().await;

        validate(&zip, &dir).await.unwrap();
        assert!(!staged_path(&dir).exists());
        assert!(!marker_path(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn validate_rejects_invalid_zip() {
        let dir = temp_dir("validate-badzip");
        let bad = dir.join("bad.zip");
        std::fs::write(&bad, b"this is not a zip archive").unwrap();
        let err = validate(&bad, &dir).await.unwrap_err();
        assert_eq!(err.code, codes::BACKUP_INVALID_ZIP);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// zip 合法但内嵌库损坏 → 与 restore 同码；不落任何暂存面
    #[tokio::test]
    async fn validate_rejects_corrupt_db() {
        let dir = temp_dir("validate-baddb");
        let junk_db = dir.join("junk.sqlite");
        std::fs::write(&junk_db, b"not a sqlite database at all").unwrap();
        let zip = dir.join("junk.zip");
        zip_db(&junk_db, &zip);
        let err = validate(&zip, &dir).await.unwrap_err();
        assert_eq!(err.code, codes::BACKUP_INVALID_DB);
        assert!(!staged_path(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// export → restore round-trip：持久域回到备份时点，易失三表保留恢复前
    /// 当前值；替换链中断重入（段一续态）幂等收敛
    #[tokio::test]
    async fn restore_round_trip_keeps_volatile_from_current_db() {
        let dir = temp_dir("round-trip");
        let pool = seeded_db(&dir).await;
        let zip = dir.join("backup.zip");
        export(&pool, &zip).await.unwrap();

        // 恢复前当前值继续演化：持久域新增（应随替换消失）、易失三表累加（应保留）
        sqlx::query("INSERT INTO workspaces (id, name, base_url, created_at, updated_at, sort_order) VALUES ('ws-2', '工作空间B', NULL, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', 1)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO run_records (id, workspace_id, service_id, endpoint_key, method, url, status_code, duration_ms, state, error_code, error_message, request_json, response_json, source, created_at) VALUES ('run-2', 'ws-1', 'svc-1', 'GET /a', 'GET', 'https://example.com/a', 404, 30, 'failed', NULL, NULL, '{}', '{}', 'gui', '2026-01-02T00:00:00Z')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES ('logLevel', '\"debug\"')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE workspace_sessions SET tabs = '[\"tab-9\"]' WHERE workspace_id = 'ws-1'",
        )
        .execute(&pool)
        .await
        .unwrap();
        // 恢复前新建工作空间的会话行：其引用的持久域不在备份里，搬回成为
        // 孤儿行（不可达、无害），不得阻塞整段搬回
        sqlx::query("INSERT INTO workspace_sessions (workspace_id, tabs, tree_expanded, updated_at) VALUES ('ws-2', '[]', '[]', '2026-01-02T00:00:00Z')")
            .execute(&pool).await.unwrap();
        pool.close().await;

        restore(&zip, &dir).await.unwrap();
        assert!(staged_path(&dir).exists());
        assert!(marker_path(&dir).exists());

        // 模拟重启：段一（含中断重入的续态分支——staged 已让位后仍应 Applied）
        assert!(matches!(
            apply_pending_before_open(&dir).await,
            PendingRestore::Applied
        ));
        assert!(matches!(
            apply_pending_before_open(&dir).await,
            PendingRestore::Applied
        ));
        let pool = crate::db::init_gui(&dir).await.unwrap();
        carry_volatile_back(&pool, &dir).await.unwrap();

        // 持久域＝备份时点（ws-2 消失）；易失三表＝恢复前当前值（run-2 /
        // logLevel 在，session 保留恢复前 tabs）
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM workspaces").await, 1);
        let exists: i64 = count(&pool, "SELECT COUNT(*) FROM workspaces WHERE id = 'ws-1'").await;
        assert_eq!(exists, 1);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM run_records").await, 2);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM settings").await, 2);
        assert_eq!(
            count(&pool, "SELECT COUNT(*) FROM workspace_sessions").await,
            2,
            "含 ws-2 孤儿会话行"
        );
        let (tabs,): (String,) =
            sqlx::query_as("SELECT tabs FROM workspace_sessions WHERE workspace_id = 'ws-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(tabs, "[\"tab-9\"]");
        // 暂存面全部收敛
        assert!(!marker_path(&dir).exists());
        assert!(!staged_path(&dir).exists());
        assert!(!old_path(&dir).exists());
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 全新机器恢复：无主库可让位、无旧库可搬回——持久域来自备份，易失
    /// 表为空、设置回落默认
    #[tokio::test]
    async fn restore_on_fresh_machine_defaults_volatile_data() {
        let backup_dir = temp_dir("fresh-src");
        let pool = seeded_db(&backup_dir).await;
        let zip = backup_dir.join("backup.zip");
        export(&pool, &zip).await.unwrap();
        pool.close().await;

        let fresh = temp_dir("fresh-machine");
        restore(&zip, &fresh).await.unwrap();
        assert!(matches!(
            apply_pending_before_open(&fresh).await,
            PendingRestore::Applied
        ));
        let pool = crate::db::init_gui(&fresh).await.unwrap();
        carry_volatile_back(&pool, &fresh).await.unwrap();

        assert_eq!(count(&pool, "SELECT COUNT(*) FROM workspaces").await, 1);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM run_records").await, 0);
        assert_eq!(
            count(&pool, "SELECT COUNT(*) FROM settings").await,
            0,
            "设置回落默认＝空表"
        );
        assert_eq!(
            count(&pool, "SELECT COUNT(*) FROM workspace_sessions").await,
            0
        );
        assert!(!marker_path(&fresh).exists());
        assert!(!old_path(&fresh).exists());
        pool.close().await;
        let _ = std::fs::remove_dir_all(&fresh);
        let _ = std::fs::remove_dir_all(&backup_dir);
    }

    /// Windows 文件占用失败路径：另开连接持写锁（模拟 CLI 直连在写）→
    /// `BACKUP_FILE_LOCKED`、标记与暂存保留、原库无损
    #[tokio::test]
    async fn locked_database_defers_restore_and_keeps_db_intact() {
        let dir = temp_dir("locked");
        let pool = seeded_db(&dir).await;
        pool.close().await;
        // 备份内容＝合法暂存（复制当前库即可满足「合法 sqlite」判定）
        std::fs::copy(dir.join(crate::db::DB_FILE_NAME), staged_path(&dir)).unwrap();
        std::fs::write(marker_path(&dir), "staged_at_ms=0").unwrap();

        // 另开连接持写事务不提交：占用文件
        let holder = open_plain(&dir.join(crate::db::DB_FILE_NAME))
            .await
            .unwrap();
        let mut conn = holder.acquire().await.unwrap();
        sqlx::query("CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER)")
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO lock_probe VALUES (1)")
            .execute(&mut *conn)
            .await
            .unwrap();

        let outcome = apply_pending_before_open(&dir).await;
        let PendingRestore::Deferred(err) = outcome else {
            panic!("持锁时段一应延迟重试，实际 {outcome:?}");
        };
        assert_eq!(err.code, codes::BACKUP_FILE_LOCKED);
        // 原库无损：数据仍在主库落点，让位与顶替均未发生
        assert!(dir.join(crate::db::DB_FILE_NAME).exists());
        assert!(!old_path(&dir).exists());
        assert!(marker_path(&dir).exists());
        assert!(staged_path(&dir).exists());

        let _ = conn.close().await;
        holder.close().await;
        let reopened = open_plain(&dir.join(crate::db::DB_FILE_NAME))
            .await
            .unwrap();
        assert_eq!(count(&reopened, "SELECT COUNT(*) FROM workspaces").await, 1);
        reopened.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 替换链事务性：标记存在但暂存损坏 → 启动安全跳过（原库无损）、
    /// 标记收敛清理，不阻断启动
    #[tokio::test]
    async fn corrupt_staged_skips_safely_and_keeps_db_intact() {
        let dir = temp_dir("corrupt-staged");
        let pool = seeded_db(&dir).await;
        pool.close().await;
        std::fs::write(staged_path(&dir), b"corrupt staged bytes").unwrap();
        std::fs::write(marker_path(&dir), "staged_at_ms=0").unwrap();

        let outcome = apply_pending_before_open(&dir).await;
        let PendingRestore::Skipped(err) = outcome else {
            panic!("暂存损坏应安全跳过，实际 {outcome:?}");
        };
        assert_eq!(err.code, codes::BACKUP_INVALID_DB);
        // 标记收敛、原库未动且可正常开库
        assert!(!marker_path(&dir).exists());
        assert!(!staged_path(&dir).exists());
        let pool = crate::db::init_gui(&dir).await.unwrap();
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM workspaces").await, 1);
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 深层损坏拦截：暂存头部魔数合法但页内容全毁 → 头部浅校验放行、
    /// quick_check 深校验拦截——启动安全跳过（原库无损）、标记与暂存收敛，
    /// WAL 头暂存被校验连接产生的伴生也随跳过路径一并清理、无残留
    #[tokio::test]
    async fn deep_corrupt_staged_skips_safely_and_keeps_db_intact() {
        let dir = temp_dir("deep-corrupt-staged");
        let pool = seeded_db(&dir).await;
        pool.close().await;
        // 保留 SQLite 文件头（前 100 字节，含魔数）、页内容整体清零：
        // 绕过头部浅校验、必触 deep_check 损坏判定的确定性构造
        let mut bytes = std::fs::read(dir.join(crate::db::DB_FILE_NAME)).unwrap();
        const SQLITE_HEADER_LEN: usize = 100;
        bytes[SQLITE_HEADER_LEN..].fill(0);
        std::fs::write(staged_path(&dir), &bytes).unwrap();
        std::fs::write(marker_path(&dir), "staged_at_ms=0").unwrap();

        let outcome = apply_pending_before_open(&dir).await;
        let PendingRestore::Skipped(err) = outcome else {
            panic!("深层损坏暂存应安全跳过，实际 {outcome:?}");
        };
        assert_eq!(err.code, codes::BACKUP_INVALID_DB);
        // 标记收敛、暂存与伴生文件无残留、原库未动且可正常开库
        assert!(!marker_path(&dir).exists());
        assert!(!staged_path(&dir).exists());
        assert!(!with_suffix(&staged_path(&dir), "-wal").exists());
        assert!(!with_suffix(&staged_path(&dir), "-shm").exists());
        let pool = crate::db::init_gui(&dir).await.unwrap();
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM workspaces").await, 1);
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 标记写失败不留孤儿：暂存已落盘而标记写不进去（预置只读标记文件注入）
    /// → 受理失败、暂存先清（否则成为启动链永远不可达的孤儿文件）
    #[tokio::test]
    #[allow(clippy::permissions_set_readonly_false)] // Windows 清理：显式清只读位再删测试目录
    async fn marker_write_failure_cleans_staged() {
        let dir = temp_dir("marker-fail");
        let pool = seeded_db(&dir).await;
        let zip = dir.join("backup.zip");
        export(&pool, &zip).await.unwrap();
        pool.close().await;
        // 注入点：标记文件预置为只读，restore 的标记写入必然 PermissionDenied
        let marker = marker_path(&dir);
        std::fs::write(&marker, b"stale").unwrap();
        {
            let mut readonly = std::fs::metadata(&marker).unwrap().permissions();
            readonly.set_readonly(true);
            std::fs::set_permissions(&marker, readonly).unwrap();
        }

        let err = restore(&zip, &dir).await.unwrap_err();
        assert_eq!(err.code, codes::BACKUP_RESTORE_WRITE_FAILED);
        assert!(!staged_path(&dir).exists(), "暂存不得残留为孤儿");

        // 清理：解除只读后删测试目录（Windows 上只读文件不可随目录删除）
        let mut perms = std::fs::metadata(&marker).unwrap().permissions();
        perms.set_readonly(false);
        std::fs::set_permissions(&marker, perms).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 段二中断续跑：替换已完成（主库＝备份库）、旧库与标记在、暂存已让位
    /// → 续态直接进段二，易失数据从旧库完整搬回
    #[tokio::test]
    async fn interrupted_carryover_resumes_from_old_db() {
        let dir = temp_dir("resume-carry");
        let pool = seeded_db(&dir).await;
        let zip = dir.join("backup.zip");
        export(&pool, &zip).await.unwrap();
        pool.close().await;
        // 构造「替换已完成、搬回未完成」中间态：主库让位为旧库、备份库顶替
        // 主库落点、标记在（段一已跑完，段二未跑）
        let db_path = dir.join(crate::db::DB_FILE_NAME);
        std::fs::rename(&db_path, old_path(&dir)).unwrap();
        unpack_db_from_zip(&zip, &db_path).unwrap();
        std::fs::write(marker_path(&dir), "staged_at_ms=0").unwrap();

        assert!(matches!(
            apply_pending_before_open(&dir).await,
            PendingRestore::Applied
        ));
        let pool = crate::db::init_gui(&dir).await.unwrap();
        carry_volatile_back(&pool, &dir).await.unwrap();

        // 持久域＝备份库内容；易失三表＝旧库（恢复前）当前值
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM workspaces").await, 1);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM run_records").await, 1);
        assert_eq!(count(&pool, "SELECT COUNT(*) FROM settings").await, 1);
        assert_eq!(
            count(&pool, "SELECT COUNT(*) FROM workspace_sessions").await,
            1
        );
        assert!(!marker_path(&dir).exists());
        assert!(!old_path(&dir).exists());
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 无标记时启动零动作（常规启动路径不得误触替换链）
    #[tokio::test]
    async fn no_marker_means_noop() {
        let dir = temp_dir("noop");
        let pool = seeded_db(&dir).await;
        pool.close().await;
        assert!(matches!(
            apply_pending_before_open(&dir).await,
            PendingRestore::None
        ));
        assert!(dir.join(crate::db::DB_FILE_NAME).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 孤儿标记收敛分支：标记在、暂存与旧库均不在（替换与搬回均完成、
    /// 只剩收尾中断）→ 无待恢复返回 None，标记被收敛清理
    #[tokio::test]
    async fn orphan_marker_without_staged_or_old_converges_to_none() {
        let dir = temp_dir("orphan-marker");
        std::fs::write(marker_path(&dir), "staged_at_ms=0").unwrap();
        assert!(matches!(
            apply_pending_before_open(&dir).await,
            PendingRestore::None
        ));
        assert!(!marker_path(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 无标记时暂存残留收敛：标记先于暂存消失的孤儿暂存（受理失败收尾
    /// 中断等）→ 启动时暂存连同伴生一并清理，返回 None
    #[tokio::test]
    async fn orphan_staged_residue_without_marker_cleaned_on_startup() {
        let dir = temp_dir("orphan-staged");
        std::fs::write(staged_path(&dir), b"stale staged bytes").unwrap();
        std::fs::write(with_suffix(&staged_path(&dir), "-wal"), b"stale wal").unwrap();
        std::fs::write(with_suffix(&staged_path(&dir), "-shm"), b"stale shm").unwrap();
        assert!(matches!(
            apply_pending_before_open(&dir).await,
            PendingRestore::None
        ));
        assert!(!staged_path(&dir).exists());
        assert!(!with_suffix(&staged_path(&dir), "-wal").exists());
        assert!(!with_suffix(&staged_path(&dir), "-shm").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// zip 内 .sqlite 条目数约束：0 条目与 2 条目均拒绝（合法备份包＝恰
    /// 一条），且拒绝路径不落暂存半成品
    #[tokio::test]
    async fn restore_rejects_zip_with_zero_or_multiple_sqlite_entries() {
        let src = temp_dir("zip-entries-src");
        let pool = seeded_db(&src).await;
        pool.close().await;
        let db_bytes = std::fs::read(src.join(crate::db::DB_FILE_NAME)).unwrap();
        let dir = temp_dir("zip-entries");

        let empty = dir.join("empty.zip");
        write_zip_entries(&empty, &[]);
        let err = restore(&empty, &dir).await.unwrap_err();
        assert_eq!(err.code, codes::BACKUP_INVALID_ZIP);
        assert!(err.message.contains("found 0"), "{}", err.message);

        let double = dir.join("double.zip");
        write_zip_entries(&double, &[("a.sqlite", &db_bytes), ("b.sqlite", &db_bytes)]);
        let err = restore(&double, &dir).await.unwrap_err();
        assert_eq!(err.code, codes::BACKUP_INVALID_ZIP);
        assert!(err.message.contains("found 2"), "{}", err.message);
        assert!(!staged_path(&dir).exists());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&src);
    }

    /// 导出失败不留暂存残留：zip 目标不可写（目标位置被目录占用）→ 打包
    /// 失败报错，同目录的 staging 副本必须已被清理——「失败不留残留」是
    /// export interface 的明确契约
    #[tokio::test]
    async fn failed_export_leaves_no_staging_residue() {
        let dir = temp_dir("export-fail");
        let pool = seeded_db(&dir).await;
        // 打包目标预置为目录：File::create 必然失败 → zip 写失败
        let target = dir.join("out.zip");
        std::fs::create_dir(&target).unwrap();
        let err = export(&pool, &target).await.unwrap_err();
        assert_eq!(err.code, codes::BACKUP_EXPORT_WRITE_FAILED);
        pool.close().await;

        let residues: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("apilot-backup-staging-"))
            .collect();
        assert!(
            residues.is_empty(),
            "导出失败后不得残留 staging 副本：{residues:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 重复受理覆盖语义：pending 未消费时再受理新恢复 → 暂存被最新受理的
    /// 备份覆盖，重启替换链消费的是最后受理的内容
    #[tokio::test]
    async fn repeated_restore_replaces_pending_staging_with_latest() {
        let dir_a = temp_dir("repeat-a");
        let dir_b = temp_dir("repeat-b");
        let target = temp_dir("repeat-target");

        let pool_a = seeded_db(&dir_a).await;
        let zip_a = dir_a.join("a.zip");
        export(&pool_a, &zip_a).await.unwrap();
        pool_a.close().await;
        let pool_b = seeded_db(&dir_b).await;
        sqlx::query("UPDATE workspaces SET name = '工作空间B'")
            .execute(&pool_b)
            .await
            .unwrap();
        let zip_b = dir_b.join("b.zip");
        export(&pool_b, &zip_b).await.unwrap();
        pool_b.close().await;

        restore(&zip_a, &target).await.unwrap();
        restore(&zip_b, &target).await.unwrap();
        assert!(staged_path(&target).exists());
        assert!(marker_path(&target).exists());

        // 重启：段一消费的应是 B（最后受理）
        assert!(matches!(
            apply_pending_before_open(&target).await,
            PendingRestore::Applied
        ));
        let pool = crate::db::init_gui(&target).await.unwrap();
        carry_volatile_back(&pool, &target).await.unwrap();
        let (name,): (String,) = sqlx::query_as("SELECT name FROM workspaces")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(name, "工作空间B");
        assert!(!marker_path(&target).exists());
        assert!(!staged_path(&target).exists());
        assert!(!old_path(&target).exists());
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
        let _ = std::fs::remove_dir_all(&target);
    }

    /// 三态并存防御推演链：恢复 A → 段一完成（old＝恢复前旧库，含易失
    /// 数据）→ 段二未跑时又受理恢复 B → 重启替换时让位动作不得静默覆盖
    /// old——先连同伴生搬到旁名留档，A 恢复前的易失数据仍在盘上
    #[tokio::test]
    async fn three_state_coexistence_moves_leftover_old_aside_instead_of_overwriting() {
        let dir = temp_dir("three-state");
        let pool = seeded_db(&dir).await;
        let zip = dir.join("backup.zip");
        export(&pool, &zip).await.unwrap();
        pool.close().await;

        // 第一次恢复＋段一：主库让位为 old（内含恢复前易失数据），段二未跑
        restore(&zip, &dir).await.unwrap();
        assert!(matches!(
            apply_pending_before_open(&dir).await,
            PendingRestore::Applied
        ));
        assert!(old_path(&dir).exists());

        // 段二未完成时受理第二次恢复：三态并存（db＋staged＋old＋marker）
        restore(&zip, &dir).await.unwrap();
        assert!(matches!(
            apply_pending_before_open(&dir).await,
            PendingRestore::Applied
        ));

        // 残留 old 已搬到旁名留档（backup-old-<ms>.sqlite），未被让位覆盖
        let sidecars: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                name.starts_with("backup-old-") && name.ends_with(".sqlite")
            })
            .collect();
        assert_eq!(sidecars.len(), 1, "残留 old 应恰一份旁名留档");
        // 旁档＝第一次恢复前的旧库：易失数据未丢失
        let sidecar = open_plain(&sidecars[0]).await.unwrap();
        assert_eq!(count(&sidecar, "SELECT COUNT(*) FROM run_records").await, 1);
        assert_eq!(count(&sidecar, "SELECT COUNT(*) FROM settings").await, 1);
        sidecar.close().await;

        // 替换链后续照常收敛：段二从（新）old 搬回，标记与暂存面清空
        let pool = crate::db::init_gui(&dir).await.unwrap();
        carry_volatile_back(&pool, &dir).await.unwrap();
        assert!(!marker_path(&dir).exists());
        assert!(!staged_path(&dir).exists());
        assert!(!old_path(&dir).exists());
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 回滚链失败留痕推演链：段一顶替暂存失败（暂存被外部进程占用）触发
    /// 回滚，而回滚自身也失败（old 同被占用）→ 主库落点空缺、下次启动建
    /// 空库的数据丢失窗口——必须有 error 级日志记录数据实际落点（old 路径）
    #[tokio::test]
    async fn rollback_failure_logs_old_location() {
        let src = temp_dir("rollback-src");
        let pool = seeded_db(&src).await;
        pool.close().await;
        let dir = temp_dir("rollback-fail");
        // 异常中间态：无主库，staged 与 old 均在且被外部连接占用，标记在
        std::fs::copy(src.join(crate::db::DB_FILE_NAME), staged_path(&dir)).unwrap();
        std::fs::copy(src.join(crate::db::DB_FILE_NAME), old_path(&dir)).unwrap();
        std::fs::write(marker_path(&dir), "staged_at_ms=0").unwrap();

        // staged 与 old 各开连接持写事务不提交：模拟两文件被外部进程占用
        let staged_lock = open_plain(&staged_path(&dir)).await.unwrap();
        let mut sconn = staged_lock.acquire().await.unwrap();
        sqlx::query("CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER)")
            .execute(&mut *sconn)
            .await
            .unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *sconn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO lock_probe VALUES (1)")
            .execute(&mut *sconn)
            .await
            .unwrap();
        let old_lock = open_plain(&old_path(&dir)).await.unwrap();
        let mut oconn = old_lock.acquire().await.unwrap();
        sqlx::query("CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER)")
            .execute(&mut *oconn)
            .await
            .unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *oconn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO lock_probe VALUES (1)")
            .execute(&mut *oconn)
            .await
            .unwrap();

        let (guard, lines) = capture_logs();
        let outcome = apply_pending_before_open(&dir).await;
        drop(guard);

        let PendingRestore::Deferred(err) = outcome else {
            panic!("暂存被占用时段一应延迟重试，实际 {outcome:?}");
        };
        assert_eq!(err.code, codes::BACKUP_FILE_LOCKED);
        // 回滚失败留痕：error 级日志记录 old 实际落点
        let logs = lines.lock().unwrap().join("");
        assert!(logs.contains("ERROR"), "应有 error 级日志：{logs}");
        assert!(
            logs.contains(&old_path(&dir).display().to_string()),
            "日志应含 old 实际落点：{logs}"
        );
        assert!(
            logs.contains("rollback failed"),
            "日志应说明回滚失败：{logs}"
        );
        // 回滚失败的直接后果：主库落点未被重建；数据仍在 old 原位
        assert!(!dir.join(crate::db::DB_FILE_NAME).exists());
        assert!(old_path(&dir).exists());
        assert!(marker_path(&dir).exists());
        assert!(staged_path(&dir).exists());

        let _ = sconn.close().await;
        staged_lock.close().await;
        let _ = oconn.close().await;
        old_lock.close().await;
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&src);
    }

    /// 非本产品库（无迁移登记表）的拒绝信息携带底层错误上下文：磁盘 IO
    /// 故障与文件损坏在错误信息里可分辨
    #[tokio::test]
    async fn restore_rejects_foreign_db_with_underlying_cause() {
        let dir = temp_dir("foreign-db");
        let foreign = dir.join("foreign.sqlite");
        let pool = crate::db::connect(&foreign).await.unwrap();
        pool.close().await;
        let zip = dir.join("foreign.zip");
        zip_db(&foreign, &zip);

        let err = restore(&zip, &dir).await.unwrap_err();
        assert_eq!(err.code, codes::BACKUP_INVALID_DB);
        assert!(
            err.message.contains("_sqlx_migrations"),
            "错误信息应含底层上下文：{}",
            err.message
        );
        assert!(!staged_path(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 占用判定口径：共享冲突(32) / 锁冲突(33) 是进程占用；拒绝访问(5)
    /// 是纯 ACL 权限问题，不得归入占用（会误导「关闭其他进程」指引）
    #[cfg(windows)]
    #[test]
    fn access_denied_is_not_lock_while_sharing_violations_are() {
        assert!(is_file_locked(&std::io::Error::from_raw_os_error(32)));
        assert!(is_file_locked(&std::io::Error::from_raw_os_error(33)));
        assert!(!is_file_locked(&std::io::Error::from_raw_os_error(5)));
    }
}
