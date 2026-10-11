use crate::{Run, Status};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

pub const DAY_NS: i64 = 86_400_000_000_000;
/// How far back a query's usual time reaches, before its recent runs.
pub const USUAL_DAYS: i64 = 14;
const RECENT_AT_LEAST: usize = 3;
const USUAL_AT_LEAST: usize = 5;
const CHANGED: f64 = 1.5;
const SURE: f64 = 0.01;
/// A warning first seen within this many days is new.
const NEW_DAYS: i64 = 7;

/// The days and the stretch of time an overview covers.
#[derive(Debug, Clone)]
pub struct Window {
    pub now_unix_ns: i64,
    /// Where each day starts, oldest first; the range runs from the first to now.
    pub days: Vec<i64>,
    pub bins: usize,
}

impl Window {
    /// `days` local days ending today, for a clock `utc_offset_min` minutes ahead of UTC.
    #[must_use]
    pub fn local(now_unix_ns: i64, days: u32, utc_offset_min: i32, bins: usize) -> Self {
        let offset = i64::from(utc_offset_min) * 60_000_000_000;
        let today = (now_unix_ns + offset).div_euclid(DAY_NS) * DAY_NS - offset;
        let days = (0..i64::from(days.max(1)))
            .rev()
            .map(|back| today - back * DAY_NS)
            .collect();
        Self {
            now_unix_ns,
            days,
            bins,
        }
    }

    #[must_use]
    pub fn since_unix_ns(&self) -> i64 {
        self.days[0]
    }

