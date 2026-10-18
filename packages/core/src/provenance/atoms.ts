import { createHash } from 'node:crypto';
import { expandVariants } from '../normalize/normalizer.js';
import { DEFAULT_MAX_CHARS } from '../scan/scanner.js';
import type { Atom } from '../types.js';
import type { Positioned } from './atom-kinds.js';
import { createAtomSet } from './atom-set.js';
import { encodedAtoms } from './encoded-atoms.js';

/**
 * Upper bound on the atoms that can raise the floor (a package, a pipe-to-shell, an encoded blob)
 * extracted from one text: the first N in text order, after dedupe. Reaching it is a loss, and
 * marks the session incomplete.
 */
export const MAX_ATOMS = 200;
/**
 * The same bound for URLs and hosts, which are counted apart. They cannot raise the floor, so
 * the ones past it are left out without a word: a session that read a lot of links (a search, a
 * lockfile, a page of documentation) is not a session that lost evidence, and they must not use up
 * the room a package needs.
 */
export const MAX_NETWORK_ATOMS = 200;
const MAX_VALUE_CHARS = 512;
// `restOfLine` scans at most this many characters past a runner/installer match.
// A command line longer than this is truncated (trailing packages are missed), which
// bounds the per-match scan cost and keeps package extraction linear instead of
// quadratic on adversarial input that never hits a LINE_END character. A wrapped list of sixty
// packages is about 1,300 characters once its lines are joined, so the window holds that; it is
// the smallest power of two that does, because every doubling is another stretch of an indented
// block that an installer's line runs through (see `wrappedCommandCut`).
const MAX_LINE_SCAN = 2048;
// The most characters read after runners and installers in one pass over a text, all matches
// together. Each match reads its own line, and the lines of matches that sit on one long line
// overlap, so `npm i a npm i a …` over 200,000 characters would read the window 25,000 times: four
// seconds, inside a hook with nine. An honest text spends at most its own length (a line is read
// once); past this, the matches that are left are not read and count as a line that was cut.
const MAX_LINE_WORK = 262_144;

