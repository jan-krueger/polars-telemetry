use serde::Deserialize;

mod summary;
use serde_json::Value;
pub use summary::Summary;

pub const SCHEMA: &str = "polars-telemetry/events@1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    Process,
    Started,
    Progress,
    Finished,
    Other(String),
}

impl Kind {
    fn of(name: &str) -> Self {
        match name {
            "process" => Self::Process,
            "query.started" => Self::Started,
            "query.progress" => Self::Progress,
            "query.finished" => Self::Finished,
            other => Self::Other(other.to_owned()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Event {
    pub seq: u64,
    pub kind: Kind,
    pub query_id: Option<String>,
    pub line: String,
}

#[derive(Debug, Clone)]
pub struct Stream {
    pub id: String,
    pub service: Option<String>,
    pub environment: Option<String>,
    pub host: String,
}

#[derive(Debug, Clone)]
pub struct Batch {
    pub stream: Stream,
    pub process: Event,
    pub events: Vec<Event>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("line {line}: {problem}")]
pub struct Invalid {
    pub line: usize,
    pub problem: String,
}

#[derive(Deserialize)]
struct Head {
    schema: Option<Value>,
    seq: Option<Value>,
    #[serde(rename = "type")]
    kind: Option<Value>,
    query_id: Option<Value>,
}

#[derive(Deserialize)]
struct ProcessFields {
    id: Option<Value>,
    service: Option<Value>,
    environment: Option<Value>,
    host: Option<Value>,
}

pub fn parse(text: &str) -> Result<Batch, Invalid> {
    let mut batches = streams(text)?;
    if batches.len() > 1 {
        let second = batches[1].first_line;
        return Err(invalid(second, "a batch holds one stream"));
    }
    Ok(batches.remove(0).batch)
}

pub fn parse_streams(text: &str) -> Result<Vec<Batch>, Invalid> {
    Ok(streams(text)?.into_iter().map(|part| part.batch).collect())
}

struct Part {
    first_line: usize,
    batch: Batch,
}

fn streams(text: &str) -> Result<Vec<Part>, Invalid> {
    let mut parts: Vec<Part> = Vec::new();
    for (index, line) in text
        .lines()
        .enumerate()
        .filter(|(_, l)| !l.trim().is_empty())
    {
        let number = index + 1;
        let event = event(number, line)?;
        if event.kind == Kind::Process {
            let stream = stream(number, &event.line)?;
            if parts
                .last()
                .is_some_and(|part| part.batch.stream.id == stream.id)
            {
                continue;
            }
            parts.push(Part {
                first_line: number,
                batch: Batch {
                    stream,
                    process: event,
                    events: Vec::new(),
                },
            });
        } else if let Some(part) = parts.last_mut() {
            part.batch.events.push(event);
        } else {
            return Err(invalid(number, "a batch starts with its process event"));
        }
    }
    if parts.is_empty() {
        return Err(invalid(1, "the batch is empty"));
    }
    Ok(parts)
}

fn event(number: usize, line: &str) -> Result<Event, Invalid> {
    let head: Head = serde_json::from_str(line)
        .map_err(|e| invalid(number, &format!("not a JSON object: {e}")))?;
    match head.schema {
        Some(Value::String(schema)) if schema == SCHEMA => {}
        Some(Value::String(schema)) => {
            return Err(invalid(number, &format!("schema {schema} is not {SCHEMA}")));
        }
        _ => return Err(invalid(number, "no schema")),
    }
    let seq = head
        .seq
        .and_then(|seq| seq.as_u64())
        .filter(|seq| *seq >= 1)
        .ok_or_else(|| invalid(number, "seq must be a whole number from 1"))?;
    let kind = match head.kind {
        Some(Value::String(kind)) => Kind::of(&kind),
        _ => return Err(invalid(number, "no type")),
    };
    let query_id = match head.query_id {
        Some(Value::String(id)) => Some(id),
        None | Some(Value::Null) => None,
        Some(_) => return Err(invalid(number, "query_id must be a string")),
    };
    if matches!(kind, Kind::Started | Kind::Progress | Kind::Finished) {
        match &query_id {
            Some(id) if is_uuid(id) => {}
            _ => return Err(invalid(number, "query_id must be a UUID")),
        }
    }
    Ok(Event {
        seq,
        kind,
        query_id,
        line: line.to_owned(),
    })
}

fn stream(number: usize, line: &str) -> Result<Stream, Invalid> {
    let fields: ProcessFields =
        serde_json::from_str(line).map_err(|e| invalid(number, &e.to_string()))?;
    let id = match fields.id {
        Some(Value::String(id)) if is_uuid(&id) => id,
        _ => return Err(invalid(number, "the process event's id must be a UUID")),
    };
    let text = |value: Option<Value>| match value {
        Some(Value::String(text)) => Some(text),
        _ => None,
    };
    Ok(Stream {
        id,
        service: text(fields.service),
        environment: text(fields.environment),
        host: text(fields.host).unwrap_or_default(),
    })
}

fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn invalid(line: usize, problem: &str) -> Invalid {
    Invalid {
        line,
        problem: problem.to_owned(),
    }
}
