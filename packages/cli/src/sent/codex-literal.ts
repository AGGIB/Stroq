/**
 * Reading the object literal Codex passes to a tool inside a rollout's `input`.
 *
 * Codex does not record tool arguments as JSON. A `custom_tool_call` carries a
 * fragment of JavaScript — `const r = await tools.exec_command({cmd:"git status",
 * workdir:"/w"})` — and the argument is a JS object literal, not a JSON document.
 * Measured on the 73 rollouts this was written against: of 2,449 literals, 430
 * parse as JSON and 2,019 do not. `JSON.parse` answers for 18% of the corpus, so
 * the shell command in the other 82% would never reach the classifier.
 *
 * This is a reader for the literal subset only — no identifiers, no calls, no
 * arithmetic. Anything outside it returns `null` rather than a partial object,
 * because the caller's fallback (keep the raw source text, which is scanned in
 * full) is strictly better than a half-read object that silently drops the field
 * the credential was in.
 */

/** Deep enough for any recorded argument; a cap at all so a hostile rollout cannot recurse. */
const MAX_DEPTH = 64;

export interface LiteralRead {
  readonly value: unknown;
  /** Index just past the literal's closing brace or bracket. */
  readonly end: number;
}

class Unreadable extends Error {}

/**
 * Declared rather than assigned to a const: TypeScript only treats a call as
 * unreachable-after when the callee is a function declaration or an explicitly
 * typed variable, and every `fail()` below is relied on to narrow what follows.
 */
function fail(): never {
  throw new Unreadable();
}

/**
 * Reads the literal starting at `start`, which must be `{` or `[`.
 *
 * Returns `null` when the text is not a literal this reader understands.
 */
export function readObjectLiteral(src: string, start: number): LiteralRead | null {
  let i = start;
  let depth = 0;

  /** Whitespace and the commas that separate entries, which may be repeated or trailing. */
  const skip = (): void => {
    while (i < src.length && (src[i] === ',' || /\s/.test(src[i] as string))) i += 1;
  };

  /**
   * Whitespace only. Used between a key and what follows it, where the comma is
   * the thing being looked for: `skip` would eat it and turn the shorthand in
   * `{calendar_id, time_min:"…"}` into an unreadable literal.
   */
  const skipSpace = (): void => {
    while (i < src.length && /\s/.test(src[i] as string)) i += 1;
  };

  const ESCAPES: Readonly<Record<string, string>> = {
    n: '\n',
    t: '\t',
    r: '\r',
    b: '\b',
    f: '\f',
    v: '\v',
    '0': '\0',
  };

  function readString(quote: string): string {
    i += 1;
    let out = '';
    while (i < src.length) {
      const c = src[i] as string;
      if (c === '\\') {
        const next = src[i + 1];
        if (next === undefined) fail();
        if (next === '\n') {
          i += 2;
          continue;
        }
        if (next === 'u') {
          if (src[i + 2] === '{') {
            const close = src.indexOf('}', i + 3);
            if (close < 0) fail();
            const code = Number.parseInt(src.slice(i + 3, close), 16);
            if (Number.isNaN(code)) fail();
            out += String.fromCodePoint(code);
            i = close + 1;
            continue;
          }
          const code = Number.parseInt(src.slice(i + 2, i + 6), 16);
          if (Number.isNaN(code)) fail();
          out += String.fromCharCode(code);
          i += 6;
          continue;
        }
        if (next === 'x') {
          const code = Number.parseInt(src.slice(i + 2, i + 4), 16);
          if (Number.isNaN(code)) fail();
          out += String.fromCharCode(code);
          i += 4;
          continue;
        }
        out += ESCAPES[next] ?? next;
        i += 2;
        continue;
      }
      if (c === quote) {
        i += 1;
        return out;
      }
      /* An interpolation cannot be evaluated without running the script, so the
         source is kept verbatim: a credential spliced into a template is still
         found by a scan of the text, and a reader that gave up here would lose
         every sibling field as well. */
      if (quote === '`' && c === '$' && src[i + 1] === '{') {
        let braces = 0;
        const from = i;
        while (i < src.length) {
          const t = src[i] as string;
          if (t === '{') braces += 1;
          else if (t === '}') {
            braces -= 1;
            if (braces === 0) {
              i += 1;
              break;
            }
          }
          i += 1;
        }
        if (braces !== 0) fail();
        out += src.slice(from, i);
        continue;
      }
      out += c;
      i += 1;
    }
    return fail();
  }

  function readKey(): string {
    skip();
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') return readString(c);
    const name = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (!name) fail();
    i += name[0].length;
    return name[0];
  }

  function readValue(): unknown {
    skip();
    if (i >= src.length) fail();
    const c = src[i] as string;
    if (c === '{') return readObject();
    if (c === '[') return readArray();
    if (c === '"' || c === "'" || c === '`') return readString(c);
    const rest = src.slice(i);
    /* `undefined` reads as null: the field was passed and had no value, which is
       what null means everywhere else in a transcript. */
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
      ['undefined', null],
    ] as const) {
      if (rest.startsWith(word) && !/[\w$]/.test(rest[word.length] ?? '')) {
        i += word.length;
        return value;
      }
    }
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    return fail();
  }

  function readObject(): Record<string, unknown> {
    depth += 1;
    if (depth > MAX_DEPTH) fail();
    i += 1;
    const out: Record<string, unknown> = {};
    for (;;) {
      skip();
      if (i >= src.length) fail();
      if (src[i] === '}') {
        i += 1;
        depth -= 1;
        return out;
      }
      /* `{...base, title:"x"}` — the spread's contents are not in the rollout, so
         the name it spreads is skipped and the explicit fields are still read. */
      if (src.startsWith('...', i)) {
        i += 3;
        const name = /^[A-Za-z_$][\w$.]*/.exec(src.slice(i));
        if (!name) fail();
        i += name[0].length;
        continue;
      }
      const key = readKey();
      skipSpace();
      if (src[i] === ':') {
        i += 1;
        out[key] = readValue();
        continue;
      }
      /* `{calendar_id, time_min:"…"}` — a shorthand property. The name is still
         evidence that the call carried that field; only its value is unknown. */
      if (src[i] === '}' || src[i] === ',') {
        out[key] = null;
        continue;
      }
      fail();
    }
  }

  function readArray(): unknown[] {
    depth += 1;
    if (depth > MAX_DEPTH) fail();
    i += 1;
    const out: unknown[] = [];
    for (;;) {
      skip();
      if (i >= src.length) fail();
      if (src[i] === ']') {
        i += 1;
        depth -= 1;
        return out;
      }
      out.push(readValue());
    }
  }

  const opening = src[start];
  if (opening !== '{' && opening !== '[') return null;
  try {
    const value = readValue();
    return { value, end: i };
  } catch (err) {
    if (err instanceof Unreadable) return null;
    /* A RangeError from a pathological nesting the depth cap did not catch is the
       same answer to the caller: unreadable. Anything else is a bug here. */
    if (err instanceof RangeError) return null;
    throw err;
  }
}
