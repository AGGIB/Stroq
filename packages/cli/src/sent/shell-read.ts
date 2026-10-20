// A shell command as `stroq sent` reads it: the stages the core cuts it into, what the core says of
// each, and which stages a key in the command reaches.
//
// The cut is the core's own (`splitCommand`, `lex`, `resolve`): the command and every text nested
// in it (a `bash -c` body, a substitution, a function's body with its arguments put in, the
// command with the variables it sets put in), each cut into pipelines by the lexer, a heredoc
// given to the stage that opens it. Where the lexer is not sure of a text, the plain cut is read
// in full. The plain cut is also always read for sends, so a heredoc read wrongly hides none.
//
// What the core says decides each stage: whether it makes a request (`classifyCommand`), and
// whether it only reads what it is handed (`stageReader`). What is kept here is only what the core
// does not answer, because the hook asks another question (does a stage run what is piped into
// it): programs that send which the hook has no rule for (`SENDERS`), the builtins that only set a
// variable (`ASSIGNS`), which read no input, and the line processors whose program is a file
// nobody read (`awk -f`, `sed -f`, `make`, `at`), which run no piped input but may send what their
// arguments hold.
import {
  classifyCommand,
  lex,
  REDIRECT,
  resolve,
  splitCommand,
  stageReader,
  type Resolved,
  type Word,
} from '@stroq/core';
import { pathWords } from './file-paths.js';

export interface Stage {
  readonly text: string;
  /** What a heredoc this stage opens feeds it. */
  readonly body: string;
  /** A `|` joins it to the stage before it. */
  readonly piped: boolean;
}

/** A command longer than this is not read: a key in it may have gone anywhere. */
export const MAX_READ_CHARS = 64 * 1024;
/** How long the core may take to read one command, or one stage of it. */
const READ_DEADLINE_MS = 2_000;
/** Stages the core reads one at a time in one command; past it, a stage may be a request. */
const MAX_STAGE_READS = 64;
/** Texts of one command cut by the lexer: the command and the texts nested in it. */
const MAX_TEXTS = 64;

/** What the core may say of a command that only reads or writes files. */
export const INERT_CLASSES: ReadonlySet<string> = new Set(['fs.secrets', 'config.instructions']);
/** What the core says of a request. */
export const SEND_CLASSES: ReadonlySet<string> = new Set(['shell.network', 'git.push_external']);

/**
 * Programs that send what they are given that the core's list of network commands does not hold
 * (that list is what the hook asks about): HTTPie and its kin, other HTTP and socket clients, and
 * PowerShell's web requests by their aliases.
 */
const SENDERS: ReadonlySet<string> = new Set([
  'curl',
  'curlie',
  'wget',
  'http',
  'https',
  'xh',
  'xhs',
  'httpie',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'ztcp',
  'ftp',
  'lftp',
  'aria2c',
  'grpcurl',
  'websocat',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'mosh',
  'invoke-webrequest',
  'invoke-restmethod',
  'iwr',
  'irm',
]);

/** Builtins that set a variable and run nothing: `export K=v`, `declare -x K=v`. */
const ASSIGNS: ReadonlySet<string> = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);
/** Builtins that set a variable from what they are given: a later step may use it. */
const SETS_FROM_INPUT: ReadonlySet<string> = new Set([
  'read',
  'mapfile',
  'readarray',
  'printf',
  'set',
  'let',
  'getopts',
]);

/**
 * Whether a line processor's program is a file, which is not read: `awk -f`, `-E`, `-i`, `-l` and
 * their long names, `sed -f`, `make` (its Makefile), `at` and `batch` (their job).
 */
function runsUnreadProgram(name: string, args: readonly Word[]): boolean {
  const values = args.filter((w) => !w.redirect).map((w) => w.value);
  if (/^(?:g?awk|mawk|nawk)$/.test(name))
    return values.some(
      (a) => /^-[A-Za-z]*[fEil]/.test(a) || /^--(?:file|exec|include|load)/.test(a),
    );
  if (/^g?sed$/.test(name))
    return values.some((a) => /^-[A-Za-z]*f/.test(a) || a.startsWith('--file'));
  return /^(?:g?make|at|batch)$/.test(name);
}

/** Files a write to which goes nowhere. */
const DEVICES: ReadonlySet<string> = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
]);

