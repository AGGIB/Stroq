import type { Stage } from './shell-lex.js';
import {
  decodeEscapes,
  escapeLength,
  expandHeredoc,
  hasAmbiguousOctal,
  heredocExpands,
} from './shell-escapes.js';
import {
  PLAIN_WRAPPERS,
  REDIRECT,
  withoutRedirects,
  type Resolved,
  type Word,
} from './shell-words.js';

/**
 * What a stage hands to the next one: the text `echo` and `printf` print, the text a here-string
 * or here-document gives to `cat`, and the files `cat`, `head` and the like pass on. The question
 * asked of each is the same: is the text the stage prints the text the command line says? When it
 * depends on a variable, a substitution, a glob or a brace expansion, it is not, and that is said.
 */
export interface Printed {
  readonly text: string;
  /** The words printed expand: a variable, a substitution, a glob or a brace is in what they say. */
  readonly dynamic: boolean;
  /** What is printed is not known: a format this does not model, an escape shells read differently. */
  readonly unknown: boolean;
}

/** The most one `printf` may print before it is called unreadable. */
const MAX_PRINTF_CHARS = 1_000_000;
/** The most times a `printf` format is reused for the arguments left. */
const MAX_PRINTF_ROUNDS = 1024;
/** How far into a format a conversion is read: a flag, a width, a precision and a letter. */
const SPEC_LOOKAHEAD = 32;

const UNREADABLE: Printed = { text: '', dynamic: false, unknown: true };

/**
 * What one conversion of a `printf` format prints for its argument; a conversion this does not
 * model is `null`. `%b` reads the argument's escapes, and a shell reads `\155` (an octal with no
 * leading 0) in its own way: bash and dash decode it, zsh does not, so what it prints is not known.
 */
function convert(conv: string, arg: string): string | null {
  if (conv === 's') return arg;
  if (conv === 'b') return hasAmbiguousOctal(arg) ? null : decodeEscapes(arg, 'echo');
  if (conv === 'c') return arg.charAt(0);
  return null;
}

