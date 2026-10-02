import { GLOSSARY } from "../lib/glossary";

/** A `?` that explains a counter. Native title keeps it dependency-free and
 *  keyboard-reachable without a floating-UI layer. */
export default function Help({ term, extra }) {
  const g = GLOSSARY[term];
  if (!g) return null;
  return (
    <span className="help" tabIndex={0} title={`${g[0]} — ${g[1]}${extra ? ` Here: ${extra}.` : ""}`}>
      ?
    </span>
  );
}
