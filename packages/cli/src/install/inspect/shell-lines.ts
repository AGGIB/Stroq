// The lines that the shell text of an artifact gives.
//
// All the shell text the readers queued is read here, once, under one budget: a count of pieces, a
// size for each and a size in all. The same text found in ten places is read once and its lines get ten
// places. What each reading means for a passport:
//
// - an address is a `net` line, sensitive when a command that talks to the network was recognised in
//   the same text (an address in an `echo` is only a mention);
// - a credential file is a `cred.file` line;
// - the classes that are dangerous in themselves (a download that is run, a destructive delete, a write
//   to a startup file, a git setting that runs a program) are signals;
// - text that could not be read is an `exec` line on the basis `unknown`, because that is exactly
//   what it is: a command whose effect is not known;
// - the programs a text runs are `exec` lines, sensitive for the ones that run other programs or reach
//   the network.
import {
  SHELL_PLACEMENT_MAX,
  SHELL_SNIPPET_COUNT_MAX,
  SHELL_SNIPPET_MAX,
  SHELL_TOTAL_MAX,
  SHELL_TOTAL_MS,
} from './blind-spots.js';
import type { Findings } from './findings.js';
import { readShell, type Reading } from './shell-reading.js';
import type { ShellQueue, ShellSnippet, SnippetOrigin } from './shell-queue.js';
import { LineIndex } from './text-files.js';

const ORIGIN_NOTE: Readonly<Record<SnippetOrigin, string>> = {
  doc: 'shell text in a document, an example that may be run',
  hook: 'a hook the artifact declares, which the host runs',
  inline: 'an inline command that the host runs when it loads the skill',
  launch: 'a command the artifact declares to start a server',
  script: 'a script of the artifact',
  'package-script': 'a script of a package that is run on request',
};

const READING = "read by Stroq's shell reader; a signal to look at, not a verdict";

/** Programs that run other programs, reach the network, or fetch and run a package. */
const RISKY_PROGRAMS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'env',
  'sudo',
  'su',
  'doas',
  'eval',
  'exec',
  'source',
  '.',
  'xargs',
  'node',
  'nodejs',
  'deno',
  'bun',
  'python',
  'python2',
  'python3',
  'perl',
  'ruby',
  'php',
  'lua',
  'osascript',
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'telnet',
  'ftp',
  'npx',
  'pnpx',
  'bunx',
  'uvx',
  'pipx',
  'powershell',
  'pwsh',
  'cmd',
  'iex',
  'invoke-expression',
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'invoke-command',
  'start-process',
  'crontab',
  'launchctl',
  'systemctl',
  'at',
  'batch',
]);

const basename = (word: string): string => word.slice(word.lastIndexOf('/') + 1);

/** A line of a place in a piece of text, counted from the line the text begins on. */
function placeOf(snippet: ShellSnippet, lines: LineIndex, token: string | null): number {
  if (token === null || token === '') return snippet.line;
  const at = snippet.text.indexOf(token);
  return at === -1 ? snippet.line : snippet.line + lines.lineAt(at) - 1;
}

/** What the emitters of one piece of text share: where it is, what was read of it, and how to point at a token. */
interface Emitting {
  readonly snippet: ShellSnippet;
  readonly reading: Reading;
  readonly note: string;
  readonly findings: Findings;
  /** The line of the file that a token of the text is on. */
  readonly at: (token: string | null) => number;
}

function emitHosts({ snippet, reading, note, findings, at }: Emitting): void {
  const how = reading.talksToNetwork
    ? 'a command that talks to the network was recognised'
    : 'named in the text, not known to be contacted';
  for (const found of reading.hosts) {
    findings.line({
      file: snippet.file,
      kind: 'net',
      subject: found.host ?? 'unknown',
      basis: found.host === null ? 'unknown' : 'observed',
      sensitive: reading.talksToNetwork,
      line: at(found.url),
      detector: `an address in ${note}, ${READING}; ${how}`,
    });
  }
  if (reading.talksToNetwork && reading.hosts.length === 0) {
    findings.line({
      file: snippet.file,
      kind: 'net',
      subject: 'unknown',
      basis: 'unknown',
      sensitive: true,
      line: snippet.line,
      detector: `a command that talks to the network in ${note} with an address that is not written out, ${READING}`,
    });
  }
}

