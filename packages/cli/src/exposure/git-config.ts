// Git's configuration format, read as git reads it: the parser every config is judged with.
// It lived in `repo-surface.ts`, which still exports both functions.

/** A git config larger than this is not read: it is reported as unread. */
export const MAX_CONFIG_BYTES = 256 * 1024;

/**
 * Parses git's INI into dotted keys, the way git reads it (see `parseGitConfig`): no tool's view of
 * the file but git's, and no shelling out to `git config`, which would read the repository's
 * configuration to read it.
 */
export function gitConfigEntries(text: string): readonly { key: string; value: string }[] {
  return parseGitConfig(text).entries;
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isAlpha = (c: string): boolean => /^[A-Za-z]$/.test(c);
/** A character of a key or a section name as git takes it: a letter, a digit or `-`. */
const isKeyChar = (c: string): boolean => /^[A-Za-z0-9-]$/.test(c);

/** The escapes git takes in a value; any other one makes the file one git refuses. */
const VALUE_ESCAPES: Readonly<Record<string, string>> = {
  t: '\t',
  b: '\b',
  n: '\n',
  '\\': '\\',
  '"': '"',
};

/** A git config read one character at a time, with the line each one is on. */
class ConfigReader {
  private at: number;
  private line = 1;
  /** The line of the last character read. */
  lineOfLast = 1;
  constructor(private readonly text: string) {
    this.at = text.startsWith('\uFEFF') ? 1 : 0;
  }

  get done(): boolean {
    return this.at >= this.text.length;
  }

  /** The next character; `\r\n` and the end of the file read as a newline, as git reads them. */
  next(): string {
    this.lineOfLast = this.line;
    if (this.done) return '\n';
    let c = this.text[this.at] as string;
    this.at += 1;
    if (c === '\r' && this.text[this.at] === '\n') {
      c = '\n';
      this.at += 1;
    }
    if (c === '\n') this.line += 1;
    return c;
  }
}

/** A section header after its `[`: `[core]`, `[remote "a\"b"]`, `[a.b]`; undefined when git refuses it. */
function readSection(r: ConfigReader): string | undefined {
  let name = '';
  for (;;) {
    if (r.done) return undefined;
    let c = r.next();
    if (c === ']') return name === '' ? undefined : name;
    if (isSpace(c)) {
      // `[name "subsection"]`: blanks, a quoted name whose `\` takes the next character, then `]`.
      for (; isSpace(c); c = r.next()) if (c === '\n' || r.done) return undefined;
      if (c !== '"' || name === '') return undefined;
      let sub = '';
      for (;;) {
        c = r.next();
        if (c === '\n') return undefined;
        if (c === '"') break;
        if (c === '\\') {
          c = r.next();
          if (c === '\n') return undefined;
        }
        sub += c;
      }
      return r.next() === ']' ? `${name}.${sub}` : undefined;
    }
    if (!isKeyChar(c) && c !== '.') return undefined;
    name += c.toLowerCase();
  }
}

/** A value after its `=`, to the end of its line, as git reads it; undefined when git refuses it. */
function readValue(r: ConfigReader): string | undefined {
  let value = '';
  let quote = false;
  let comment = false;
  let blanks = 0;
  for (;;) {
    let c = r.next();
    if (c === '\n') return quote ? undefined : value;
    if (comment) continue;
    if (isSpace(c) && !quote) {
      if (value !== '') blanks += 1;
      continue;
    }
    if (!quote && (c === ';' || c === '#')) {
      comment = true;
      continue;
    }
    value += ' '.repeat(blanks);
    blanks = 0;
    if (c === '\\') {
      c = r.next();
      // A value goes on past the end of its line only here, never from a comment.
      if (c === '\n') continue;
      const escaped = VALUE_ESCAPES[c];
      if (escaped === undefined) return undefined;
      value += escaped;
      continue;
    }
    if (c === '"') {
      quote = !quote;
      continue;
    }
    value += c;
  }
}

/**
 * The entries of a git config, read as git reads them: comments and blanks between entries, a
 * section header with a quoted subsection whose `\` takes the next character, a key on the line of
 * its section, a value with quotes, comments and escapes, continued past the end of its line only
 * by a `\` inside the value. Keys and plain section names are in lower case, as git takes them.
 *
 * Git refuses a whole file it cannot read, and runs none of it; a reader that is wrong about a line
 * would skip a key git runs. So the first line git would refuse ends the reading and is reported in
 * `unplaced`, with what was read before it.
 */
export function parseGitConfig(text: string): {
  readonly entries: readonly { key: string; value: string }[];
  readonly unplaced: readonly number[];
} {
  const entries: { key: string; value: string }[] = [];
  const r = new ConfigReader(text);
  const refused = () => ({ entries, unplaced: [r.lineOfLast] });
  let section: string | undefined;
  let comment = false;
  while (!r.done) {
    const c = r.next();
    if (c === '\n') {
      comment = false;
      continue;
    }
    if (comment || isSpace(c)) continue;
    if (c === '#' || c === ';') {
      comment = true;
      continue;
    }
    if (c === '[') {
      section = readSection(r);
      if (section === undefined) return refused();
      continue;
    }
    if (!isAlpha(c) || section === undefined) return refused();
    let name = c.toLowerCase();
    let d = r.next();
    for (; isKeyChar(d); d = r.next()) name += d.toLowerCase();
    while (d === ' ' || d === '\t') d = r.next();
    if (d === '\n') {
      entries.push({ key: `${section}.${name}`, value: 'true' });
      continue;
    }
    if (d !== '=') return refused();
    const value = readValue(r);
    if (value === undefined) return refused();
    entries.push({ key: `${section}.${name}`, value });
  }
  return { entries, unplaced: [] };
}
