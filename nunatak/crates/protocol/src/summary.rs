use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Summary {
    pub label: Option<String>,
    pub fingerprint: Option<String>,
    pub started_unix_ns: Option<i64>,
    pub wall_ms: Option<f64>,
    pub cpu_ms: Option<f64>,
    pub result_rows: Option<i64>,
    pub failed: Option<String>,
    pub warnings: u32,
}

#[derive(Deserialize)]
struct Line {
    profile: Option<Profile>,
}

#[derive(Deserialize)]
struct Profile {
    label: Option<Value>,
    fingerprint: Option<Value>,
    started_unix_ns: Option<Value>,
    wall_ms: Option<Value>,
    cpu_ms: Option<Value>,
    result_rows: Option<Value>,
    failed: Option<Value>,
    insights: Option<Insights>,
}

#[derive(Deserialize)]
struct Insights {
    findings: Option<Vec<Finding>>,
}

#[derive(Deserialize)]
struct Finding {
    level: Option<Value>,
}

impl Summary {
    #[must_use]
    pub fn of(line: &str) -> Option<Self> {
        let profile = serde_json::from_str::<Line>(line).ok()?.profile?;
        let text = |value: Option<Value>| match value {
            Some(Value::String(text)) => Some(text),
            _ => None,
        };
        let warnings = profile
            .insights
            .and_then(|insights| insights.findings)
            .map_or(0, |findings| {
                findings
                    .iter()
                    .filter(|f| f.level.as_ref().and_then(Value::as_str) == Some("warn"))
                    .count()
            });
        Some(Self {
            label: text(profile.label),
            fingerprint: text(profile.fingerprint),
            started_unix_ns: profile.started_unix_ns.as_ref().and_then(Value::as_i64),
            wall_ms: profile.wall_ms.as_ref().and_then(Value::as_f64),
            cpu_ms: profile.cpu_ms.as_ref().and_then(Value::as_f64),
            result_rows: profile.result_rows.as_ref().and_then(Value::as_i64),
            failed: text(profile.failed),
            warnings: u32::try_from(warnings).unwrap_or(u32::MAX),
        })
    }
}
