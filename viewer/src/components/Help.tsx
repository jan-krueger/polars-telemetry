import { GLOSSARY } from "../lib/glossary";
import Tip, { TipText } from "./Tip";

/** A `?` that explains a counter or diagnostic, on hover or keyboard focus. */
export default function Help({ term, extra }: { term: string; extra?: string }) {
  const g = GLOSSARY[term];
  if (!g) return null;
  return (
    <Tip content={<TipText term={g[0]} note={extra ? `Here: ${extra}.` : null}>{g[1]}</TipText>}>
      <span className="help" tabIndex={0} aria-label={`What is ${g[0]}?`}>?</span>
    </Tip>
  );
}
