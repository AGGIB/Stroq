/**
 * Whether a Python program given on a command line (`python3 -c '…'`) only reads and prints data.
 *
 * `curl … | python3 -c "import json,sys; …"` is what agents write to read a JSON answer, and it
 * looks to a pattern exactly like `curl … | python3 -c "exec(sys.stdin.read())"`, which runs what
 * was fetched. The pipe cannot tell them apart; the program can. This reads the program as Python
 * reads it (names, strings, numbers, operators) and answers `data` only when every name in it is
 * on a short list of names that cannot run anything, and no way to reach another name by a string
 * is on the list. A program it cannot read, or one that names something that is not on the list, is
 * `unknown`, and the caller asks about it. A program that names a way to run code is `exec`.
 *
 * It is a list of what is allowed and not a list of what is not, so that what it does not know is
 * not trusted: a name it has not heard of, a spelling it cannot read (a control character, a
 * letter that is not ASCII outside a string, a number run into a word), is `unknown`. Python lets
 * a program reach a name by a string only through a few doors (`getattr`, `__import__`, `eval`,
 * `exec`, `open`, `globals`, a dunder attribute, a module that has not been listed); none is on the
 * list, and every attribute after a dot has to be on it too.
 *
 * The lists below are checked against the interpreter itself in
 * `test/actions/inline-python-oracle.test.ts`, which runs programs under an audit hook and fails if
 * one this reads as `data` makes any of the events that run code, start a process, touch a file or
 * open a socket.
 */

export type ProgramVerdict = 'data' | 'exec' | 'unknown';

/** A program longer than this is not read: the answer is a question. */
const MAX_PROGRAM_CHARS = 16_384;
/** How many tokens a program may have, and how deep f-string fields may nest. */
const MAX_TOKENS = 20_000;
const MAX_FIELD_DEPTH = 4;

type Kind = 'name' | 'num' | 'str' | 'op' | 'nl';
interface Tok {
  readonly kind: Kind;
  readonly text: string;
}

// -------------------------------------------------------------------------------------------
// What a program may name
// -------------------------------------------------------------------------------------------

const set = (words: string): ReadonlySet<string> => new Set(words.split(/\s+/).filter(Boolean));

/** Keywords a data program may use. The rest (`class`, `del`, `global`, `raise`, `yield`, …) are not read. */
const KEYWORDS = set(
  `import from as for in if else elif and or not is None True False lambda def return pass while
   try except finally with continue break raise`,
);
const OTHER_KEYWORDS = set(`class del global nonlocal assert yield async await`);

/** Names that run code, start a process or reach a name by a string: the program is `exec`. */
const EXEC_NAMES = set(
  `exec eval compile __import__ system popen Popen spawn spawnl spawnle spawnlp spawnlpe spawnv
   spawnve spawnvp spawnvpe execl execle execlp execlpe execv execve execvp execvpe fork forkpty
   posix_spawn posix_spawnp startfile check_output check_call getoutput getstatusoutput subprocess
   importlib ctypes cffi pty runpy code codeop pickle cPickle marshal shelve builtins __builtins__
   os_system`,
);

/**
 * Every name Python's `builtins` module has (3.8 to 3.14), so that a name that is one and is not
 * on `ALLOWED_FREE` is never taken for a variable the program made: `if 0: open = 1` makes `open`
 * a name of the program for the reader, and not for the interpreter.
 */
const BUILTINS = set(
  `ArithmeticError AssertionError AttributeError BaseException BaseExceptionGroup BlockingIOError
   BrokenPipeError BufferError BytesWarning ChildProcessError ConnectionAbortedError ConnectionError
   ConnectionRefusedError ConnectionResetError DeprecationWarning EOFError Ellipsis EncodingWarning
   EnvironmentError Exception ExceptionGroup False FileExistsError FileNotFoundError
   FloatingPointError FutureWarning GeneratorExit IOError ImportError ImportWarning IndentationError
   IndexError InterruptedError IsADirectoryError KeyError KeyboardInterrupt LookupError MemoryError
   ModuleNotFoundError NameError None NotADirectoryError NotImplemented NotImplementedError OSError
   OverflowError PendingDeprecationWarning PermissionError ProcessLookupError PythonFinalizationError
   RecursionError ReferenceError ResourceWarning RuntimeError RuntimeWarning StopAsyncIteration
   StopIteration SyntaxError SyntaxWarning SystemError SystemExit TabError TimeoutError True
   TypeError UnboundLocalError UnicodeDecodeError UnicodeEncodeError UnicodeError
   UnicodeTranslateError UnicodeWarning UserWarning ValueError Warning WindowsError
   ZeroDivisionError abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr
   classmethod compile complex copyright credits delattr dict dir divmod enumerate eval exec exit
   filter float format frozenset getattr globals hasattr hash help hex id input int isinstance
   issubclass iter len license list locals map max memoryview min next object oct open ord pow print
   property quit range repr reversed round set setattr slice sorted staticmethod str sum super
   tuple type vars zip`,
);

