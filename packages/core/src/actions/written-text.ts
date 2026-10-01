/**
 * The text a write replaces rather than writes: an `Edit`'s `old_string`, Copilot's
 * `old_str`, Antigravity's `TargetContent`. Scanning it would ask about removing an
 * injection, the opposite of saving one.
 */
const REPLACED_TEXT_KEYS: ReadonlySet<string> = new Set(['old_string', 'old_str', 'TargetContent']);
const MAX_WRITTEN_DEPTH = 4;

/**
 * Every string a write carries, at any key, except the text it replaces. A list of the
 * keys agents are known to use was the first version, and a security review found
 * Antigravity's `create_file` sending its text as `CodeContent`, outside it — so the
 * payload was never scanned for a whole agent, and Cursor's field is undocumented.
 * Missing a key is a bypass; scanning a path or a flag is at worst a question. A Bash
 * command is its own text: the payload of `echo … >> CLAUDE.md` is in it.
 */
export function writtenTexts(toolInput: Readonly<Record<string, unknown>>): string[] {
  const texts: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (typeof value === 'string') texts.push(value);
    else if (depth >= MAX_WRITTEN_DEPTH || value === null || typeof value !== 'object') return;
    else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
    else
      for (const [key, item] of Object.entries(value))
        if (!REPLACED_TEXT_KEYS.has(key)) walk(item, depth + 1);
  };
  walk(toolInput, 0);
  return texts;
}

export function writtenText(toolInput: Readonly<Record<string, unknown>>): string {
  return writtenTexts(toolInput).join('\n');
}

const MAX_QUOTED_TEXTS = 64;

/**
 * The texts a shell command may be writing: the command itself, which holds a heredoc
 * body as its lines, and each quoted string in it, which is what `echo '…' > file` and
 * `printf '[core]\n\tfsmonitor = x' > file` write (with `\n` and `\t`, which `printf` and
 * `echo -e` turn into the characters, turned into them). At most `MAX_QUOTED_TEXTS` of
 * them; a command that quotes more is mostly not writing one file.
 */
export function commandTexts(command: string): string[] {
  const texts = [command];
  for (const inner of quotedSpans(command)) {
    if (inner.length < 4) continue;
    texts.push(inner.replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
    if (texts.length > MAX_QUOTED_TEXTS) break;
  }
  return texts;
}

/**
 * The quoted strings of a command, in one pass. A global regular expression retried from
 * every `"` of a string that never closes, which took 0.9 s on 64 KiB of `\"!`; this stops
 * at the first quote that does not close.
 */
function quotedSpans(command: string): string[] {
  const spans: string[] = [];
  let i = 0;
  while (i < command.length) {
    const ch = command.charAt(i);
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) break;
      spans.push(command.slice(i + 1, end));
      i = end + 1;
    } else if (ch === '"') {
      let end = i + 1;
      while (end < command.length && command.charAt(end) !== '"') {
        end += command.charAt(end) === '\\' ? 2 : 1;
      }
      if (end >= command.length) break;
      spans.push(command.slice(i + 1, end));
      i = end + 1;
    } else {
      i += 1;
    }
  }
  return spans;
}