// `|` ends a URL too: in `curl https://x.example/i.sh|sh` the pipe is shell syntax,
// not part of the URL the command fetches.
const URL_RE = /https?:\/\/[^\s"'<>()[\]`|]+/gi;
// Sentence punctuation after a URL, stripped with `trimEndOf`. All but the quotes are
// legal inside a URL, so a long run of them is part of the match, and the pattern
// `/[.,;:!?'"]+$/` restarted at every one of them when one more character followed:
// 199,000 `!` in tool output took 48 s, and a Bash command has no length cap at all.
const TRAILING_PUNCT = '.,;:!?\'"';
const QUOTES = '"\'';
// What prose puts after a name: "run npx helper-fix." must yield `helper-fix`, or the
// command that copies it never matches. `;` and `!` need no entry: `VERSION_MARKER`
// cuts at both.
const TRAILING = `${QUOTES}.,:?)`;
const LEADING_QUOTES = /^["']+/;
const VERSION_MARKER = /[[<>=!~;]/;
const LINE_BREAKS = '\n\r\u2028\u2029';
const URL_HOST = /^https?:\/\/(?:[^@/\s]+@)?([^/:?#\s]+)/;
// `user@host.tld` — ssh/scp targets and git ssh remotes.
const SSH_TARGET = /(?<![\w.-])[\w.-]+@((?:[\w-]+\.)+[a-z]{2,})(?![\w.-])/gi;
// Package runners: the first positional token after them is the package.
const RUNNER = /(?<![\w./-])(?:npx|bunx|uvx|pnpm\s+dlx|yarn\s+dlx|pipx\s+run)(?=\s)/gi;
// Package installers: every positional token after them is a package.
const INSTALLER =
  /(?<![\w./-])(?:npm\s+(?:i|install|add)|pnpm\s+(?:add|install)|yarn\s+add|pip3?\s+install|uv\s+add|uv\s+pip\s+install|pipx\s+install|cargo\s+install|gem\s+install|go\s+install|brew\s+install)(?=\s)/gi;
const LINE_END = /[\n|;`]|&&|\|\|/;
// A newline immediately followed by indentation (a space or tab) is a wrapped
// continuation of the same command, not a new one — the `split-across-lines`
// mutation (and ordinary word-wrapping) produces exactly this shape by turning
// every space into `\n  `. A bare newline followed by non-whitespace still
// starts a new, unrelated command and must stay a hard stop: that is what
// `LINE_END` is for, and this pass never touches it. Indentation is the
// discriminator between "the same command, wrapped" and "a new command".
const CONTINUATION_NEWLINE = /\r?\n[ \t]+/g;
const FLAGS_WITH_VALUE = new Set([
  '-r',
  '--requirement',
  '-c',
  '--constraint',
  '-i',
  '--index-url',
  '--extra-index-url',
  '-t',
  '--target',
  '--registry',
  '--prefix',
]);
const PACKAGE_FLAGS = new Set(['-p', '--package']);
// curl/wget piped into a shell, and `sh <(curl ...)` process substitution. The `{0,400}`
// bounds cap the backtracking span per curl/wget/sh occurrence so a long run of them with
// no matching pipe/paren stays linear instead of quadratic.
const PIPE_SHELL =
  /\b(?:curl|wget)\b[^\n|;&`]{0,400}\|\s*(?:sudo\s+(?:-E\s+)?)?(?:ba|z|da|k)?sh\b(?:\s+-[a-z]+)?/gi;
const PROC_SUB_SHELL = /\b(?:ba|z|da|k)?sh\s+<\(\s*(?:curl|wget)\b[^)\n]{0,400}\)/gi;

/**
 * `text` without the run of `chars` at its end. A loop, not a `[…]+$` pattern: that
 * restarts at every character of a run it cannot finish, so a long run followed by
 * one character outside it costs time quadratic in the run.
 */
function trimEndOf(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/**
 * `name` cut at its first version, extra or marker character (`>=2.0`, `[socks]`,
 * `; python_version…`), on its last line only: it used to be `/[[<>=!~;].*$/`, whose
 * `.` stops at a line break, so a marker before one was never cut. The same pattern
 * restarted at every marker character of a run it could not finish.
 */
function withoutVersion(name: string): string {
  let lastLine = name.length;
  while (lastLine > 0 && !LINE_BREAKS.includes(name.charAt(lastLine - 1))) lastLine -= 1;
  const cut = name.slice(lastLine).search(VERSION_MARKER);
  return cut === -1 ? name : name.slice(0, lastLine + cut);
}

/**
 * A package name as a lookup key. `knownPackages` runs every dependency name in the
 * project's `package.json` through here on every Bash call — up to 256 KiB of it,
 * written by whoever wrote the repository — so nothing here may be super-linear: with
 * the edges stripped by `/^["']+|["']+$/g` and `/[[<>=!~;].*$/`, one planted name of
 * 262,000 quotes, or of `[`s and a line break, took 30 s.
 */
export function normalizePackageName(raw: string): string {
  const name = trimEndOf(raw.replace(LEADING_QUOTES, ''), TRAILING);
  const at = name.startsWith('@') ? name.indexOf('@', 1) : name.indexOf('@');
  const base = at > 0 ? name.slice(0, at) : name;
  return withoutVersion(base).toLowerCase();
}

/** The part of a line an extractor read, and whether the line went on past what it read. */
interface LineScan {
  readonly line: string;
  readonly cut: boolean;
  /** How many characters of the text were looked at to find it. */
  readonly read: number;
}

function restOfLine(text: string, from: number): LineScan {
  const rest = text.slice(from, from + MAX_LINE_SCAN);
  const stop = rest.search(LINE_END);
  return {
    line: (stop === -1 ? rest : rest.slice(0, stop)).trim(),
    cut: stop === -1 && text.length > from + MAX_LINE_SCAN,
    read: stop === -1 ? rest.length : stop,
  };
}

/**
 * Collapses wrapped line continuations to a single space so `restOfLine` can
 * recover a package name an attacker (or a word-wrapping renderer) split across
 * lines. Used only inside `extractAtomsDeep`, for provenance atoms — never fed
 * to rule matching — because a wrong atom here costs a false `ask`, while
 * loosening `LINE_END` itself would risk a false `deny` on a genuinely
 * unrelated next command.
 */
function collapseContinuations(text: string): string {
  return text.replace(CONTINUATION_NEWLINE, ' ');
}

function isPackageToken(token: string): boolean {
  return (
    token !== '' &&
    !token.startsWith('-') &&
    !token.startsWith('.') &&
    !token.startsWith('/') &&
    !token.startsWith('$') &&
    !token.includes('://')
  );
}

/** The single package a runner (`npx`, `pnpm dlx`, …) resolves: `-p <pkg>` wins, else the first positional. */
function runnerPackage(tokens: readonly string[]): string | null {
  let fromFlag: string | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (PACKAGE_FLAGS.has(token)) {
      const value = tokens[i + 1] ?? '';
      if (isPackageToken(value)) fromFlag = value;
      i += 1;
      continue;
    }
    if (FLAGS_WITH_VALUE.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return fromFlag ?? (isPackageToken(token) ? token : null);
  }
  return fromFlag;
}

function installerPackages(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (FLAGS_WITH_VALUE.has(token)) {
      i += 1;
      continue;
    }
    if (isPackageToken(token)) out.push(token);
  }
  return out;
}

/** Atoms one extractor found, and whether it stopped reading a line before the line ended. */
interface Found {
  readonly positioned: Positioned[];
  /** A line went on past the window, with no package found before it ended. */
  readonly cut: boolean;
  /** The pass spent its reading budget, so some matches were not read at all. */
  readonly budgetSpent: boolean;
}

/** A runner or installer match with the rest of its line, positioned at the match's start. */
type LineAfter = (m: RegExpMatchArray) => { index: number; scan: LineScan };

/** Reads the line after each match, and says whether the budget ran out so some were skipped. */
interface LineReader {
  readonly after: LineAfter;
  readonly skipped: () => boolean;
}

/**
 * Reads the line after each match in turn, out of one budget for the pass (`MAX_LINE_WORK`). A
 * match that finds the budget spent is given an empty line that was cut: it was not read, and the
 * reader says so through `skipped`, apart from a line that is merely longer than the window. Every
 * pass over a text (the text as written, a decoded variant, the text with its continuation lines
 * joined) makes its own reader and so has its own budget, and the caller counts a spent budget as
 * a loss in every one of them: the joined pass is the one that reads a block of indented lines as
 * a single long line, which is where the budget goes first.
 */
function lineReader(text: string): LineReader {
  let budget = MAX_LINE_WORK;
  let skipped = false;
  return {
    after: (m) => {
      const index = m.index ?? 0;
      if (budget <= 0) {
        skipped = true;
        return { index, scan: { line: '', cut: true, read: 0 } };
      }
      const scan = restOfLine(text, index + m[0].length);
      budget -= scan.read + 1;
      return { index, scan };
    },
    skipped: () => skipped,
  };
}

/** Every package named after a runner match, positioned at that match's start index. */
function runnerPackages(text: string, reader: LineReader): Found {
  const lines = [...text.matchAll(RUNNER)].map(reader.after);
  return {
    positioned: lines.flatMap(({ index, scan }): Positioned[] => {
      const pkg = runnerPackage(scan.line.split(/\s+/));
      if (pkg === null) return [];
      const value = normalizePackageName(pkg);
      return value.length > 0 ? [{ index, atom: { kind: 'pkg', value } }] : [];
    }),
    cut: lines.some(({ scan }) => scan.cut),
    budgetSpent: reader.skipped(),
  };
}

/** Every package named after an installer match, positioned at that match's start index. */
function installedPackages(text: string, reader: LineReader): Found {
  const lines = [...text.matchAll(INSTALLER)].map(reader.after);
  return {
    positioned: lines.flatMap(({ index, scan }): Positioned[] =>
      installerPackages(scan.line.split(/\s+/)).flatMap((pkg): Positioned[] => {
        const value = normalizePackageName(pkg);
        return value.length > 0 ? [{ index, atom: { kind: 'pkg', value } }] : [];
      }),
    ),
    cut: lines.some(({ scan }) => scan.cut),
    budgetSpent: reader.skipped(),
  };
}

function urlAtoms(text: string): Positioned[] {
  const fromUrls = [...text.matchAll(URL_RE)].flatMap((m): Positioned[] => {
    const index = m.index ?? 0;
    const url = trimEndOf(m[0], TRAILING_PUNCT).toLowerCase();
    const host = URL_HOST.exec(url)?.[1];
    return host
      ? [
          { index, atom: { kind: 'url', value: url } },
          { index, atom: { kind: 'host', value: host } },
        ]
      : [{ index, atom: { kind: 'url', value: url } }];
  });
  const fromSsh = [...text.matchAll(SSH_TARGET)].map((m): Positioned => ({
    index: m.index ?? 0,
    atom: { kind: 'host', value: (m[1] ?? '').toLowerCase() },
  }));
  return [...fromUrls, ...fromSsh];
}

/** How much text after an installer is looked at to see whether it is the start of a wrapped command. */
const WRAP_SCAN = MAX_LINE_SCAN;

const skipBlanks = (text: string, from: number): number => {
  let at = from;
  while (text.charAt(at) === ' ' || text.charAt(at) === '\t') at += 1;
  return at;
};

/**
 * Whether what follows a runner or installer is a wrapped command: the rest of its line is
 * empty, or only a backslash, and the next line is indented and either follows that backslash
 * or starts with a flag (`-x`, `--long`). A dash and a space is a list item, not a flag.
 * Written without a pattern so that a long run of blanks costs a pass, not a square.
 */
function startsWrapped(tail: string): boolean {
  let at = skipBlanks(tail, 0);
  const backslash = tail.charAt(at) === '\\';
  if (backslash) at = skipBlanks(tail, at + 1);
  if (tail.charAt(at) === '\r') at += 1;
  if (tail.charAt(at) !== '\n') return false;
  const next = skipBlanks(tail, at + 1);
  if (next === at + 1) return false;
  return backslash || (tail.charAt(next) === '-' && /[-A-Za-z]/.test(tail.charAt(next + 1)));
}

/**
 * Whether the command that starts at `from`, with each indented continuation line joined to the
 * line before it by one space (what `collapseContinuations` makes of it), outgrows the line
 * window with no line end inside it: what `restOfLine` reports as cut for the joined text. It
 * walks the text as written instead of building the joined text, and stops at the window, so a
 * wrapped command costs the window and not the length of the text after it.
 */
function joinedLineOutgrows(text: string, from: number): boolean {
  let at = from;
  let length = 0;
  while (at < text.length) {
    if (length >= MAX_LINE_SCAN) return true;
    const char = text.charAt(at);
    const newline = char === '\r' && text.charAt(at + 1) === '\n' ? at + 1 : at;
    if (text.charAt(newline) === '\n') {
      const next = skipBlanks(text, newline + 1);
      if (next === newline + 1) return false;
      at = next;
    } else {
      if (isLineEnd(text, at)) return false;
      at += 1;
    }
    length += 1;
  }
  return false;
}

/** Whether `LINE_END` matches at `at` (a line break aside), which is what ends the part of a command that is read. */
function isLineEnd(text: string, at: number): boolean {
  const char = text.charAt(at);
  return (
    char === '|' || char === ';' || char === '`' || (char === '&' && text.charAt(at + 1) === '&')
  );
}

/**
 * Whether a wrapped runner or installer outgrows the line window once its lines are joined,
 * which leaves its last arguments, a package among them, past the part that is read.
 *
 * Only a command that says it is wrapped counts. The continuation pass joins every indented
 * line into one, so the same window would be passed by the first installer of any indented
 * block (a workflow, a Makefile recipe, a README example): 29 files of this repository were
 * flagged for that and none for a command that was wrapped. An installer wrapped over lines of
 * plain words, with no backslash and no flag, is not told apart from such a block and is not
 * counted; the pass over the text as written still reads the first window of it.
 */
function wrappedCommandCut(text: string): boolean {
  for (const pattern of [RUNNER, INSTALLER]) {
    for (const m of text.matchAll(pattern)) {
      const from = (m.index ?? 0) + m[0].length;
      if (startsWrapped(text.slice(from, from + WRAP_SCAN)) && joinedLineOutgrows(text, from))
        return true;
    }
  }
  return false;
}

function packageAtoms(text: string): Found {
  const reader = lineReader(text);
  const runners = runnerPackages(text, reader);
  const installers = installedPackages(text, reader);
  return {
    positioned: [...runners.positioned, ...installers.positioned],
    cut: runners.cut || installers.cut,
    budgetSpent: reader.skipped(),
  };
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

function pipeShellAtoms(text: string): Positioned[] {
  return [...text.matchAll(PIPE_SHELL), ...text.matchAll(PROC_SUB_SHELL)].map((m): Positioned => ({
    index: m.index ?? 0,
    atom: { kind: 'pipe_shell', value: collapse(m[0]) },
  }));
}

export function atomHash(atom: Atom): string {
  return createHash('sha256').update(`${atom.kind}\n${atom.value}`).digest('hex').slice(0, 32);
}

/** The atoms found in a text, and whether a bound kept some atom that is in the text out of them. */
export interface AtomExtraction {
  readonly atoms: Atom[];
  /**
   * True when something that could have been an atom that raises the floor was left out: as
   * many packages, pipe-to-shell and encoded atoms as `MAX_ATOMS` (it cannot tell that there
   * were not more), a runner or installer line longer than the part of it that is read, or text
   * past the characters `extractAtomsDeepWithLoss` reads. An atom that was left out looks, to
   * a later lookup, like content the session never read. URLs and hosts left out at
   * `MAX_NETWORK_ATOMS` are not a loss: no lookup of one can raise the floor.
   */
  readonly truncated: boolean;
}

/** One extraction pass, with the two ways a bound can cut it told apart. */
interface Extraction {
  readonly atoms: Atom[];
  /** More distinct atoms that raise the floor were found than `MAX_ATOMS` keeps. */
  readonly capped: boolean;
  /** A runner or installer line went on past the part of it that is read. */
  readonly lineCut: boolean;
  /** The pass ran out of the budget for reading lines, so the matches that were left were not read. */
  readonly budgetSpent: boolean;
}

function extractBounded(text: string): Extraction {
  const packages = packageAtoms(text);
  const positioned = [
    ...urlAtoms(text),
    ...packages.positioned,
    ...pipeShellAtoms(text),
    ...encodedAtoms(text),
  ];
  positioned.sort((a, b) => a.index - b.index);
  const set = createAtomSet(MAX_ATOMS, MAX_NETWORK_ATOMS);
  for (const { atom } of positioned) {
    set.add({ kind: atom.kind, value: atom.value.slice(0, MAX_VALUE_CHARS) });
  }
  return {
    atoms: set.atoms,
    capped: set.floorLeftOut,
    lineCut: packages.cut,
    budgetSpent: packages.budgetSpent,
  };
}

/**
 * Extracts actionable atoms — the pieces of text an agent could copy into a
 * dangerous action — in text order, deduped, capped at MAX_ATOMS packages, pipe-to-shell
 * and encoded atoms and, apart, at MAX_NETWORK_ATOMS URLs and hosts. Every extractor
 * tags each atom with the text index its source match started at, so atoms are
 * merged and sorted into true text order *before* the cap is applied — otherwise
 * the first-in-text (often most dangerous) atom could be dropped in favor of a
 * same-kind atom that merely happened to be found by an earlier extractor. Prose
 * that merely mentions `npx` yields harmless junk atoms (they only matter if the
 * exact same value later appears in a real action), so no attempt is made to
 * tell prose from code.
 */
export function extractAtoms(text: string): Atom[] {
  return extractBounded(text).atoms;
}

/**
 * Atoms from `text` and from every decoded variant the scanner already expands.
 *
 * `extractAtoms` matches raw-text patterns — a URL, an `npx <pkg>`, an installer — so
 * base64-encoding a tool result destroys every atom in it, and with it the link between
 * "this package name arrived from an untrusted source" and "the agent is now running
 * it". The mutation fuzzer found exactly that: encoding a payload three different ways
 * let a recorded incident through with no rule firing, because provenance had nothing
 * left to match on. Decoding first is what makes provenance content-independent in the
 * way the design always claimed it was — not an optimisation, but the fix for the one
 * property (surviving where content rules don't) the whole feature is supposed to have.
 *
 * Variants are taken in order and the existing `MAX_ATOMS` bound applies to the total,
 * so a later decode can never displace an atom found in the raw text. The outer loop
 * checks that bound too, before running `extractAtoms` on the next variant — otherwise
 * a saturated cap still pays for a full regex pass over every remaining variant only to
 * throw the result away, which is real amplification on attacker-controlled `PostToolUse`
 * content: base64 padding costs nothing to produce but full price to scan.
 *
 * One more pass runs after the variants: `extractAtoms` on the whitespace-continuation-
 * collapsed text (see `collapseContinuations`), recovering a package name split across
 * lines — by the `split-across-lines` mutation, or by ordinary wrapping — that
 * `LINE_END` would otherwise hide from `restOfLine`. It merges into the same deduped,
 * capped set, and is skipped only when the cap is already saturated or when collapsing
 * happens to change nothing — neither is the common case. Real markdown routinely
 * indents continuations, so on realistic prose this pass generally does run: measured at
 * ~3.2 ms against the 210 KB `vendor/bench-corpus/files/prometheus-prometheus/configuration.md`
 * latency reference (154 atoms recovered, under `MAX_ATOMS`, so the pass is never
 * short-circuited there). The guard exists for the cases where the pass genuinely has
 * nothing to add, not as a promise that it usually skips.
 *
 * Bounded to `DEFAULT_MAX_CHARS`, the same prefix `scanContent` already truncates
 * `event.toolResultText` to (`scanner.ts`), so both halves of `engine.post` read the
 * identical amount of untrusted text. Before this bound this was the one unbounded
 * regex path over attacker-controlled `PostToolUse` content: `expandVariants` walks
 * every base64/hex/url token it finds and recurses two layers deep, so on adversarial
 * nested-base64 filler with no atoms in it at all, extraction cost scaled with input
 * size with no ceiling — measured on 2.8 MB and 14.0 MB filler, ~4x slower than plain
 * `extractAtoms` on the same input (101ms vs 25ms; 459ms vs 124ms) and roughly 2.3x
 * more memory from the materialised variant strings, linear in both cases but
 * unbounded. Truncating first caps both.
 *
 * This can only lose a real atom past `DEFAULT_MAX_CHARS` — exactly where
 * `scanContent`'s own rule matching is already blind to it, since the two now read the
 * same bounded prefix of the same text. Provenance never sees further than content
 * rules already don't, so the bound costs nothing a rule wasn't already going to miss.
 * That is true of the rules and not of provenance, which can later be asked about an
 * atom that was cut off here: `extractAtomsDeepWithLoss` says when one may have been.
 */
export function extractAtomsDeep(text: string): Atom[] {
  return extractAtomsDeepWithLoss(text).atoms;
}

/**
 * `extractAtomsDeep`, and whether any bound it applies left an atom out. The recording side
 * needs the second half: this function is the only place that knows the text it was given
 * was longer than it reads, or held more atoms than it keeps, and nothing downstream can
 * tell a dropped atom from one that was never there. A session that dropped one has to say
 * so, or a later action carrying exactly that atom looks like it came from nowhere.
 *
 * Reaching `MAX_ATOMS` of the atoms that raise the floor counts as a loss even when nothing more
 * was found: the variants and
 * the continuation pass after it are skipped once the cap is full, and what they would have
 * added cannot be known without paying for the passes the cap exists to avoid. A result that
 * holds exactly that many is read as cut, which costs nothing real.
 *
 * The continuation pass is held to the window only for a command that says it is wrapped
 * (see `wrappedCommandCut`): joining every indented line makes a long line of any indented
 * block, and read as a cut that flagged ordinary workflows, Makefiles and README blocks.
 */
export function extractAtomsDeepWithLoss(text: string): AtomExtraction {
  const cutText = text.length > DEFAULT_MAX_CHARS;
  const bounded = cutText ? text.slice(0, DEFAULT_MAX_CHARS) : text;
  const set = createAtomSet(MAX_ATOMS, MAX_NETWORK_ATOMS);
  let truncated = cutText;
  const merge = (extraction: Extraction, byLine = true): void => {
    // A spent budget is a loss in every pass, the joined one included; a line longer than the
    // window is one only where it is not just a block of indented lines read as a single line.
    truncated =
      truncated || extraction.capped || extraction.budgetSpent || (byLine && extraction.lineCut);
    for (const atom of extraction.atoms) set.add(atom);
  };

  for (const variant of expandVariants(bounded)) {
    if (set.floorFull) break;
    merge(extractBounded(variant.text));
  }

  if (!set.floorFull) {
    const collapsed = collapseContinuations(bounded);
    if (collapsed !== bounded) {
      merge(extractBounded(collapsed), false);
      truncated = truncated || wrappedCommandCut(bounded);
    }
  }

  return { atoms: set.atoms, truncated: truncated || set.floorFull || set.floorLeftOut };
}
