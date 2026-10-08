// Enough to colour Python and polars expressions; not a parser.

export type TokenKind = "keyword" | "string" | "call" | "number" | "punct" | "text";

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set(["from", "import", "as", "with", "def", "return", "None", "True", "False"]);

// Strings first, so text inside quotes is never read as anything else.
const SCANNER = /("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|([A-Za-z_][\w]*)|(\d+(?:\.\d+)?)|(\s+)|([()[\]{}.,=:<>+\-*/])|(.)/gy;

export function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  SCANNER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCANNER.exec(code)) !== null) {
    const [whole, str, ident, num, , punct] = match;
    let kind: TokenKind = "text";
    if (str) kind = "string";
    else if (ident) {
      const next = code[SCANNER.lastIndex];
      kind = KEYWORDS.has(ident) ? "keyword" : next === "(" ? "call" : "text";
    } else if (num) kind = "number";
    else if (punct) kind = "punct";
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind && (kind === "text" || kind === "punct")) last.text += whole;
    else tokens.push({ kind, text: whole });
  }
  return tokens;
}