/** Paths a write to which opens a connection: bash's and gawk's network files. */
const NETWORK_FILES: readonly string[] = ['/dev/tcp/', '/dev/udp/', '/inet/', '/inet4/', '/inet6/'];

/** Whether a text names a network file. */
export const namesNetworkFile = (text: string): boolean =>
  NETWORK_FILES.some((prefix) => text.includes(prefix));

/** What one stage is, as the core reads it. */
export interface StageFacts {
  readonly resolved: Resolved | null;
  /** The program, by its base name, lower case; '' for a stage with none (`K=v`). */
  readonly name: string;
  /** It makes a request, or may: the core says so, it is a sender, or it writes to a network file. */
  readonly network: boolean;
  /** It only reads or prints what it is given, as the core reads it, and writes to no descriptor it opened. */
  readonly inert: boolean;
  /** A later step of the same text may use what it was given: it sets a variable, or may. */
  readonly setsState: boolean;
  /** The files it writes its output to: redirects, `tee`, `sponge`, and files named in its words. */
  readonly writes: readonly string[];
  /** Of `writes`, the ones it surely writes: its redirects, and the files `tee` and `sponge` name. */
  readonly surelyWrites: readonly string[];
  /** It names more files it may write than are read: one not read may be sent unseen. */
  readonly writesCut?: true;
}

/** The file each output redirect of a stage writes to, and whether one copies to a descriptor it opened. */
function redirects(args: readonly Word[]): { readonly files: string[]; readonly dup: boolean } {
  const files: string[] = [];
  let dup = false;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word;
    if (!word.redirect) continue;
    const match = REDIRECT.exec(word.value);
    if (match === null) continue;
    const op = match[2] ?? '';
    const glued = word.value.slice(match[0].length);
    const target = glued !== '' ? glued : (args[i + 1]?.value ?? '');
    if (glued === '') i += 1;
    if (op === '>&' || op === '<&') {
      // `2>&1`, `>&2` and `>&-` copy or close a standard stream; any other is a descriptor this
      // command opened (`exec 3<>/dev/tcp/…`, a coprocess), which may be a connection.
      if (!/^[12-]$/.test(target)) dup = op === '>&' || dup;
      continue;
    }
    if (op === '>' || op === '>>' || op === '>|' || op === '<>')
      if (target !== '' && !DEVICES.has(target)) files.push(target);
  }
  return { files, dup };
}

/** The files `tee` and `sponge` write what they are given to. */
function teeFiles(found: Resolved | null): string[] {
  if (found === null || (found.name !== 'tee' && found.name !== 'sponge')) return [];
  return found.args
    .filter((w) => !w.redirect && !w.value.startsWith('-') && !DEVICES.has(w.value))
    .map((w) => w.value);
}

/**
 * Programs the core reads as only reading that also write a file named in their words, and what
 * says they do: the option letters that name an output (`sort -o`, `sed -i`, `less -o`, `yq -i`,
 * `tidy -m`), long options (`--output`), whether any operand may be one (`uniq in out`, `xxd in
 * out`, `split` and `csplit` with their prefix, `tar cf`, a compressor given files), and for `sed`
 * and `awk` a program that writes (`w file`, `print > "file"`). Which word is the file is not read:
 * every word may be one.
 */
interface OutputRule {
  readonly letters?: string;
  readonly long?: readonly string[];
  readonly operands?: true;
  readonly program?: RegExp;
}
const OUTPUT: Readonly<Record<string, OutputRule>> = {
  sort: { letters: 'o', long: ['--output'] },
  shuf: { letters: 'o', long: ['--output'] },
  pv: { letters: 'o', long: ['--output'] },
  html2text: { letters: 'o', long: ['--output'] },
  base64: { letters: 'o', long: ['--output'] },
  iconv: { letters: 'o', long: ['--output'] },
  xmllint: { long: ['--output'] },
  less: { letters: 'oO', long: ['--log-file', '--LOG-FILE'] },
  more: { letters: 'oO', long: ['--log-file', '--LOG-FILE'] },
  yq: { letters: 'i', long: ['--inplace', '--in-place'] },
  xq: { letters: 'i', long: ['--inplace', '--in-place'] },
  tidy: { letters: 'om', long: ['--output', '--modify'] },
  uniq: { operands: true },
  xxd: { operands: true },
  split: { operands: true },
  csplit: { operands: true },
  dos2unix: { operands: true },
  unix2dos: { operands: true },
  gzip: { operands: true },
  gunzip: { operands: true },
  bzip2: { operands: true },
  bunzip2: { operands: true },
  xz: { operands: true },
  unxz: { operands: true },
  lzma: { operands: true },
  unlzma: { operands: true },
  pigz: { operands: true },
  zstd: { letters: 'o', operands: true },
  unzstd: { letters: 'o', operands: true },
  lz4: { letters: 'o', operands: true },
  tar: { operands: true },
  sed: { letters: 'i', long: ['--in-place'], program: /[wW]/ },
  gsed: { letters: 'i', long: ['--in-place'], program: /[wW]/ },
  awk: { program: /[>|]/ },
  gawk: { program: /[>|]/ },
  mawk: { program: /[>|]/ },
  nawk: { program: /[>|]/ },
};