/** A conversion with a flag, a width, a precision or a `*`: it pads, cuts or takes an argument for them. */
const MODIFIED_SPEC = /^%[-+ #0-9.*']+[a-zA-Z]/;
/** A bare conversion: `%s`, `%b`, `%c` and `%%`. */
const BARE_SPEC = /^%[sbc%]/;

/** What a `printf` format prints in one round, taking arguments from `from`: null if it grows too large. */
function printfRound(
  format: string,
  args: readonly string[],
  from: number,
  room: { left: number },
): { readonly text: string; readonly used: number; readonly unknown: boolean } | null {
  const parts: string[] = [];
  let used = from;
  let unknown = false;
  const push = (piece: string): boolean => {
    room.left -= piece.length;
    parts.push(piece);
    return room.left >= 0;
  };
  for (let i = 0; i < format.length; i += 1) {
    const ch = format.charAt(i);
    const head = ch === '%' ? format.slice(i, i + SPEC_LOOKAHEAD) : '';
    let piece = ch;
    if (ch === '\\' && i + 1 < format.length) {
      // A backslash escape is the format's own: decoded here, so `\x25s` is a percent sign and an `s`.
      const length = escapeLength(format, i, 'printf');
      piece = decodeEscapes(format.slice(i, i + length), 'printf');
      i += length - 1;
    } else if (BARE_SPEC.test(head)) {
      const conv = head.charAt(1);
      i += 1;
      if (conv === '%') piece = '%';
      else {
        const printed = convert(conv, args[used] ?? '');
        used += 1;
        unknown ||= printed === null;
        piece = printed ?? '';
      }
    } else if (ch === '%') {
      // `%5s`, `%.2s`, `%*s`, `%d`: what they print is not the argument, and `*` takes arguments of
      // its own, so the text is not known. The conversion is skipped, with its letter.
      unknown = true;
      const modified = MODIFIED_SPEC.exec(head);
      if (modified !== null) i += modified[0].length - 1;
    }
    if (!push(piece)) return null;
  }
  return { text: parts.join(''), used, unknown };
}

/**
 * What `printf FORMAT ARG…` prints, or unreadable when it prints more than is worth building: the
 * arguments substituted for the conversions, the format reused while any are left, the output
 * bounded as it grows. Only `%s`, `%b`, `%c` and `%%` are read; any other conversion is a number
 * or something this does not model. Escapes are the format's own, and those of `%b`: an escape in
 * a `%s` argument is not decoded, as printf does not.
 */
function printfOutput(format: string, args: readonly string[]): Printed {
  const room = { left: MAX_PRINTF_CHARS };
  const texts: string[] = [];
  let used = 0;
  let unknown = false;
  for (let round = 0; round < MAX_PRINTF_ROUNDS; round += 1) {
    const done = printfRound(format, args, used, room);
    if (done === null) return UNREADABLE;
    texts.push(done.text);
    unknown ||= done.unknown;
    // A format with conversions is reused until the arguments run out; one without prints once.
    if (done.used === used || done.used >= args.length)
      return { text: texts.join(''), dynamic: false, unknown };
    used = done.used;
  }
  return UNREADABLE;
}

/** Whether any of the words expands before the command sees it. */
const anyExpands = (words: readonly Word[]): boolean => words.some((w) => w.expands);

/** What an `echo` or `printf` stage prints, or null when the stage is neither. */
export function printed(command: Resolved): Printed | null {
  if (command.name !== 'echo' && command.name !== 'printf') return null;
  // `xargs echo`, `watch echo`: the words are not what is printed, so what comes out is not known.
  if (command.wrappers.some((w) => !PLAIN_WRAPPERS.has(w))) return UNREADABLE;
  const args = withoutRedirects(command.args);
  const dynamic = anyExpands(args);
  if (command.name === 'echo') {
    let first = 0;
    while (first < args.length && /^-[neE]+$/.test((args[first] as Word).value)) first += 1;
    const written = args
      .slice(first)
      .map((w) => w.value)
      .join(' ');
    // `echo '\155'` prints `m` in dash and the escape itself in bash and zsh: not known.
    return {
      text: decodeEscapes(written, 'echo'),
      dynamic,
      unknown: hasAmbiguousOctal(written),
    };
  }
  const values = args.map((w) => w.value);
  const operands = values[0] === '--' ? values.slice(1) : values;
  // `printf -v var …` prints nothing; any other option is not one this reads.
  if ((operands[0] ?? '').startsWith('-') && operands[0] !== '-') return UNREADABLE;
  const [format, ...rest] = operands;
  const output = printfOutput(format ?? '', rest);
  return { text: output.text, dynamic, unknown: output.unknown };
}

/** The text a here-string or here-document gives to a stage that only passes it on (`cat <<< 'x'`). */
export function givenText(stage: Stage, command: Resolved): Printed | null {
  if (command.name !== 'cat' && command.name !== 'tee') return null;
  if (stage.heredoc !== null) {
    const { body, quoted } = stage.heredoc;
    return {
      text: quoted ? body : expandHeredoc(body),
      dynamic: !quoted && heredocExpands(body),
      unknown: false,
    };
  }
  const words = command.args;
  const at = words.findIndex((w) => w.redirect && /^\d*<<<(?!<)/.test(w.value));
  if (at === -1) return null;
  const word = words[at] as Word;
  const glued = word.value.replace(/^\d*<<</, '');
  const target = glued !== '' ? word : words[at + 1];
  if (target === undefined) return null;
  return { text: glued !== '' ? glued : target.value, dynamic: target.expands, unknown: false };
}

/** The options of `head` and `tail` whose next word is a number, not a file: `head -n 5`. */
const NUMBER_OPTIONS: ReadonlySet<string> = new Set(['-n', '-c', '--lines', '--bytes']);
const PASS_THROUGH: ReadonlySet<string> = new Set([
  'cat',
  'head',
  'tail',
  'tac',
  'tee',
  'pv',
  'sponge',
]);
/** The commands whose file operands are written, not read: what they read is their own input. */
const WRITES_FILES: ReadonlySet<string> = new Set(['tee', 'sponge']);

export interface Reader {
  readonly files: readonly string[];
  /** A file's name expands, so the file it names is not the one the text says. */
  readonly dynamic: boolean;
  /** The stage takes its input from the stage before it, as `cat` with no file does. */
  readonly fromPipe: boolean;
}

/** The files `cat`, `head`, `tail`, `tac`, `pv` or `tee` read, and whether they read the pipe instead. */
export function reader(command: Resolved, stage: Stage): Reader | null {
  if (!PASS_THROUGH.has(command.name)) return null;
  const writes = WRITES_FILES.has(command.name);
  const takesNumber = command.name === 'head' || command.name === 'tail';
  const files: string[] = [];
  let dynamic = false;
  let ownInput = stage.heredoc !== null;
  let options = true;
  const words = command.args;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] as Word;
    const redirect = w.redirect ? REDIRECT.exec(w.value) : null;
    if (redirect !== null) {
      const glued = w.value.slice(redirect[0].length);
      const named = glued !== '' ? w : words[i + 1];
      if (glued === '') i += 1;
      const target = glued !== '' ? glued : (named?.value ?? '');
      const op = redirect[2];
      const standardInput = redirect[1] === undefined || redirect[1] === '0';
      if (standardInput && op === '<') {
        files.push(target);
        dynamic ||= named?.expands === true;
      }
      if (standardInput && (op === '<<<' || op === '<<' || op === '<<-')) ownInput = true;
      continue;
    }
    if (options && w.value === '--') options = false;
    else if (options && w.value.startsWith('-') && w.value !== '-') {
      if (takesNumber && NUMBER_OPTIONS.has(w.value)) i += 1;
      // BSD `cat` ends its options at the first file, so a `-x` after one is a file there.
      if (files.length > 0) files.push(w.value);
    } else if (!writes && w.value !== '-') {
      files.push(w.value);
      dynamic ||= w.expands;
    }
  }
  return { files, dynamic, fromPipe: files.length === 0 && !ownInput };
}
