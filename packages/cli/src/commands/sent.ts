// `stroq sent`: did your AI agent pass your keys on?
//
// THE NAME. "leaked" asserts a breach, and what this command sees is that a key was in a
// recorded call, a result or a message. `sent` reads as a pair with `stroq replay`: both
// look back, and both work on sessions that ran before Stroq was installed.
//
// THE KEYS. Unlike `stroq replay`, which runs a transcript through a throwaway engine so
// that looking at history never reads the operator's credential files, this command reads
// this machine's real key files: it cannot find a recorded value without knowing it. That
// is said in the usage text, in the output and in the docs. The values are held in memory
// only (`sent/keys.ts`). Nothing is written, not the live guard's index and not a copy of
// it, and nothing but names, sources and places is printed.
//
// THE SCOPE. With no argument it reads every session on this machine that the agents still
// keep, in one pass that parses only the sessions holding a key (`sent/scan-sessions.ts`).
import { homedir } from 'node:os';
import { statSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AuditLog, displayPath } from '@stroq/core';
import { auditFile, stroqHome } from '../paths.js';
import { writeErrUnfiltered } from '../terminal-safe.js';
import { stroqVersion } from '../version.js';
import { auditReport } from '../sent/audit.js';
import { buildCard, cardHtml, cardMarkdown } from '../sent/card.js';
import { buildCounts } from '../sent/counts.js';
import { cursorUnavailable, splitCursorSessionPath } from '../sent/cursor.js';
import { formatSent } from '../sent/format.js';
import { belongsHere, sessionBelongsHere } from '../sent/here.js';
import { gitRemoteReader } from '../sent/git-remote.js';
import { loadMcpServers } from '../sent/mcp-config.js';
import {
  newestTranscript,
  readerForFile,
  readerLabels,
  readerNotices,
  READER_ROOTS,
} from '../sent/readers.js';
import type { SentReport, SentScope } from '../sent/report.js';
import { checkSessions, progressLine, type RunEnv } from '../sent/run.js';
import { sampleReport } from '../sent/sample.js';
import {
  claudeSession,
  codexSession,
  cursorSessions,
  machineSessions,
  type SessionRef,
} from '../sent/sessions.js';

type FailIf = 'third-party' | 'any' | null;

interface Output {
  readonly json: boolean;
  readonly counts: boolean;
  /** Print the card (`--card`): counts and services, nothing the report names. */
  readonly card: boolean;
  readonly html: boolean;
  /** Write the card to this file, if it does not exist. */
  readonly path: string | null;
  readonly failIf: FailIf;
}

const USAGE = `stroq sent: did your AI agent pass your keys on?

  stroq sent                        check every session on this machine
  stroq sent --here                 only the sessions of this project
  stroq sent --last                 only the newest session of this project
  stroq sent --transcript <path>    one transcript or rollout (Cursor: <store>#<session>)
  stroq sent <session-id>           a session from Stroq's own log
  stroq sent --try                  a built-in sample with a made-up key; reads nothing

Output:
  --json               the full report as JSON: names, sources and hosts, never a value
  --counts             numbers only, as JSON, for a fleet script: no names, paths or hosts
  --card               a card to share: counts and services only (--json prints it as JSON)
  --html               with --card: one HTML file with no script and no external resource
  --out <file>         with --card: write it to <file>, never over an existing file
  --fail-if <level>    exit 1 when a key was found: third-party (sent to another company)
                       or any. A call to another company that was stopped counts for
                       third-party too: an agent that tried to send a key out is worth
                       an alarm.
  --fail-on-finding    the same as --fail-if any
  -h, --help           show this

Reads sessions recorded by ${readerLabels()}. To know what to look for, it reads
the key files on this machine and the decoy files \`stroq canary\` planted, and
holds the values in memory only. It prints names and sources, never a value, and
writes no file but the card --out names. A finding exits 0 unless you ask with
--fail-if: a session that already happened cannot be changed by today's commit.
`;

/** What to do when there is no session to read. Both of these work with no session. */
const NO_SESSION_NEXT =
  'Nothing to read yet? Two commands need no session:\n' +
  '  stroq sent --try          run the check on a built-in sample\n' +
  '  stroq init --agent <name> guard the next session, then check it with `stroq sent`\n';

/**
 * The exit code `--fail-if` asks for. A call filed as stopped counts as what it would have
 * been: that it was stopped is read from its result, and a command can print that result.
 */
function gate(report: SentReport, failIf: FailIf): number {
  if (failIf === 'any') return report.findings.length > 0 ? 1 : 0;
  if (failIf === 'third-party')
    return report.findings.some((f) => (f.place.wouldBe ?? f.tier) === 'third_party') ? 1 : 0;
  return 0;
}