/** Builtins that cannot run or reach anything. */
const ALLOWED_BUILTINS = set(
  `print len range enumerate zip map filter sorted reversed sum min max any all abs round int float
   bool str list dict set frozenset tuple repr ascii chr ord hex oct bin format divmod pow
   isinstance iter next slice bytes Exception ValueError KeyError IndexError TypeError
   AttributeError StopIteration ZeroDivisionError UnicodeDecodeError SystemExit RuntimeError`,
);

/** Modules that run nothing, by the name an `import` gives them. */
const MODULES = set(
  `sys json re datetime time math collections itertools string textwrap csv html statistics
   hashlib urllib.parse`,
);
/** The names a program may use for a module without having imported it: it then fails, and fails safe. */
const MODULE_NAMES = set(`sys json re datetime time math collections itertools string textwrap csv
  html statistics hashlib urllib`);

/**
 * Attributes a data program may use, after a dot or in `from m import a`. Every one is a name of a
 * method or a value of the types and modules above, and none runs code, starts a process, opens a
 * file, or reaches another name by a string (no `path`, `modules`, `open`, `system`, `call`, `run`,
 * `load` of a class by name, or dunder).
 */
const ATTRIBUTES = set(
  // sys and the files it holds
  `stdin stdout stderr argv exit version version_info platform maxsize read readline readlines
   write writelines flush
   // json
   load loads dump dumps JSONDecodeError
   // re
   compile match search findall finditer sub subn split fullmatch escape IGNORECASE MULTILINE
   DOTALL VERBOSE ASCII UNICODE I M S X A U group groups groupdict start end span pattern flags
   lastindex
   // datetime and time
   datetime date timedelta timezone utc UTC now utcnow today fromtimestamp utcfromtimestamp
   fromisoformat strptime strftime isoformat timestamp total_seconds days seconds microseconds year
   month day hour minute second weekday isoweekday astimezone combine min max time gmtime localtime
   mktime monotonic perf_counter ctime asctime
   // math
   floor ceil sqrt log log10 log2 exp pow pi e inf nan isnan isinf isfinite fabs fsum gcd lcm trunc
   sin cos tan atan atan2 hypot radians degrees comb perm prod copysign fmod
   // collections and itertools
   Counter defaultdict OrderedDict deque most_common elements popleft appendleft rotate
   move_to_end chain groupby islice product permutations combinations count cycle repeat
   zip_longest accumulate starmap takewhile dropwhile tee compress filterfalse pairwise batched
   from_iterable
   // string, textwrap, csv, html, statistics, hashlib
   ascii_letters ascii_lowercase ascii_uppercase digits punctuation whitespace printable capwords
   hexdigits octdigits dedent indent fill wrap shorten reader writer DictReader DictWriter
   writerow writerows writeheader fieldnames QUOTE_ALL QUOTE_MINIMAL QUOTE_NONE QUOTE_NONNUMERIC
   unescape mean median stdev pstdev variance mode quantiles fmean median_low median_high md5 sha1
   sha256 sha512 sha3_256 blake2b blake2s hexdigest digest update
   // urllib.parse
   parse urlparse urlsplit urlunparse urlunsplit urljoin quote quote_plus unquote unquote_plus
   urlencode parse_qs parse_qsl scheme netloc hostname port query fragment params geturl
   // str, bytes, list, dict, set, int, float
   strip lstrip rstrip rsplit splitlines join replace startswith endswith lower upper title
   capitalize casefold swapcase find rfind index rindex format format_map encode decode isdigit
   isalpha isalnum isspace isupper islower isnumeric isdecimal zfill ljust rjust center partition
   rpartition expandtabs translate maketrans removeprefix removesuffix append extend insert remove
   pop clear sort reverse copy get items keys values setdefault popitem fromkeys add discard union
   intersection difference symmetric_difference issubset issuperset isdisjoint real imag
   is_integer bit_length`.replace(/\/\/[^\n]*/g, ' '),
);