    /// The earliest run an overview needs: the range, or the usual time of a query's recent runs.
    #[must_use]
    pub fn reads_since_unix_ns(&self) -> i64 {
        self.since_unix_ns()
            .min(self.now_unix_ns - (USUAL_DAYS + 2) * DAY_NS)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Slower,
    Faster,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Day {
    pub runs: u64,
    pub failed: u64,
    pub median_wall_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueryOverview {
    pub label: Option<String>,
    pub service: Option<String>,
    pub runs: u64,
    pub failed: u64,
    pub last_started_unix_ns: i64,
    pub total_wall_ms: f64,
    pub usual_wall_ms: Option<f64>,
    pub usual_band_ms: Option<[f64; 2]>,
    pub recent_wall_ms: Option<f64>,
    pub recent_runs: u64,
    pub recent_failed: u64,
    pub failed_before: u64,
    pub first_recent_failure_unix_ns: Option<i64>,
    pub verdict: Option<Verdict>,
    pub ratio: Option<f64>,
    pub rules: Vec<String>,
    pub new_rules: Vec<String>,
    pub new_rules_since_unix_ns: Option<i64>,
    pub plan_changed_unix_ns: Option<i64>,
    pub bins: Vec<Option<f64>>,
    pub days: Vec<Day>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Version {
    pub fingerprint: Option<String>,
    pub runs: u64,
    pub failed: u64,
    pub first_started_unix_ns: i64,
    pub last_started_unix_ns: i64,
    pub usual_wall_ms: Option<f64>,
    pub rules: Vec<String>,
    pub latest_query_id: String,
}

/// Each label with runs in the window: what is usual for it and whether its last day differs.
#[must_use]
pub fn overview(runs: &[Run], window: &Window) -> Vec<QueryOverview> {
    let mut by_label: BTreeMap<Option<&str>, Vec<&Run>> = BTreeMap::new();
    for run in runs {
        by_label.entry(run.label.as_deref()).or_default().push(run);
    }
    let mut out: Vec<QueryOverview> = by_label
        .into_iter()
        .filter_map(|(label, mut runs)| {
            runs.sort_by_key(|run| run.started_unix_ns);
            one(label, &runs, window)
        })
        .collect();
    out.sort_by(|a, b| {
        b.total_wall_ms
            .total_cmp(&a.total_wall_ms)
            .then_with(|| a.label.cmp(&b.label))
    });
    out
}

fn one(label: Option<&str>, runs: &[&Run], window: &Window) -> Option<QueryOverview> {
    let now = window.now_unix_ns;
    let since = window.since_unix_ns();
    let in_range: Vec<&Run> = runs
        .iter()
        .copied()
        .filter(|run| run.started_unix_ns >= since && run.status != Status::Running)
        .collect();
    let last = *in_range.last()?;
    let wall = |run: &&Run| {
        (run.status == Status::Finished)
            .then_some(run.wall_ms)
            .flatten()
    };
    let done: Vec<&Run> = runs
        .iter()
        .copied()
        .filter(|run| wall(run).is_some())
        .collect();
    let day_ago = now - DAY_NS;
    let timing = timing(&done, now);

    let last_day: Vec<&Run> = runs
        .iter()
        .copied()
        .filter(|run| run.started_unix_ns >= day_ago && run.status != Status::Running)
        .collect();
    let before: Vec<&Run> = runs
        .iter()
        .copied()
        .filter(|run| {
            run.started_unix_ns >= day_ago - USUAL_DAYS * DAY_NS && run.started_unix_ns < day_ago
        })
        .collect();
    let failed = |run: &&&Run| run.status == Status::Failed;
    let rules: BTreeSet<&str> = if last_day.is_empty() {
        vec![last]
    } else {
        last_day.clone()
    }
    .iter()
    .flat_map(|run| run.rules.iter().map(String::as_str))
    .collect();
    let (new_rules, new_rules_since_unix_ns) = fresh(runs, &rules, now);

    Some(QueryOverview {
        label: label.map(str::to_owned),
        service: most_common(in_range.iter().filter_map(|run| run.service.as_deref())),
        runs: in_range.len() as u64,
        failed: in_range.iter().filter(failed).count() as u64,
        last_started_unix_ns: last.started_unix_ns,
        total_wall_ms: in_range.iter().filter_map(wall).sum(),
        usual_wall_ms: timing.known().then(|| median(&timing.usual)),
        usual_band_ms: timing
            .known()
            .then(|| [quantile(&timing.usual, 0.25), quantile(&timing.usual, 0.75)]),
        recent_wall_ms: (!timing.recent.is_empty()).then(|| median(&timing.recent)),
        recent_runs: last_day.len() as u64,
        recent_failed: last_day.iter().filter(failed).count() as u64,
        failed_before: before.iter().filter(failed).count() as u64,
        first_recent_failure_unix_ns: last_day.iter().find(failed).map(|run| run.started_unix_ns),
        verdict: timing.verdict,
        ratio: timing.ratio,
        rules: rules.into_iter().map(str::to_owned).collect(),
        new_rules,
        new_rules_since_unix_ns,
        plan_changed_unix_ns: plan_changed(&done, now),
        bins: bins(&done, window),
        days: days(runs, window),
    })
}

struct Timing {
    usual: Vec<f64>,
    recent: Vec<f64>,
    ratio: Option<f64>,
    verdict: Option<Verdict>,
}

impl Timing {
    fn known(&self) -> bool {
        self.usual.len() >= USUAL_AT_LEAST
    }
}

/// The last day's wall times, or the last few, against the two weeks before them.
fn timing(done: &[&Run], now: i64) -> Timing {
    let day_ago = now - DAY_NS;
    let mut recent: Vec<&Run> = done
        .iter()
        .copied()
        .filter(|run| run.started_unix_ns >= day_ago)
        .collect();
    if recent.len() < RECENT_AT_LEAST {
        recent = done[done.len().saturating_sub(RECENT_AT_LEAST)..].to_vec();
    }
    let recent_from = recent
        .first()
        .map_or(day_ago, |run| run.started_unix_ns.min(day_ago));
    let usual_from = recent_from - USUAL_DAYS * DAY_NS;
    let usual: Vec<f64> = done
        .iter()
        .filter(|run| run.started_unix_ns >= usual_from && run.started_unix_ns < recent_from)
        .filter_map(|run| run.wall_ms)
        .collect();
    let recent: Vec<f64> = recent.iter().filter_map(|run| run.wall_ms).collect();
    let ratio = (usual.len() >= USUAL_AT_LEAST && !recent.is_empty())
        .then(|| median(&recent) / median(&usual))
        .filter(|ratio| ratio.is_finite());
    let verdict = ratio
        .filter(|_| recent.len() >= RECENT_AT_LEAST)
        .and_then(|ratio| {
            if ratio >= CHANGED && larger(&usual, &recent) < SURE {
                Some(Verdict::Slower)
            } else if ratio <= 1.0 / CHANGED && larger(&recent, &usual) < SURE {
                Some(Verdict::Faster)
            } else {
                None
            }
        });
    Timing {
        usual,
        recent,
        ratio,
        verdict,
    }
}

/// The warnings among `rules` first seen within the last days, and when the first of them was.
fn fresh(runs: &[&Run], rules: &BTreeSet<&str>, now: i64) -> (Vec<String>, Option<i64>) {
    let found: Vec<(String, i64)> = rules
        .iter()
        .filter_map(|rule| {
            let at = runs
                .iter()
                .position(|run| run.rules.iter().any(|r| r == rule))?;
            let since = runs[at].started_unix_ns;
            (since >= now - NEW_DAYS * DAY_NS && at >= USUAL_AT_LEAST)
                .then(|| ((*rule).to_owned(), since))
        })
        .collect();
    let since = found.iter().map(|(_, since)| *since).min();
    (found.into_iter().map(|(rule, _)| rule).collect(), since)
}

/// When the plan the query runs now first ran, if it is not the plan it usually ran. Failed runs do not count.
fn plan_changed(done: &[&Run], now: i64) -> Option<i64> {
    let day_ago = now - DAY_NS;
    let current = done
        .iter()
        .rev()
        .find_map(|run| run.fingerprint.as_deref())?;
    let before: Vec<&str> = done
        .iter()
        .filter(|run| {
            run.started_unix_ns >= day_ago - USUAL_DAYS * DAY_NS && run.started_unix_ns < day_ago
        })
        .filter_map(|run| run.fingerprint.as_deref())
        .collect();
    let usual = most_common(before.iter().copied())?;
    if before.len() < USUAL_AT_LEAST || usual == current {
        return None;
    }
    let mut since = None;
    for run in done.iter().rev() {
        match run.fingerprint.as_deref() {
            Some(fingerprint) if fingerprint != current => break,
            _ => since = Some(run.started_unix_ns),
        }
    }
    since
}

fn bins(done: &[&Run], window: &Window) -> Vec<Option<f64>> {
    let since = window.since_unix_ns();
    let span = (window.now_unix_ns - since).max(1);
    let count = window.bins.max(1);
    let mut walls: Vec<Vec<f64>> = vec![Vec::new(); count];
    for run in done.iter().filter(|run| run.started_unix_ns >= since) {
        let at = usize::try_from(
            i128::from(run.started_unix_ns - since) * count as i128 / i128::from(span),
        )
        .unwrap_or(0)
        .min(count - 1);
        if let Some(wall) = run.wall_ms {
            walls[at].push(wall);
        }
    }
    walls
        .iter()
        .map(|w| (!w.is_empty()).then(|| median(w)))
        .collect()
}

fn days(runs: &[&Run], window: &Window) -> Vec<Day> {
    window
        .days
        .iter()
        .enumerate()
        .map(|(i, &start)| {
            let end = window.days.get(i + 1).copied().unwrap_or(i64::MAX);
            let that: Vec<&&Run> = runs
                .iter()
                .filter(|run| {
                    run.started_unix_ns >= start
                        && run.started_unix_ns < end
                        && run.status != Status::Running
                })
                .collect();
            let walls: Vec<f64> = that
                .iter()
                .filter(|run| run.status == Status::Finished)
                .filter_map(|run| run.wall_ms)
                .collect();
            Day {
                runs: that.len() as u64,
                failed: that
                    .iter()
                    .filter(|run| run.status == Status::Failed)
                    .count() as u64,
                median_wall_ms: (!walls.is_empty()).then(|| median(&walls)),
            }
        })
        .collect()
}

/// Each plan a label ran with, the one run last first.
#[must_use]
pub fn versions(runs: &[Run]) -> Vec<Version> {
    let mut by_plan: BTreeMap<Option<&str>, Vec<&Run>> = BTreeMap::new();
    for run in runs.iter().filter(|run| run.status != Status::Running) {
        by_plan
            .entry(run.fingerprint.as_deref())
            .or_default()
            .push(run);
    }
    let mut out: Vec<Version> = by_plan
        .into_iter()
        .filter_map(|(fingerprint, mut runs)| {
            runs.sort_by_key(|run| run.started_unix_ns);
            let walls: Vec<f64> = runs
                .iter()
                .filter(|run| run.status == Status::Finished)
                .filter_map(|run| run.wall_ms)
                .collect();
            let (first, last) = (runs.first()?, runs.last()?);
            Some(Version {
                fingerprint: fingerprint.map(str::to_owned),
                runs: runs.len() as u64,
                failed: runs
                    .iter()
                    .filter(|run| run.status == Status::Failed)
                    .count() as u64,
                first_started_unix_ns: first.started_unix_ns,
                last_started_unix_ns: last.started_unix_ns,
                usual_wall_ms: (!walls.is_empty()).then(|| median(&walls)),
                rules: runs
                    .iter()
                    .flat_map(|run| run.rules.iter().cloned())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect(),
                latest_query_id: last.query_id.clone(),
            })
        })
        .collect();
    out.sort_by_key(|version| std::cmp::Reverse(version.last_started_unix_ns));
    out
}

fn most_common<'a>(values: impl Iterator<Item = &'a str>) -> Option<String> {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for value in values {
        *counts.entry(value).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(value, _)| value.to_owned())
}

fn sorted(values: &[f64]) -> Vec<f64> {
    let mut copy = values.to_vec();
    copy.sort_by(f64::total_cmp);
    copy
}

#[must_use]
pub fn median(values: &[f64]) -> f64 {
    let s = sorted(values);
    let mid = s.len() / 2;
    if s.is_empty() {
        f64::NAN
    } else if s.len() % 2 == 1 {
        s[mid]
    } else {
        f64::midpoint(s[mid - 1], s[mid])
    }
}

#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
fn quantile(values: &[f64], q: f64) -> f64 {
    let s = sorted(values);
    s[((s.len() - 1) as f64 * q).round() as usize]
}

/// One-sided Mann-Whitney U test: how likely values as large as `high`'s would be if they came from where `low`'s did.
#[must_use]
#[allow(clippy::cast_precision_loss)]
pub fn larger(low: &[f64], high: &[f64]) -> f64 {
    let (n1, n2) = (low.len() as f64, high.len() as f64);
    if low.is_empty() || high.is_empty() {
        return 1.0;
    }
    let mut all: Vec<(f64, bool)> = low
        .iter()
        .map(|&v| (v, false))
        .chain(high.iter().map(|&v| (v, true)))
        .collect();
    all.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (mut rank_sum, mut ties, mut i) = (0.0, 0.0, 0);
    while i < all.len() {
        let mut j = i;
        while j + 1 < all.len() && all[j + 1].0.total_cmp(&all[i].0).is_eq() {
            j += 1;
        }
        let rank = (i + j) as f64 / 2.0 + 1.0;
        let t = (j - i + 1) as f64;
        ties += t * t * t - t;
        rank_sum += all[i..=j].iter().filter(|(_, high)| *high).count() as f64 * rank;
        i = j + 1;
    }
    let u = rank_sum - n2 * (n2 + 1.0) / 2.0;
    let n = n1 + n2;
    let variance = n1 * n2 / 12.0 * ((n + 1.0) - ties / (n * (n - 1.0)));
    if variance <= 0.0 {
        return 1.0;
    }
    let z = (u - n1 * n2 / 2.0 - 0.5) / variance.sqrt();
    0.5 * erfc(z / std::f64::consts::SQRT_2)
}

fn erfc(x: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.5 * x.abs());
    let y = t
        * (-x * x - 1.265_512_23
            + t * (1.000_023_68
                + t * (0.374_091_96
                    + t * (0.096_784_18
                        + t * (-0.186_288_06
                            + t * (0.278_868_07
                                + t * (-1.135_203_98
                                    + t * (1.488_515_87
                                        + t * (-0.822_152_23 + t * 0.170_872_77)))))))))
            .exp();
    if x >= 0.0 { y } else { 2.0 - y }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000 * DAY_NS;
    const HOUR: i64 = DAY_NS / 24;

    fn run(label: &str, hours_ago: i64, wall: f64) -> Run {
        Run {
            query_id: format!("{label}-{hours_ago}"),
            label: Some(label.into()),
            fingerprint: Some("a".into()),
            service: Some("orders-etl".into()),
            status: Status::Finished,
            started_unix_ns: NOW - hours_ago * HOUR,
            wall_ms: Some(wall),
            rules: Vec::new(),
        }
    }

    fn noisy(i: i64) -> f64 {
        [0.92, 1.05, 0.98, 1.11, 0.95, 1.02, 0.89, 1.07][usize::try_from(i % 8).unwrap()]
    }

    fn hourly(label: &str, wall: impl Fn(i64) -> f64) -> Vec<Run> {
        (1..14 * 24)
            .map(|h| run(label, h, wall(h) * noisy(h)))
            .collect()
    }

    fn window() -> Window {
        Window::local(NOW, 14, 0, 56)
    }

    fn of(runs: &[Run]) -> QueryOverview {
        overview(runs, &window()).remove(0)
    }

    #[test]
    fn a_query_that_runs_as_usual_gets_no_verdict() {
        let seen = of(&hourly("steady", |_| 300.0));
        assert_eq!(seen.verdict, None);
        assert!((seen.usual_wall_ms.unwrap() - 300.0).abs() < 30.0);
        assert_eq!(seen.plan_changed_unix_ns, None);
        assert_eq!(seen.days.len(), 14);
        assert_eq!(seen.bins.len(), 56);
    }

    #[test]
    fn a_new_plan_that_is_slower_is_reported_with_when_it_started() {
        let mut runs = hourly("mix", |h| if h <= 40 { 1_900.0 } else { 310.0 });
        for run in runs
            .iter_mut()
            .filter(|run| run.started_unix_ns >= NOW - 40 * HOUR)
        {
            run.fingerprint = Some("b".into());
            run.rules = vec!["python_udf".into()];
        }
        let seen = of(&runs);
        assert_eq!(seen.verdict, Some(Verdict::Slower));
        assert!(seen.ratio.unwrap() > 5.0);
        assert_eq!(seen.plan_changed_unix_ns, Some(NOW - 40 * HOUR));
        assert_eq!(seen.new_rules, ["python_udf"]);
        assert_eq!(seen.new_rules_since_unix_ns, Some(NOW - 40 * HOUR));
    }

    #[test]
    fn one_slow_run_is_not_a_slowdown() {
        let seen = of(&hourly("dedupe", |h| if h == 3 { 4_000.0 } else { 640.0 }));
        assert_eq!(seen.verdict, None);
    }

    #[test]
    fn a_query_that_runs_twice_a_day_is_judged_on_its_last_three_runs() {
        let runs: Vec<Run> = (0..28)
            .map(|i| {
                run(
                    "cohorts",
                    3 + i * 12,
                    if i < 3 { 1_400.0 } else { 600.0 * noisy(i) },
                )
            })
            .collect();
        let seen = of(&runs);
        assert_eq!(seen.verdict, Some(Verdict::Slower));
        assert_eq!(seen.recent_runs, 2);
    }

    #[test]
    fn faster_is_reported_too() {
        let seen = of(&hourly("pages", |h| if h <= 30 { 200.0 } else { 410.0 }));
        assert_eq!(seen.verdict, Some(Verdict::Faster));
    }

    #[test]
    fn too_few_runs_get_no_verdict() {
        let runs: Vec<Run> = (0..5)
            .map(|i| run("rare", i * 30, if i < 3 { 900.0 } else { 100.0 }))
            .collect();
        assert_eq!(of(&runs).verdict, None);
    }

    #[test]
    fn failures_of_the_last_day_are_counted_against_those_before() {
        let mut runs = hourly("stats", |_| 24.0);
        for run in runs
            .iter_mut()
            .filter(|run| run.started_unix_ns >= NOW - 10 * HOUR)
            .step_by(2)
        {
            run.status = Status::Failed;
        }
        let seen = of(&runs);
        assert_eq!((seen.recent_failed, seen.failed_before), (5, 0));
        assert_eq!(seen.recent_runs, 24);
        assert_eq!(seen.first_recent_failure_unix_ns, Some(NOW - 9 * HOUR));
    }

    #[test]
    fn failed_runs_with_another_plan_are_not_a_plan_change() {
        let mut runs = hourly("stats", |_| 24.0);
        for run in runs
            .iter_mut()
            .filter(|run| run.started_unix_ns >= NOW - 10 * HOUR)
            .step_by(2)
        {
            run.status = Status::Failed;
            run.fingerprint = Some("broken".into());
        }
        assert_eq!(of(&runs).plan_changed_unix_ns, None);
    }

    #[test]
    fn days_follow_the_local_clock() {
        let window = Window::local(NOW + 2 * HOUR, 3, 120, 6);
        assert_eq!(
            window.days,
            [
                NOW - 2 * DAY_NS - 2 * HOUR,
                NOW - DAY_NS - 2 * HOUR,
                NOW - 2 * HOUR
            ]
        );
    }

    #[test]
    fn versions_list_each_plan_newest_first_with_its_usual_time() {
        let mut runs = hourly("mix", |h| if h <= 10 { 1_000.0 } else { 100.0 });
        for run in runs
            .iter_mut()
            .filter(|run| run.started_unix_ns >= NOW - 10 * HOUR)
        {
            run.fingerprint = Some("b".into());
        }
        let found = versions(&runs);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].fingerprint.as_deref(), Some("b"));
        assert_eq!(found[0].runs, 10);
        assert_eq!(found[0].latest_query_id, "mix-1");
        assert!(found[1].usual_wall_ms.unwrap() < 120.0);
    }

    #[test]
    fn the_test_tells_a_shift_from_noise() {
        let low: Vec<f64> = (0..50).map(|i| 100.0 * noisy(i)).collect();
        let high: Vec<f64> = (0..3).map(|i| 300.0 * noisy(i)).collect();
        assert!(larger(&low, &high) < 0.01);
        assert!(larger(&low, &low[..3]) > 0.1);
    }
}
