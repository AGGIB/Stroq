// The text of a call's input, for finding the keys in it.
/**
 * Every string of a call's input, the names of its fields too, however deep it is nested: one
 * stack of its own and no recursion, so an input nested past what `JSON.stringify` can print (a
 * field the host passes on unread) neither throws nor hides the key beside it.
 */
export function inputText(input: unknown): string {
  const out: string[] = [];
  const pending: unknown[] = [input];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'string') out.push(next);
    else if (Array.isArray(next))
      for (let i = next.length - 1; i >= 0; i -= 1) pending.push(next[i]);
    else if (next !== null && typeof next === 'object') {
      const entries = Object.entries(next as Record<string, unknown>);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const [name, value] = entries[i] as [string, unknown];
        pending.push(value, name);
      }
    }
  }
  return out.join('\n');
}
