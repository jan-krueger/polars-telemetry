import type { Dispatch, ReactNode } from "react";
import type { Session } from "../model/profile";
import { num, span, tableName } from "../lib/format";
import { title, type Action, type ShapeRow, type Sort, type SortKey } from "../state/viewer";

interface Props {
  session: Session;
  shapes: ShapeRow[];
  sort: Sort;
  dispatch: Dispatch<Action>;
}

export default function Overview({ session, shapes, sort, dispatch }: Props) {
  const widest = shapes.reduce((a, r) => Math.max(a, r.wallMs), 0) || 1;
  const totalWall = shapes.reduce((a, r) => a + r.wallMs, 0) || 1;
  const header = (by: SortKey, label: string) => <SortHeader sort={sort} by={by} dispatch={dispatch}>{label}</SortHeader>;

  return (
    <>
      <h2>{session.name}</h2>
      <div className="ovw-sum">
        {session.profiles?.length ?? 0} profiles · {shapes.length} query shape{shapes.length > 1 ? "s" : ""}
      </div>
      <table className="ovw">
        <thead><tr>
          {header("order", "#")}
          {header("name", "query")}
          {header("runs", "runs")}
          {header("wall", "total wall")}
          <th>share</th>
          {header("cpu", "mean cpu")}
          <th />
        </tr></thead>
        <tbody>
          {shapes.map((r) => {
            const first = r.runs[0]!;
            return (
              <tr key={r.fingerprint} onClick={() => dispatch({ type: "queryPicked", queryId: first.query_id })}>
                <td className="order">{r.order}</td>
                <td><div className="ovw-name">{title(first)}</div>
                  <div className="ovw-fp">{first.label && tableName(first) ? `${tableName(first)} · ` : ""}{r.fingerprint}</div></td>
                <td>{r.runs.length}</td><td>{span(r.wallMs)}</td>
                <td>{num((r.wallMs / totalWall) * 100, 1)}%</td><td>{r.cpuMs > 0 ? span(r.cpuMs / r.runs.length) : "—"}</td>
                <td className="ovw-bar">
                  <div className="bar" style={{ width: `${(r.wallMs / widest) * 100}%` }} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function SortHeader({ sort, by, dispatch, children }: { sort: Sort; by: SortKey; dispatch: Dispatch<Action>; children: ReactNode }) {
  const active = sort.key === by;
  return (
    <th aria-sort={active ? (sort.descending ? "descending" : "ascending") : "none"}>
      <button className="sorth" onClick={() => dispatch({ type: "sorted", key: by })}>
        {children}<span className="sorth-mark" aria-hidden="true">{active ? (sort.descending ? "▼" : "▲") : ""}</span>
      </button>
    </th>
  );
}
