import { tokenize } from "../lib/highlight";

/** Highlighted code, inline or as a block. Code blocks are dark in both
 *  themes on purpose: they read as code at a glance, like an editor pane. */
export default function Code({ code, block = false }: { code: string; block?: boolean }) {
  const content = tokenize(code).map((t, i) =>
    t.kind === "text" ? t.text : <span key={i} className={`tk-${t.kind}`}>{t.text}</span>,
  );
  return block ? <pre className="code code--block">{content}</pre> : <span className="code">{content}</span>;
}
