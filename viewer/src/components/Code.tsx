import { tokenize } from "../lib/highlight";

// Blocks are dark in both themes on purpose.
export default function Code({ code, block = false }: { code: string; block?: boolean }) {
  const content = tokenize(code).map((t, i) =>
    t.kind === "text" ? t.text : <span key={i} className={`tk-${t.kind}`}>{t.text}</span>,
  );
  return block ? <pre className="code code--block">{content}</pre> : <span className="code">{content}</span>;
}