// -------------------------------------------------------------------------------------------
// Reading the program
// -------------------------------------------------------------------------------------------

const MULTI_OPERATORS = [
  '**=',
  '//=',
  '>>=',
  '<<=',
  '...',
  '==',
  '!=',
  '<=',
  '>=',
  '->',
  ':=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '@=',
  '**',
  '//',
  '>>',
  '<<',
];
const SINGLE_OPERATORS = '()[]{},.:;=<>!+-*/%|&^~@';
const OPENERS = '([{';
const CLOSERS = ')]}';
const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;
const NUMBER =
  /(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?[jJ]?)/y;
const STRING_PREFIXES = set('r u b br rb f fr rf t tr rt');

/**
 * Control characters other than a tab and a line break: a carriage return ends a line for Python
 * and not for a reader that splits on `\n`, and a form feed or a NUL is not a thing to read past.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

class Reader {
  readonly tokens: Tok[] = [];
  private depth = 0;

  constructor(
    private readonly text: string,
    private readonly fields = 0,
  ) {}

  /** Reads the whole text into tokens, or says it cannot. */
  run(): boolean {
    const { text } = this;
    let i = 0;
    while (i < text.length) {
      if (this.tokens.length > MAX_TOKENS) return false;
      const ch = text.charAt(i);
      if (ch === ' ' || ch === '\t') {
        i += 1;
      } else if (ch === '\n') {
        if (this.depth === 0) this.tokens.push({ kind: 'nl', text: '\n' });
        i += 1;
      } else if (ch === '\\') {
        if (text.charAt(i + 1) !== '\n') return false;
        i += 2;
      } else if (ch === '#') {
        const end = text.indexOf('\n', i);
        i = end === -1 ? text.length : end;
      } else if (NAME_START.test(ch)) {
        const next = this.name(i);
        if (next < 0) return false;
        i = next;
      } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text.charAt(i + 1)))) {
        const next = this.number(i);
        if (next < 0) return false;
        i = next;
      } else if (ch === '"' || ch === "'") {
        const next = this.string(i, '');
        if (next < 0) return false;
        i = next;
      } else {
        const next = this.operator(i);
        if (next < 0) return false;
        i = next;
      }
    }
    return this.depth === 0;
  }

  private name(from: number): number {
    const { text } = this;
    let end = from + 1;
    while (end < text.length && NAME_PART.test(text.charAt(end))) end += 1;
    const word = text.slice(from, end);
    const quote = text.charAt(end);
    if (quote === '"' || quote === "'") {
      // A name run into a quote is a string prefix, or it is not Python.
      return STRING_PREFIXES.has(word.toLowerCase()) ? this.string(end, word.toLowerCase()) : -1;
    }
    this.tokens.push({ kind: 'name', text: word });
    return end;
  }

  private number(from: number): number {
    NUMBER.lastIndex = from;
    const found = NUMBER.exec(this.text);
    if (found === null) return -1;
    const end = from + found[0].length;
    // A number run into a word (`1or x`, `0x1for`) is read by Python in ways a reader of this kind
    // gets wrong; it is not read.
    if (NAME_PART.test(this.text.charAt(end))) return -1;
    this.tokens.push({ kind: 'num', text: found[0] });
    return end;
  }

  private operator(from: number): number {
    const { text } = this;
    const multi = MULTI_OPERATORS.find((op) => text.startsWith(op, from));
    const op = multi ?? text.charAt(from);
    if (multi === undefined && !SINGLE_OPERATORS.includes(op)) return -1;
    if (OPENERS.includes(op)) this.depth += 1;
    else if (CLOSERS.includes(op)) {
      this.depth -= 1;
      if (this.depth < 0) return -1;
    }
    this.tokens.push({ kind: 'op', text: op });
    return from + op.length;
  }

  /** A string that begins at the quote at `from`, with the prefix it was given. */
  private string(from: number, prefix: string): number {
    const { text } = this;
    const quote = text.charAt(from);
    const triple = text.startsWith(quote.repeat(3), from);
    const open = triple ? 3 : 1;
    const bodyFrom = from + open;
    let i = bodyFrom;
    let end = -1;
    while (i < text.length) {
      const ch = text.charAt(i);
      if (ch === '\\') {
        if (i + 1 >= text.length) return -1;
        i += 2;
      } else if (!triple && ch === '\n') {
        return -1;
      } else if (ch === quote && (!triple || text.startsWith(quote.repeat(3), i))) {
        end = i;
        break;
      } else i += 1;
    }
    if (end === -1) return -1;
    const body = text.slice(bodyFrom, end);
    // The fields of an f-string (and a t-string) are programs, read as such.
    if (/[ft]/.test(prefix)) {
      if (this.fields >= MAX_FIELD_DEPTH) return -1;
      const inner = fieldsOf(body, prefix.includes('r'), quote, this.fields + 1);
      if (inner === null) return -1;
      this.tokens.push({ kind: 'str', text: '' }, ...inner);
    } else this.tokens.push({ kind: 'str', text: '' });
    return end + open;
  }
}

