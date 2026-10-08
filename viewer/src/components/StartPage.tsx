import type { Example } from "../hooks/useSessions";
import Code from "./Code";

const EXAMPLES: Example[] = [
  { file: "tpch-sf1.jsonl", title: "Scale factor 1" },
  { file: "tpch-sf10.jsonl", title: "Scale factor 10" },
];

export default function StartPage({ onChoose, onExample }: { onChoose: () => void; onExample: (e: Example) => void }) {
  return (
    <div className="blank">
      <h3>Nothing loaded</h3>
      <p>Profiles stay in this browser. Nothing is uploaded.</p>
      <button className="zone" onClick={onChoose}>
        <div className="big">Drop a <code>.jsonl</code> session here, or click to choose one</div>
        <div className="small">several files at once is fine</div>
      </button>
      <div className="examples">
        <span>Or try it with TPC-H, 22 queries run three times each:</span>
        {EXAMPLES.map((e) => (
          <button key={e.file} className="btn" onClick={() => onExample(e)}>{e.title}</button>
        ))}
      </div>
      <Code block code={`import polars_telemetry
from polars_telemetry.export.file import FileExporter

polars_telemetry.install(exporter=FileExporter("profiles/session.jsonl"))`} />
    </div>
  );
}