/** Words of a stage's options and program read as file names, at most. */
const MAX_OPTION_FILES = 64;

/** Whether a program's words say it writes a file they name, by its rule. */
function writesNamedFile(rule: OutputRule, words: readonly string[]): boolean {
  return words.some((w) => {
    if (w.startsWith('--')) return rule.long?.some((option) => w.startsWith(option)) === true;
    if (w.startsWith('-') && w !== '-')
      return [...(rule.letters ?? '')].some((letter) => w.slice(1).includes(letter));
    return rule.operands === true || rule.program?.test(w) === true;
  });
}

/**
 * Every file a program that names its output in its words may have written: each word, a value
 * glued to an option (`-o/tmp/x`, `--output=/tmp/x`), and the names inside a program it was
 * given (`{print > "/tmp/x"}`, `w /tmp/x`). None for a program not in `OUTPUT`, or whose words
 * do not say it writes one.
 */
function optionFiles(found: Resolved | null): {
  readonly writes: boolean;
  readonly files: string[];
  readonly cut?: true;
} {
  const none = { writes: false, files: [] };
  const rule =
    found === null || !Object.hasOwn(OUTPUT, found.name) ? undefined : OUTPUT[found.name];
  if (found === null || rule === undefined) return none;
  const words = found.args.filter((w) => !w.redirect).map((w) => w.value);
  if (!writesNamedFile(rule, words)) return none;
  const files = new Set<string>();
  for (const v of words) {
    const pieces = v.startsWith('--')
      ? [v.slice(v.indexOf('=') + 1)]
      : v.startsWith('-')
        ? [v.slice(2)]
        : [v, ...pathWords(v)];
    for (const piece of pieces) {
      if (piece === '' || piece === '-' || piece.startsWith('-') || DEVICES.has(piece)) continue;
      if (!files.has(piece) && files.size >= MAX_OPTION_FILES)
        return { writes: true, files: [...files], cut: true };
      files.add(piece);
    }
  }
  return { writes: true, files: [...files] };
}

/** What the core says of one command, read once for every key it holds. */
export interface CommandReading {
  readonly command: string;
  readonly classes: ReadonlySet<string>;
  /** The texts the lexer cut, each as its pipelines; the plain cut of a text it was not sure of. */
  readonly run: readonly (readonly (readonly Stage[])[])[];
  /** The plain cut of the command and what it nests, read for sends only. */
  readonly plain: readonly (readonly Stage[])[];
  /** The stages that hand the whole shell's output to a descriptor (`exec >file`, `exec 3<>…`). */
  readonly execSink: boolean;
  /** Whether the command makes a request somewhere, or may. */
  readonly sends: () => boolean;
  facts(stage: Stage): StageFacts;
}

/** The core's classes for a text, or `shell.unparsed` when it could not be read. */
function classesOf(text: string, cwd: string): ReadonlySet<string> {
  try {
    return new Set(classifyCommand(text, cwd, 0, { deadlineMs: READ_DEADLINE_MS }).classes);
  } catch {
    return new Set(['shell.unparsed']);
  }
}

const safeResolve = (text: string): Resolved | null => {
  try {
    return resolve(text);
  } catch {
    return null;
  }
};

