//! Fold closed arrival buckets into the next tier.
//!
//! A pass rewrites the `hot-` files of a finished hour into one `hour-` file, an
//! hour's worth of `hour-` files of a finished day into one `day-` file, and
//! likewise days into `month-` files. Only fully closed buckets are touched, so
//! a bucket is written once and never reopened. Each output is sorted by
//! `source, timestamp`.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::RwLock;
use tokio::time::MissedTickBehavior;

use crate::config::WriteOptions;
use crate::parquet;
use crate::storage::{self, Tier, TierFile};

pub struct Context {
    pub data_dir: PathBuf,
    pub staging: PathBuf,
    pub trash: PathBuf,
    pub lock: Arc<RwLock<()>>,
    pub opts: WriteOptions,
    pub grace_ms: i64,
}

pub async fn run(ctx: Arc<Context>) {
    let mut ticker = tokio::time::interval(ctx.opts.compaction_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // Trash only needs sweeping occasionally. Doing it every compaction pass
    // would `lstat` every retired file once a minute for no benefit, so it runs
    // on its own slower cadence (and once at startup, to catch up after a stop).
    let mut next_gc = tokio::time::Instant::now();
    loop {
        ticker.tick().await;
        if let Err(err) = run_once(&ctx).await {
            tracing::warn!(error = %err, "compaction pass failed");
        }
        if tokio::time::Instant::now() >= next_gc {
            storage::gc_trash(&ctx.trash, ctx.opts.trash_retention);
            next_gc = tokio::time::Instant::now() + ctx.opts.trash_gc_interval;
        }
    }
}

pub async fn run_once(ctx: &Context) -> Result<(), String> {
    compact_recents(ctx).await?;
    compact_hours(ctx).await?;
    compact_days(ctx).await?;
    compact_months(ctx).await?;
    Ok(())
}

/// Fold the 10 s hot files of a finished five-minute bucket into one file. This
/// caps the hot tail at a bucket's worth of files instead of a whole hour's.
async fn compact_recents(ctx: &Context) -> Result<(), String> {
    let files = list(ctx)?;
    let now = storage::now_ms();
    let existing: HashSet<String> = files
        .iter()
        .filter(|f| f.tier == Tier::Recent)
        .map(|f| f.name.clone())
        .collect();

    let mut groups: BTreeMap<i64, Vec<TierFile>> = BTreeMap::new();
    for file in files.iter().filter(|f| f.tier == Tier::Hot) {
        groups
            .entry(storage::recent_start_ms(file.start_ms))
            .or_default()
            .push(file.clone());
    }

    for (bucket, mut group) in groups {
        let name = storage::recent_name(bucket);
        if existing.contains(&name) {
            trash_inputs(ctx, &group).await?;
            continue;
        }
        if now < bucket + storage::RECENT_MS + ctx.grace_ms {
            continue;
        }
        group.sort_by_key(|f| f.start_ms);
        merge_and_install(ctx, &name, &group).await?;
    }
    Ok(())
}

async fn compact_hours(ctx: &Context) -> Result<(), String> {
    let files = list(ctx)?;
    let now = storage::now_ms();
    let existing: HashSet<String> = files
        .iter()
        .filter(|f| f.tier == Tier::Hour)
        .map(|f| f.name.clone())
        .collect();
    // An hour can only be built once every hot file in it has been folded into
    // a recent file, otherwise those rows would be missing from the hour.
    let hot_hours: HashSet<i64> = files
        .iter()
        .filter(|f| f.tier == Tier::Hot)
        .map(|f| storage::hour_start_ms(f.start_ms))
        .collect();

    let mut groups: BTreeMap<i64, Vec<TierFile>> = BTreeMap::new();
    for file in files.iter().filter(|f| f.tier == Tier::Recent) {
        groups
            .entry(storage::hour_start_ms(file.start_ms))
            .or_default()
            .push(file.clone());
    }

    for (hour, mut group) in groups {
        let name = storage::hour_name(hour);
        if existing.contains(&name) {
            trash_inputs(ctx, &group).await?;
            continue;
        }
        if hot_hours.contains(&hour) {
            continue;
        }
        if now < hour + storage::HOUR_MS + ctx.grace_ms {
            continue;
        }
        group.sort_by_key(|f| f.start_ms);
        merge_and_install(ctx, &name, &group).await?;
    }
    Ok(())
}

async fn compact_days(ctx: &Context) -> Result<(), String> {
    let files = list(ctx)?;
    let now = storage::now_ms();
    let existing: HashSet<String> = files
        .iter()
        .filter(|f| f.tier == Tier::Day)
        .map(|f| f.name.clone())
        .collect();
    // A day can only be built once every finer file in it has been folded,
    // otherwise those rows would be missing from the day.
    let finer_days: HashSet<i64> = files
        .iter()
        .filter(|f| matches!(f.tier, Tier::Hot | Tier::Recent))
        .map(|f| storage::day_start_ms(f.start_ms))
        .collect();

    let mut groups: BTreeMap<i64, Vec<TierFile>> = BTreeMap::new();
    for file in files.iter().filter(|f| f.tier == Tier::Hour) {
        groups
            .entry(storage::day_start_ms(file.start_ms))
            .or_default()
            .push(file.clone());
    }

    for (day, mut group) in groups {
        let name = storage::day_name(day);
        if existing.contains(&name) {
            trash_inputs(ctx, &group).await?;
            continue;
        }
        if finer_days.contains(&day) {
            continue;
        }
        if now < day + storage::DAY_MS + ctx.grace_ms {
            continue;
        }
        group.sort_by_key(|f| f.start_ms);
        merge_and_install(ctx, &name, &group).await?;
    }
    Ok(())
}

async fn compact_months(ctx: &Context) -> Result<(), String> {
    let files = list(ctx)?;
    let now = storage::now_ms();
    let existing: HashSet<String> = files
        .iter()
        .filter(|f| f.tier == Tier::Month)
        .map(|f| f.name.clone())
        .collect();
    // Only days may remain once a month is built; anything finer means the
    // month is not fully folded yet.
    let unfinished: HashSet<i64> = files
        .iter()
        .filter(|f| matches!(f.tier, Tier::Hot | Tier::Recent | Tier::Hour))
        .map(|f| storage::month_start_ms(f.start_ms))
        .collect();

    let mut groups: BTreeMap<i64, Vec<TierFile>> = BTreeMap::new();
    for file in files.iter().filter(|f| f.tier == Tier::Day) {
        groups
            .entry(storage::month_start_ms(file.start_ms))
            .or_default()
            .push(file.clone());
    }

    for (month, mut group) in groups {
        let name = storage::month_name(month);
        if existing.contains(&name) {
            trash_inputs(ctx, &group).await?;
            continue;
        }
        if unfinished.contains(&month) {
            continue;
        }
        if now < storage::next_month_ms(month) + ctx.grace_ms {
            continue;
        }
        group.sort_by_key(|f| f.start_ms);
        merge_and_install(ctx, &name, &group).await?;
    }
    Ok(())
}

async fn merge_and_install(ctx: &Context, name: &str, group: &[TierFile]) -> Result<(), String> {
    let inputs: Vec<PathBuf> = group.iter().map(|f| f.path.clone()).collect();
    let staging = ctx.staging.clone();
    let name_owned = name.to_string();
    let row_group_size = ctx.opts.row_group_size;
    let merge_inputs = inputs.clone();
    let staged = tokio::task::spawn_blocking(move || {
        parquet::merge(&staging, &name_owned, &merge_inputs, row_group_size)
    })
    .await
    .map_err(|e| format!("merge task failed: {e}"))??;

    tracing::info!(bucket = name, files = inputs.len(), "compacted tier");
    install(ctx, staged, name, &inputs).await
}

/// Put the merged file in place and retire its inputs. The swap holds the
/// exclusive data lock, so no query sees a bucket twice or not at all.
async fn install(
    ctx: &Context,
    staged: PathBuf,
    name: &str,
    inputs: &[PathBuf],
) -> Result<(), String> {
    let _guard = ctx.lock.write().await;
    let target = ctx.data_dir.join(name);
    if target.exists() {
        // A previous pass already produced it; drop our copy.
        let _ = std::fs::remove_file(&staged);
    } else {
        std::fs::rename(&staged, &target).map_err(|e| format!("{}: {e}", target.display()))?;
        if let Ok(dir) = std::fs::File::open(&ctx.data_dir) {
            let _ = dir.sync_all();
        }
    }
    if target.exists() {
        retire(ctx, inputs);
    }
    Ok(())
}

/// Reconcile: the target already existed, so finer files are superseded.
async fn trash_inputs(ctx: &Context, group: &[TierFile]) -> Result<(), String> {
    let _guard = ctx.lock.write().await;
    let inputs: Vec<PathBuf> = group.iter().map(|f| f.path.clone()).collect();
    retire(ctx, &inputs);
    Ok(())
}

fn retire(ctx: &Context, inputs: &[PathBuf]) {
    for input in inputs {
        if let Err(err) = storage::move_to_trash(input, &ctx.trash) {
            tracing::warn!(path = %input.display(), error = %err, "could not retire superseded file");
        }
    }
}

fn list(ctx: &Context) -> Result<Vec<TierFile>, String> {
    storage::list_tier_files(&ctx.data_dir).map_err(|e| format!("{}: {e}", ctx.data_dir.display()))
}