/** What may stand in the format specification of a field: no name, no call. */
const FORMAT_SPEC = /^[<>=^+\- #0-9.,_bcdeEfFgGnosxX%]*$/;

/**
 * The tokens of the expressions in the fields of an f-string body, each in parentheses, or null
 * when the body cannot be read: a brace that does not pair, the quote that ends the string inside a
 * field (Python before 3.12 does not allow one and after it reads it as a nested string, so it is
 * not read), a backslash in a field. The other quote opens a string in the field.
 */
function fieldsOf(body: string, raw: boolean, quote: string, level: number): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body.charAt(i);
    if (ch === '\\') {
      if (raw) {
        i += 1;
        continue;
      }
      const next = body.charAt(i + 1);
      if (next === '{' || next === '}') return null;
      if (next === 'N' && body.charAt(i + 2) === '{') {
        const close = body.indexOf('}', i + 3);
        if (close === -1) return null;
        i = close + 1;
      } else i += 2;
    } else if (ch === '{') {
      if (body.charAt(i + 1) === '{') {
        i += 2;
        continue;
      }
      const field = readField(body, i + 1, quote);
      if (field === null) return null;
      const { expression, spec, end } = field;
      const reader = new Reader(expression, level);
      if (expression.trim() === '' || !reader.run()) return null;
      out.push({ kind: 'op', text: '(' }, ...reader.tokens, { kind: 'op', text: ')' });
      if (spec !== null) {
        const nested = fieldsOf(spec, true, quote, level + 1);
        if (nested === null) return null;
        out.push(...nested);
      }
      i = end;
    } else if (ch === '}') {
      if (body.charAt(i + 1) !== '}') return null;
      i += 2;
    } else i += 1;
  }
  return out;
}

/** The expression, the format specification and the end of the field that begins after the `{` at `from`. */
function readField(
  body: string,
  from: number,
  quote: string,
): { readonly expression: string; readonly spec: string | null; readonly end: number } | null {
  let depth = 0;
  let i = from;
  let exprEnd = -1;
  for (; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (ch === '\\' || ch === quote) return null;
    if (ch === '"' || ch === "'") {
      // The other quote opens a string in the field, which holds no brace or colon of the field's.
      const close = body.indexOf(ch, i + 1);
      if (close === -1 || body.slice(i, close).includes('\\')) return null;
      i = close;
      continue;
    }
    if ('([{'.includes(ch)) depth += 1;
    else if (')]'.includes(ch)) depth -= 1;
    else if (ch === '}') {
      if (depth === 0) {
        exprEnd = i;
        break;
      }
      depth -= 1;
    } else if (depth === 0 && ch === ':') {
      exprEnd = i;
      break;
    } else if (depth === 0 && ch === '!' && body.charAt(i + 1) !== '=') {
      exprEnd = i;
      break;
    }
    if (depth < 0) return null;
  }
  if (exprEnd === -1) return null;
  // `{x=}` shows the expression: the `=` is not part of it.
  const expression = body.slice(from, exprEnd).replace(/(?<![=!<>])=\s*$/, '');
  i = exprEnd;
  if (body.charAt(i) === '!') {
    if (!/[rsa]/.test(body.charAt(i + 1))) return null;
    i += 2;
    if (body.charAt(i) !== ':' && body.charAt(i) !== '}') return null;
  }
  let spec: string | null = null;
  if (body.charAt(i) === ':') {
    let nest = 0;
    let j = i + 1;
    for (; j < body.length; j += 1) {
      const ch = body.charAt(j);
      if (ch === '{') nest += 1;
      else if (ch === '}') {
        if (nest === 0) break;
        nest -= 1;
      }
    }
    if (j >= body.length) return null;
    spec = body.slice(i + 1, j);
    // What is not a nested field must be the plain letters and signs of a format specification.
    if (!FORMAT_SPEC.test(spec.replace(/\{[^{}]*\}/g, ''))) return null;
    i = j;
  }
  return body.charAt(i) === '}' ? { expression, spec, end: i + 1 } : null;
}