function emitCredentials({ snippet, reading, note, findings, at }: Emitting): void {
  if (!reading.hasCredentialFile) return;
  const named = reading.credentialFiles.length > 0;
  for (const file of named ? reading.credentialFiles : ['a credential file']) {
    findings.line({
      file: snippet.file,
      kind: 'cred.file',
      subject: file,
      basis: 'observed',
      sensitive: true,
      line: at(named ? file : null),
      detector: `a credential file named in ${note}, ${READING}`,
    });
  }
}

function emitClasses({ snippet, reading, note, findings }: Emitting): void {
  for (const found of reading.classes) {
    findings.signal({
      ruleId: found.action,
      file: snippet.file,
      line: snippet.line,
      sensitive: true,
      detail: found.ids.slice(0, 3).join(', '),
      detector: `${found.action} in ${note}, ${READING}`,
    });
  }
}

function emit(snippet: ShellSnippet, reading: Reading, findings: Findings): void {
  const lines = new LineIndex(snippet.text);
  const emitting: Emitting = {
    snippet,
    reading,
    note: ORIGIN_NOTE[snippet.origin],
    findings,
    at: (token) => placeOf(snippet, lines, token),
  };
  emitHosts(emitting);
  emitCredentials(emitting);
  emitClasses(emitting);
  emitUnread(emitting);
  // The scripts of a package that run only on request (`test`, `build`) are mostly its own tools: they
  // are read for addresses and dangers, and not listed program by program. A launch command is already
  // an exec line of its own, declared by the manifest.
  if (snippet.origin !== 'package-script' && snippet.origin !== 'launch') emitPrograms(emitting);
}

function emitPrograms({ snippet, reading, note, findings, at }: Emitting): void {
  for (const program of reading.programs) {
    findings.line({
      file: snippet.file,
      kind: 'exec',
      subject: program,
      basis: 'observed',
      sensitive: RISKY_PROGRAMS.has(basename(program)),
      line: at(program),
      detector: `a command in ${note}, ${READING}`,
    });
  }
  if (reading.dynamicProgram) {
    findings.line({
      file: snippet.file,
      kind: 'exec',
      subject: 'a command named at run time',
      basis: 'unknown',
      sensitive: true,
      line: snippet.line,
      detector: `a command word made by a variable or a substitution in ${note}, ${READING}`,
    });
  }
}

const UNREAD_SUBJECT = {
  unparsed: 'shell text that could not be read',
  'too-large': 'shell text too large to read',
  'too-slow': 'shell text that took too long to read',
} as const;

function emitUnread({ snippet, reading, note, findings }: Emitting): void {
  if (reading.unreadable === null) return;
  const ids = reading.unparsedIds.slice(0, 3).join(', ');
  const what = UNREAD_SUBJECT[reading.unreadable];
  findings.line({
    kind: 'exec',
    file: snippet.file,
    line: snippet.line,
    subject: ids === '' ? what : `${what} (${ids})`,
    basis: 'unknown',
    sensitive: true,
    detector: `what the text runs could not be told, in ${note}, ${READING}`,
  });
}

/** Reads every queued piece of shell text, within the budget, and adds what it finds. */
export function addShellLines(
  queue: ShellQueue,
  findings: Findings,
  now: () => number = () => performance.now(),
): void {
  const started = now();
  const memo = new Map<string, Reading>();
  const snippets = queue.snippets();
  let skipped = queue.dropped;
  let spent = 0;
  let read = 0;
  for (const [index, snippet] of snippets.entries()) {
    if (index >= SHELL_PLACEMENT_MAX) {
      skipped += snippets.length - index;
      break;
    }
    const text =
      snippet.text.length > SHELL_SNIPPET_MAX
        ? snippet.text.slice(0, SHELL_SNIPPET_MAX)
        : snippet.text;
    if (text.length < snippet.text.length) findings.tally('shell-text-cut');
    let reading = memo.get(text);
    if (reading === undefined) {
      // The clock is a backstop for text built to be slow to read; it is not reached by a text that is not.
      const outOfTime = now() - started > SHELL_TOTAL_MS;
      if (outOfTime || read >= SHELL_SNIPPET_COUNT_MAX || spent + text.length > SHELL_TOTAL_MAX) {
        skipped += 1;
        continue;
      }
      reading = readShell(text);
      memo.set(text, reading);
      read += 1;
      spent += text.length;
    }
    emit({ ...snippet, text }, reading, findings);
  }
  if (skipped > 0) findings.tally('shell-over-budget', skipped);
}
