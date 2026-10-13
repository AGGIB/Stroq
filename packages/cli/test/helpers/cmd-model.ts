/**
 * How Windows starts a hook line for a host that runs `cmd.exe /d /c <line>` through a library that escapes
 * its arguments as the C runtime reads them (Go's `syscall.EscapeArg`, libuv's `quote_cmd_arg`, Rust's
 * `Command`). Two steps, written from `cmd /?` and checked against the one failure that was reported:
 *
 *   `'\"C:\Program Files\nodejs\node.exe\"' is not recognized as an internal or external command`
 *
 * which is what the line Stroq used to write for Antigravity came to. Nothing here has been run on Windows; it
 * is the model the unit tests use to say that a line survives the two steps, and `init` runs the real thing on
 * the machine before it writes a line (see `chooseHookCommand`).
 */

/** Go's `syscall.EscapeArg`: a quote becomes `\"`, the backslashes before it are doubled, and an argument with a blank is wrapped. */
export function escapeArg(arg: string): string {
  if (arg === '') return '""';
  const needsBackslash = /["\\]/.test(arg);
  const hasSpace = /[ \t]/.test(arg);
  if (!needsBackslash && !hasSpace) return arg;
  if (!needsBackslash) return `"${arg}"`;
  let out = hasSpace ? '"' : '';
  let slashes = 0;
  for (const c of arg) {
    if (c === '\\') slashes += 1;
    else if (c === '"') {
      out += '\\'.repeat(slashes + 1);
      slashes = 0;
    } else slashes = 0;
    out += c;
  }
  if (hasSpace) out += `${'\\'.repeat(slashes)}"`;
  return out;
}

const SPECIAL = /[&<>()@^|]/;

/**
 * What `cmd.exe` runs of the text after `/c`: the old rule of `cmd /?`, which strips the first quote and the
 * last one, unless the text is exactly one quoted name of an executable file.
 */
export function afterSlashC(rest: string, isExecutable: (name: string) => boolean): string {
  const text = rest.trimStart();
  if (!text.startsWith('"')) return text;
  const quotes = [...text].filter((c) => c === '"').length;
  const last = text.lastIndexOf('"');
  const between = text.slice(1, last);
  if (quotes === 2 && !SPECIAL.test(between) && /\s/.test(between) && isExecutable(between))
    return text;
  return text.slice(1, last) + text.slice(last + 1);
}

/** The first word of a line as `cmd.exe` reads it: a quote opens a span in which a blank does not end the word. */
export function firstWord(line: string): string {
  let inQuote = false;
  let word = '';
  for (const c of line.trimStart()) {
    if (c === '"') inQuote = !inQuote;
    else if (!inQuote && /[\s,;=]/.test(c)) break;
    word += c;
  }
  return word;
}

export interface Machine {
  /** Files that exist, spelled in lower case with backslashes. */
  readonly files: ReadonlySet<string>;
  /** Names that the search path finds (`node`). */
  readonly onPath?: ReadonlySet<string>;
}

export type Started =
  | { readonly ok: true; readonly program: string }
  | { readonly ok: false; readonly message: string };

const asFile = (name: string): string =>
  name.replaceAll('"', '').replaceAll('/', '\\').toLowerCase();

/** Whether the line starts a program, the way Windows starts it for such a host. */
export function startsProgram(line: string, machine: Machine): Started {
  const isFile = (name: string): boolean => machine.files.has(asFile(name));
  const run = afterSlashC(escapeArg(line), isFile);
  const word = firstWord(run);
  const name = asFile(word);
  const found = /[\\/]/.test(name)
    ? isFile(word)
    : (machine.onPath ?? new Set<string>()).has(name.replace(/\.exe$/, ''));
  return found
    ? { ok: true, program: word }
    : {
        ok: false,
        message: `'${word}' is not recognized as an internal or external command, operable program or batch file.`,
      };
}