// -------------------------------------------------------------------------------------------
// Judging the tokens
// -------------------------------------------------------------------------------------------

const isOp = (tok: Tok | undefined, text: string): boolean =>
  tok !== undefined && tok.kind === 'op' && tok.text === text;
const isName = (tok: Tok | undefined, text?: string): boolean =>
  tok !== undefined && tok.kind === 'name' && (text === undefined || tok.text === text);

const ASSIGNMENT_OPERATORS = set(`= := += -= *= /= %= &= |= ^= @= **= //= >>= <<=`);

/**
 * The names the program binds: a name that is assigned, is the target of a `for`, follows `as`,
 * `def` or `lambda`, or is a parameter. A name that is not one, is not on the lists and is not a
 * builtin is not known, and the program is `unknown`.
 */
function boundNames(tokens: readonly Tok[]): Set<string> {
  const bound = new Set<string>();
  const mark = (tok: Tok | undefined): void => {
    if (tok !== undefined && tok.kind === 'name') bound.add(tok.text);
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i] as Tok;
    if (tok.kind === 'op' && ASSIGNMENT_OPERATORS.has(tok.text)) {
      // The names before the operator, back to the start of the statement: `a, (b, c) = x`.
      for (let j = i - 1; j >= 0; j -= 1) {
        const before = tokens[j] as Tok;
        if (before.kind === 'name') mark(before);
        else if (before.kind === 'op' && ',()[]*'.includes(before.text)) continue;
        else break;
      }
    } else if (isName(tok, 'for')) {
      for (let j = i + 1; j < tokens.length && !isName(tokens[j], 'in'); j += 1) mark(tokens[j]);
    } else if (isName(tok, 'as') || isName(tok, 'def')) {
      mark(tokens[i + 1]);
    }
    if (isName(tok, 'lambda')) {
      for (let j = i + 1; j < tokens.length && !isOp(tokens[j], ':'); j += 1) mark(tokens[j]);
    }
    if (isName(tok, 'def') && isOp(tokens[i + 2], '(')) {
      let depth = 0;
      for (let j = i + 2; j < tokens.length; j += 1) {
        const t = tokens[j] as Tok;
        if (isOp(t, '(')) depth += 1;
        else if (isOp(t, ')')) {
          depth -= 1;
          if (depth === 0) break;
        } else mark(t);
      }
    }
  }
  return bound;
}

/** A dotted name `a.b.c` that starts at `i`, and the index after it. */
function dotted(tokens: readonly Tok[], i: number): { name: string; next: number } | null {
  if (!isName(tokens[i])) return null;
  let name = (tokens[i] as Tok).text;
  let next = i + 1;
  while (isOp(tokens[next], '.') && isName(tokens[next + 1])) {
    name += `.${(tokens[next + 1] as Tok).text}`;
    next += 2;
  }
  return { name, next };
}

interface Judgement {
  exec: boolean;
  unknown: boolean;
}

