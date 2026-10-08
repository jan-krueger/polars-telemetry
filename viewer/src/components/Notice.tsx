export default function Notice({ problems, onDismiss }: { problems: string[]; onDismiss: () => void }) {
  if (!problems.length) return null;
  return (
    <div className="notice" role="alert">
      <div className="notice-text">
        <b>Not everything worked</b>
        {problems.map((r) => <div key={r}>{r}</div>)}
      </div>
      <button className="x" aria-label="Dismiss" onClick={onDismiss}>×</button>
    </div>
  );
}
