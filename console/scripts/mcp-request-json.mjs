/** MCP actions use scalar fields only. Reject duplicate decoded keys before dispatch. */
export function parseMcpRequestJson(text) {
  const value = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid-request');
  let at = 0;
  const space = () => {
    while (/[ \t\r\n]/.test(text[at] ?? '') && at < text.length) at++;
  };
  const string = () => {
    if (text[at] !== '"') throw new Error('invalid-request');
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') at += 2;
      else if (text[at++] === '"') return JSON.parse(text.slice(start, at));
    }
    throw new Error('invalid-request');
  };
  space();
  if (text[at++] !== '{') throw new Error('invalid-request');
  space();
  const names = new Set();
  while (text[at] !== '}') {
    const key = string();
    if (names.has(key)) throw new Error('invalid-request');
    names.add(key);
    space();
    if (text[at++] !== ':') throw new Error('invalid-request');
    space();
    if (text[at] === '"') string();
    else if (text.startsWith('true', at)) at += 4;
    else if (text.startsWith('false', at)) at += 5;
    else throw new Error('invalid-request');
    space();
    if (text[at] !== ',') break;
    at++;
    space();
  }
  if (text[at++] !== '}') throw new Error('invalid-request');
  space();
  if (at !== text.length) throw new Error('invalid-request');
  return value;
}
