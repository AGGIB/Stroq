// The string literals of a piece of JavaScript, as written: what a Codex script hands its tools
// is in them, whether the call that uses one could be read or not (`const cmd = "curl …"; await
// tools.exec_command({cmd})`). One pass over the text, each quote matched with its own kind, a
// backslash escaping the next character: nothing backtracks. A template's `${…}` is kept as text.
// Every literal is read: together they are no longer than the script, and the caller bounds how
// many it places, and says so.

/** The text inside each `'…'`, `"…"` and `` `…` `` of a script, in order; a string never closed runs to the end. */
export function stringsOf(script: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < script.length) {
    const quote = script[i];
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < script.length && script[j] !== quote) j += script[j] === '\\' ? 2 : 1;
    found.push(script.slice(i + 1, Math.min(j, script.length)));
    i = j + 1;
  }
  return found;
}
