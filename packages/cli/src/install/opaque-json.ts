/** JSON has already been validated. Keep a top-level member's original bytes, including numbers
 * JavaScript cannot represent and keys that a schema's record parser might otherwise drop. */
export function rawMember(text: string, wanted: string): string | undefined {
  const skipSpace = (at: number): number => {
    while (/\s/.test(text[at] ?? '') && at < text.length) at += 1;
    return at;
  };
  const stringEnd = (at: number): number => {
    for (let i = at + 1; i < text.length; i += 1) {
      if (text[i] === '\\') i += 1;
      else if (text[i] === '"') return i + 1;
    }
    throw new Error('unterminated JSON string');
  };
  const valueEnd = (at: number): number => {
    let depth = 0;
    for (let i = at; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '"') i = stringEnd(i) - 1;
      else if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        if (depth === 0) return i;
        depth -= 1;
      } else if (ch === ',' && depth === 0) return i;
    }
    return text.length;
  };
  let result: string | undefined;
  let at = skipSpace(text.indexOf('{') + 1);
  while (text[at] === '"') {
    const keyEnd = stringEnd(at);
    const key: unknown = JSON.parse(text.slice(at, keyEnd));
    const start = skipSpace(skipSpace(keyEnd) + 1);
    const end = valueEnd(start);
    if (key === wanted) result = text.slice(start, end).trimEnd();
    at = skipSpace(end);
    if (text[at] !== ',') break;
    at = skipSpace(at + 1);
  }
  return result;
}