/** Prints what was asked for and returns the exit code. */
function emit(report: SentReport, out: Output, home: string): number {
  const code = gate(report, out.failIf);
  const counts = buildCounts(report, stroqVersion());
  if (out.counts) {
    process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
    return code;
  }
  if (!out.card) {
    process.stdout.write(
      out.json ? `${JSON.stringify(report, null, 2)}\n` : formatSent(report, home),
    );
    return code;
  }
  const card = buildCard(counts);
  const text = out.json
    ? `${JSON.stringify(card, null, 2)}\n`
    : out.html
      ? cardHtml(card)
      : cardMarkdown(card);
  if (out.path === null) {
    process.stdout.write(text);
    return code;
  }
  try {
    // `wx`: an existing file, or a link where it would go, is refused and not written through.
    writeFileSync(out.path, text, { flag: 'wx', mode: 0o644 });
  } catch (err) {
    const why =
      (err as NodeJS.ErrnoException).code === 'EEXIST' ? 'it exists' : (err as Error).message;
    process.stderr.write(`not written: ${out.path} (${why})\n`);
    return 2;
  }
  process.stdout.write(`wrote ${out.path}\n`);
  return code;
}

export { sessionBelongsHere };

/** The session a named file or Cursor address is, read by the agent that wrote it. */
async function refFor(agent: string, path: string): Promise<SessionRef | null> {
  if (agent === 'codex') return codexSession(path);
  if (agent === 'cursor') {
    const { db, session } = splitCursorSessionPath(path);
    return (await cursorSessions(db, session))[0] ?? null;
  }
  return claudeSession(path);
}

const isEmpty = (path: string): boolean => {
  try {
    return statSync(path).size === 0;
  } catch {
    return true;
  }
};

/**
 * Whether the answer goes to a script or a card rather than a person. With no session to read,
 * a script still gets its JSON, and exit 0: a machine with no agent on it is the common case on
 * a managed laptop, and exit 1 is what `--fail-if` uses for a key that was found.
 */
const forMachines = (out: Output): boolean => out.json || out.counts || out.card;

/** No session to read: a report of none for a script, a note and exit 1 for a person. */
async function noSession(
  lead: string,
  run: RunEnv,
  out: Output,
  scope: { readonly scope: SentScope; readonly cursorUnavailable: string | null },
): Promise<number> {
  if (forMachines(out)) return emit(await checkSessions([], run, scope), out, run.home);
  const notices = await readerNotices();
  process.stdout.write(
    `${lead}\n` + notices.map((why) => `  note: ${why}\n`).join('') + NO_SESSION_NEXT,
  );
  return 1;
}

/** `--last` and `--transcript`: one session. */
async function checkOne(transcript: string | undefined, run: RunEnv, out: Output): Promise<number> {
  const found =
    transcript === undefined
      ? await newestTranscript(run.cwd)
      : // Chosen by what is in the file, not by where it is.
        { reader: await readerForFile(transcript), path: transcript };
  const none = async () => ({
    scope: 'last' as const,
    cursorUnavailable: await cursorUnavailable(),
  });
  if (found === null)
    return noSession(
      `No agent session found. Looked in ${READER_ROOTS()}.`,
      run,
      out,
      await none(),
    );
  const ref = await refFor(found.reader.agent, found.path);
  if (ref === null || (ref.agent !== 'cursor' && isEmpty(ref.path))) {
    process.stdout.write(`Nothing is recorded in ${found.path}.\n`);
    return 1;
  }
  // `--last` falls back to the newest session anywhere when this folder has none: that one
  // is named, not checked as this project's.
  if (transcript === undefined && ref.cwd !== null && !sessionBelongsHere(run.cwd, ref.cwd)) {
    if (forMachines(out)) return emit(await checkSessions([], run, await none()), out, run.home);
    process.stdout.write(
      `No agent session was recorded in ${run.cwd}.\n` +
        `The newest one on this machine ran in ${ref.cwd}. Run \`stroq sent --last\` there,\n` +
        'or name a session with --transcript <path>, or check them all with `stroq sent`.\n',
    );
    return 1;
  }
  const report = await checkSessions([ref], run, {
    scope: transcript === undefined ? 'last' : 'transcript',
    cursorUnavailable: null,
    ...(found.sessions === undefined ? {} : { inProject: found.sessions }),
  });
  return emit(report, out, run.home);
}