/** The core's cut of a command: the texts it reads, each cut by the lexer or the plain cut. */
function cutOf(command: string): {
  readonly run: Stage[][][];
  readonly plain: Stage[][];
} {
  let split: ReturnType<typeof splitCommand>;
  try {
    split = splitCommand(command);
  } catch {
    const whole = [[{ text: command, body: '', piped: false }]];
    return { run: [whole], plain: whole };
  }
  const plain = split.pipelines.map((stages) =>
    stages.map((text, i) => ({ text, body: '', piped: i > 0 })),
  );
  const run: Stage[][][] = [];
  let unsure = false;
  // The command as it was written first: the core reads its heredoc bodies apart when they are text.
  for (const text of [command, ...split.texts.slice(1)].slice(0, MAX_TEXTS)) {
    const lexed = lex(text);
    if (lexed.uncertain) unsure = true;
    else
      run.push(
        lexed.pipelines.map((stages) =>
          stages.map((stage) => ({
            text: stage.text,
            body: stage.heredoc?.body ?? '',
            piped: stage.piped,
          })),
        ),
      );
  }
  if (unsure || split.texts.length > MAX_TEXTS) run.push(plain);
  return { run, plain };
}

/** Reads a command once: its classes, its cut, and the facts of each stage asked about. */
export function readCommand(command: string, cwd: string | null): CommandReading {
  const at = cwd ?? '/';
  const classes = classesOf(command, at);
  const { run, plain } = cutOf(command);
  let reads: (stage: string) => boolean;
  try {
    reads = stageReader(command);
  } catch {
    reads = () => false;
  }
  const all = [...run.flat(2), ...plain.flat()];
  const resolvedTexts = new Map<string, Resolved | null>();
  const resolved = (text: string): Resolved | null => {
    if (resolvedTexts.has(text)) return resolvedTexts.get(text) ?? null;
    const found = safeResolve(text);
    resolvedTexts.set(text, found);
    return found;
  };
  const execSink = all.some(
    (stage) => /(?:^|[\s;&|(])exec\s/.test(stage.text) && resolved(stage.text)?.name === 'exec',
  );
  const sendsByCore = [...classes].some((cls) => SEND_CLASSES.has(cls));
  const doubtful = [...classes].some((cls) => !INERT_CLASSES.has(cls));
  let anySender: boolean | null = null;
  /** Whether any stage of the command sends, or may: read once, when first asked. */
  const commandSends = (): boolean =>
    (anySender ??=
      sendsByCore ||
      namesNetworkFile(command) ||
      all.some((stage) => SENDERS.has(resolved(stage.text)?.name ?? '')));
  let stageReads = 0;
  const stageClasses = new Map<string, ReadonlySet<string> | null>();
  /** The core's classes of one stage, or null past the number read. */
  const classesOfStage = (text: string): ReadonlySet<string> | null => {
    if (stageClasses.has(text)) return stageClasses.get(text) ?? null;
    const found = stageReads < MAX_STAGE_READS ? classesOf(text, at) : null;
    stageReads += 1;
    stageClasses.set(text, found);
    return found;
  };
  const known = new Map<string, StageFacts>();
  const facts = (stage: Stage): StageFacts => {
    const key = `${stage.text}\u0000${stage.body}`;
    const seen = known.get(key);
    if (seen !== undefined) return seen;
    const found = resolved(stage.text);
    const name = found?.name ?? '';
    const { files, dup } = redirects(found?.args ?? []);
    // Past the stages the core reads one at a time, a stage of a command that sends may be one.
    const own = sendsByCore || doubtful ? classesOfStage(stage.text) : new Set<string>();
    const network =
      namesNetworkFile(stage.text) ||
      SENDERS.has(name) ||
      (sendsByCore && (own === null || [...own].some((cls) => SEND_CLASSES.has(cls)))) ||
      // What is written to a descriptor the command opened, or to the shell's own output after
      // `exec` sent it somewhere, goes where that went: in a command that sends, a connection.
      ((dup || execSink) && commandSends());
    const assigns =
      found === null ||
      (ASSIGNS.has(name) && found.args.every((w) => !w.expands && !w.value.startsWith('-f')));
    const named = optionFiles(found);
    const inert =
      !network &&
      !dup &&
      !execSink &&
      // A program that may have written a file named in its words wrote it where Stroq cannot
      // say for sure: what it wrote is followed, and the stage is no longer only a read.
      !named.writes &&
      !runsUnreadProgram(name, found?.args ?? []) &&
      own !== null &&
      [...own].every((cls) => INERT_CLASSES.has(cls)) &&
      (assigns || safeReads(reads, stage.text));
    const result: StageFacts = {
      resolved: found,
      name,
      network,
      inert,
      setsState: !inert || assigns || SETS_FROM_INPUT.has(name) || stage.text.includes('${'),
      writes: [...files, ...teeFiles(found), ...named.files],
      surelyWrites: [...files, ...teeFiles(found)],
      ...(named.cut === true ? { writesCut: true as const } : {}),
    };
    known.set(key, result);
    return result;
  };
  return { command, classes, run, plain, execSink, sends: commandSends, facts };
}

function safeReads(reads: (stage: string) => boolean, text: string): boolean {
  try {
    return reads(text);
  } catch {
    return false;
  }
}

/**
 * The processor time reading commands may take in one run, in milliseconds. A session can hold
 * commands built to be slow to read; past this, no command is read, a key one holds is maybe sent,
 * and the report counts the commands cut (`commandsCut`).
 */
export const READ_BUDGET_MS = 120_000;

let budget = { limitMs: READ_BUDGET_MS, spentMs: 0 };
let cut = 0;
let spent = false;
let lastCut: string | null = null;

/** A fresh budget for a run: `limitMs` of processor time for reading commands. */
export function startReadBudget(limitMs: number = READ_BUDGET_MS): void {
  budget = { limitMs, spentMs: 0 };
  cut = 0;
  spent = false;
  lastCut = null;
}

/**
 * Whether the run may still read a command. The first time it may not, the run is marked: its
 * report is incomplete from then on, whatever the commands after it held (`budgetSpent`).
 */
export function readBudgetLeft(): boolean {
  if (budget.spentMs < budget.limitMs) return true;
  spent = true;
  return false;
}

/** Whether this run ran out of time for reading commands. */
export const budgetSpent = (): boolean => spent;

/** The process's processor time, in milliseconds. */
const cpuNow = (): number => {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
};

let clock: () => number = cpuNow;

/** The clock the budget is charged by: the process's processor time, or a test's own. */
export function setReadClock(read: () => number = cpuNow): void {
  clock = read;
}

/** A start for `charge`: the clock now. */
export const chargeStart = (): number => clock();

/** The time since `started`, charged to the run's budget: the whole analysis of one call. */
export function charge(started: number): void {
  budget.spentMs += Math.max(0, clock() - started);
}

/** How much of the budget this run has spent, in milliseconds. */
export const readBudgetSpentMs = (): number => budget.spentMs;

/**
 * One command not read because the budget was spent: one that holds a key, or any command, which
 * may name a key file or print the environment. A command is counted once, however many keys it
 * is read for.
 */
export function countCut(command: string): void {
  if (command === lastCut) return;
  lastCut = command;
  cut += 1;
}

/** How many commands this run did not read because its time for reading them was spent. */
export const commandsCut = (): number => cut;

/** One command read at a time: a command that held several keys is read once for all of them. */
let lastRead: {
  readonly command: string;
  readonly cwd: string | null;
  readonly reading: CommandReading;
} | null = null;

export function commandReading(command: string, cwd: string | null): CommandReading {
  if (lastRead !== null && lastRead.command === command && lastRead.cwd === cwd)
    return lastRead.reading;
  const reading = readCommand(command, cwd);
  lastRead = { command, cwd, reading };
  return reading;
}

/** How a stage came to hold the key. */
export interface Reach {
  readonly stage: Stage;
  /** The key is in its own words or its heredoc. */
  readonly direct: boolean;
  /** A stage before it in its pipeline held the key: what it printed flows in. */
  readonly piped: boolean;
  /** An earlier step of the same text set a variable to it, or may have. */
  readonly state: boolean;
}

/**
 * The stages of a text that hold the key, are piped it, or run after a step that set a variable
 * to it. A request's reply flows on too: a key may come back in it.
 */
export function reached(
  pipelines: readonly (readonly Stage[])[],
  holds: (stage: Stage) => boolean,
  facts: (stage: Stage) => StageFacts,
): Reach[] {
  const out: Reach[] = [];
  let state = false;
  for (const stages of pipelines) {
    let piped = false;
    for (const stage of stages) {
      if (!stage.piped) piped = false;
      const direct = holds(stage);
      if (!direct && !piped && !state) continue;
      out.push({ stage, direct, piped, state });
      if (facts(stage).setsState) state = true;
      piped = true;
    }
  }
  return out;
}