/** Reads one `import` or `from … import` statement from `i`; returns the index after it. */
function judgeImport(
  tokens: readonly Tok[],
  i: number,
  out: Judgement,
  bound: Set<string>,
): number {
  const fail = (name: string): void => {
    const root = name.split('.')[0] ?? '';
    if (EXEC_NAMES.has(root)) out.exec = true;
    else out.unknown = true;
  };
  if (isName(tokens[i], 'import')) {
    let at = i + 1;
    for (;;) {
      const module = dotted(tokens, at);
      if (module === null) {
        out.unknown = true;
        return at;
      }
      if (!MODULES.has(module.name) && !MODULE_NAMES.has(module.name)) fail(module.name);
      at = module.next;
      if (isName(tokens[at], 'as') && isName(tokens[at + 1])) at += 2;
      if (!isOp(tokens[at], ',')) return at;
      at += 1;
    }
  }
  // from M import a, b as c, (d, e)
  const module = dotted(tokens, i + 1);
  if (module === null || !isName(tokens[module.next], 'import')) {
    out.unknown = true;
    return i + 1;
  }
  if (!MODULES.has(module.name) && !MODULE_NAMES.has(module.name)) fail(module.name);
  let at = module.next + 1;
  const parenthesised = isOp(tokens[at], '(');
  if (parenthesised) at += 1;
  for (;;) {
    const name = tokens[at];
    if (name === undefined || name.kind !== 'name') {
      out.unknown = true;
      return at;
    }
    if (EXEC_NAMES.has(name.text)) out.exec = true;
    else if (!ATTRIBUTES.has(name.text) && !MODULES.has(`${module.name}.${name.text}`))
      out.unknown = true;
    // What `from m import a` brings in is a name of the program, as `a` and as the alias.
    bound.add(name.text);
    at += 1;
    if (isName(tokens[at], 'as') && isName(tokens[at + 1])) at += 2;
    if (!isOp(tokens[at], ',')) break;
    at += 1;
    if (parenthesised && isOp(tokens[at], ')')) break;
  }
  if (parenthesised && isOp(tokens[at], ')')) at += 1;
  return at;
}

function judge(tokens: readonly Tok[]): ProgramVerdict {
  const out: Judgement = { exec: false, unknown: false };
  const bound = boundNames(tokens);
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i] as Tok;
    if (tok.kind !== 'name') continue;
    const word = tok.text;
    if (word === 'import' || (word === 'from' && isName(tokens[i + 1]))) {
      // `from` also begins `yield from` and a `raise … from`, neither of which is read.
      const next = judgeImport(tokens, i, out, bound);
      i = Math.max(i, next - 1);
      continue;
    }
    if (isOp(tokens[i - 1], '.')) {
      // `re.compile` is a regular expression; a bare `compile` is Python's, and is in `EXEC_NAMES`.
      if (EXEC_NAMES.has(word) && word !== 'compile') out.exec = true;
      else if (!ATTRIBUTES.has(word)) out.unknown = true;
      continue;
    }
    if (KEYWORDS.has(word)) continue;
    if (OTHER_KEYWORDS.has(word)) out.unknown = true;
    else if (EXEC_NAMES.has(word)) out.exec = true;
    else if (word.startsWith('_')) out.unknown = true;
    else if (BUILTINS.has(word) && !ALLOWED_BUILTINS.has(word)) out.unknown = true;
    else if (ALLOWED_BUILTINS.has(word) || MODULE_NAMES.has(word) || bound.has(word)) continue;
    else out.unknown = true;
  }
  return out.exec ? 'exec' : out.unknown ? 'unknown' : 'data';
}

/** What a program given to `python -c` does: only handles data, runs code, or cannot be told. */
export function judgePythonProgram(program: string): ProgramVerdict {
  if (program.length > MAX_PROGRAM_CHARS || CONTROL.test(program)) return 'unknown';
  const reader = new Reader(program);
  if (!reader.run()) return 'unknown';
  return judge(reader.tokens);
}

/**
 * The lists the reader holds, for the test that checks them against the interpreter
 * (`inline-python-oracle.test.ts`): every name a program may use, every module it may import, and
 * every builtin the reader knows of.
 */
export const PYTHON_LISTS = {
  attributes: [...ATTRIBUTES],
  allowedBuiltins: [...ALLOWED_BUILTINS],
  knownBuiltins: [...BUILTINS],
  modules: [...MODULES],
  moduleNames: [...MODULE_NAMES],
} as const;