/** No target: every session on this machine, or with `--here` this project's. */
async function checkMany(here: boolean, run: RunEnv, out: Output): Promise<number> {
  const machine = await machineSessions(run.home, run.env);
  const isHere = belongsHere(run);
  const refs = here ? machine.sessions.filter(isHere) : machine.sessions;
  // Sessions `--here` cannot place are counted, so the report can say they were not read.
  const skipped = here ? machine.sessions.filter((r) => r.cwd === null && !isHere(r)).length : 0;
  if (refs.length === 0)
    return noSession(
      here
        ? `No agent session was recorded in ${run.cwd}. Looked in ${READER_ROOTS()}.`
        : `No agent session found on this machine. Looked in ${READER_ROOTS()}.`,
      run,
      out,
      { scope: here ? 'project' : 'machine', cursorUnavailable: machine.cursorUnavailable },
    );
  const progress = progressLine(process.stderr.isTTY === true, writeErrUnfiltered);
  try {
    const report = await checkSessions(
      refs,
      { ...run, ...(progress === null ? {} : { progress: progress.update }) },
      {
        scope: here ? 'project' : 'machine',
        cursorUnavailable: machine.cursorUnavailable,
        skipped,
      },
    );
    progress?.end();
    return emit(report, out, run.home);
  } finally {
    progress?.end();
  }
}

/** `stroq sent <session-id>`: a session from Stroq's own audit log. */
async function checkAudit(sessionId: string, run: RunEnv, out: Output): Promise<number> {
  let entries;
  try {
    entries = await new AuditLog(auditFile()).readAll();
  } catch {
    process.stdout.write("Stroq's own log could not be read.\n");
    return 1;
  }
  const report = auditReport(entries, sessionId, {
    mcp: loadMcpServers({ home: run.home, projectDirs: [run.cwd] }),
    cwd: run.cwd,
    gitRemote: gitRemoteReader(),
    now: run.now,
    logPath: displayPath(auditFile(), run.home),
  });
  if (report === null) {
    process.stdout.write(
      `Stroq's own log has no session ${sessionId}.\n` +
        'Run `stroq sent` to read the agents’ own records instead: that works on sessions\n' +
        'from before Stroq was installed, and it sees what each call returned.\n',
    );
    return 1;
  }
  return emit(report, out, run.home);
}

function parse(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    options: {
      json: { type: 'boolean' },
      counts: { type: 'boolean' },
      card: { type: 'boolean' },
      html: { type: 'boolean' },
      out: { type: 'string' },
      last: { type: 'boolean' },
      here: { type: 'boolean' },
      transcript: { type: 'string' },
      try: { type: 'boolean' },
      'fail-if': { type: 'string' },
      'fail-on-finding': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
}

/** A usage mistake, or null. */
function misuse(
  values: ReturnType<typeof parse>['values'],
  positionals: readonly string[],
): string | null {
  const one = values.last === true || values.transcript !== undefined || positionals.length > 0;
  if (values.card !== true && (values.html === true || values.out !== undefined))
    return '--html and --out go with --card';
  if (values.card === true && values.counts === true)
    return '--card and --counts are two answers; pick one';
  if (values.try === true && (one || values.here === true))
    return '--try does not take a session, --here, --last, or --transcript';
  if (values.here === true && one)
    return '--here reads this project’s sessions; it does not take one session';
  const failIf = values['fail-if'];
  if (failIf !== undefined && failIf !== 'third-party' && failIf !== 'any')
    return `--fail-if takes third-party or any, not ${failIf}`;
  return null;
}

export async function runSent(args: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parse(args);
  } catch (err) {
    // An unknown flag is the visitor invoking the command wrong: usage and exit 2.
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  // `--help` prints usage before any file is opened.
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  const wrong = misuse(values, positionals);
  if (wrong !== null) {
    process.stderr.write(`${wrong}\n\n${USAGE}`);
    return 2;
  }
  const failIf = values['fail-if'];
  const out: Output = {
    json: values.json === true,
    counts: values.counts === true,
    card: values.card === true,
    html: values.html === true || (values.out?.toLowerCase().endsWith('.html') ?? false),
    path: values.out ?? null,
    failIf:
      failIf === 'third-party' || failIf === 'any'
        ? failIf
        : values['fail-on-finding'] === true
          ? 'any'
          : null,
  };
  const home = homedir();
  if (values.try === true) return emit(sampleReport(new Date()), out, home);
  const run: RunEnv = {
    home,
    cwd: process.cwd(),
    env: process.env,
    now: new Date(),
    stroqHome: stroqHome(),
  };
  if (values.transcript !== undefined || values.last === true)
    return checkOne(values.transcript, run, out);
  const sessionId = positionals[0];
  if (sessionId !== undefined) return checkAudit(sessionId, run, out);
  return checkMany(values.here === true, run, out);
}
