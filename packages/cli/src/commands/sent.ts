// `stroq sent` — credential evidence in recorded agent sessions.
//
// THE NAME. The plan called this `stroq leaked`, which is the punchiest option and
// the wrong one: "leaked" asserts a breach, and what this command observes is that a
// value was recorded in a local transcript or audit log. Those are different
// claims. `stroq exposure --context` was rejected
// for a different reason — `exposure` maps this machine's live surface and exits 1 on
// findings, while this reads session history and deliberately does not, so folding
// them together would give one command two incompatible contracts. `stroq context`
// collides with the "context the agent reads" row `exposure` already prints, which
// means instruction files, not credentials. `sent` remains the command name and
// reads as a pair with `stroq replay`: both are retrospective,
// both work on sessions that ran before Stroq was installed.
//
// THE SECRET INDEX. Unlike `stroq replay`, which runs a transcript through a
// throwaway engine with a fake home precisely so that inspecting history never reads
// the operator's credential files, this command uses the REAL index at
// `~/.stroq/secrets.json`, built from this machine's real credential files. It has
// to: it cannot match a recorded value without knowing the value. That is
// stated in the usage text, in the command's own output, and in the docs, because a
// tool that quietly starts reading `~/.aws/credentials` is a nasty surprise however
// good its reason. Nothing is written or printed but names and sources — matching
// goes through the same salted-hash lookup the live guard uses.
import { homedir, tmpdir } from 'node:os';
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AuditLog, FileSecretIndex } from '@stroq/core';
import { auditFile, secretsFile } from '../paths.js';
import { formatSent } from '../sent/format.js';
import {
  newestTranscript,
  readerForFile,
  readerLabels,
  readerNotices,
  READER_ROOTS,
} from '../sent/readers.js';
import type { Transcript } from '../replay/transcript.js';
import type { SentReport } from '../sent/report.js';
import { scanAuditLog, scanTranscript, type SentIndexScope } from '../sent/scan.js';
import { sessionsIn } from './replay.js';

interface Output {
  readonly json: boolean;
  readonly failOnFinding: boolean;
}

/**
 * EXIT CODE. Zero whenever a report was produced, even one naming a credential.
 *
 * The question this command answers is about the past, and a build cannot be made
 * green by fixing the present: a credential recorded three weeks ago will
 * still be in that record after every commit on the branch. A gate that can never be
 * satisfied is a gate that gets deleted, taking the check with it. `stroq exposure`
 * exits 1 on findings for the opposite reason — everything it reports is a setting on
 * this machine that can be changed today.
 *
 * Exit 1 is reserved for "no report": no transcript, no tool calls in it, no audit
 * entries. That matches `stroq replay` and means a non-zero exit here always says the
 * command could not answer, never that the answer was bad. `--fail-on-finding` is the
 * opt-in for the one honest gating case — a scheduled job that should page a human
 * the first time a new credential turns up in a session.
 */
function emit(report: SentReport, out: Output): number {
  process.stdout.write(out.json ? `${JSON.stringify(report, null, 2)}\n` : formatSent(report));
  const found = report.credentials.length > 0 || report.files.length > 0;
  return out.failOnFinding && found ? 1 : 0;
}

const USAGE = `stroq sent — credential evidence in recorded agent sessions

  stroq sent --last                 read the newest session in this directory
  stroq sent --transcript <path>    read a specific transcript or rollout
  stroq sent [<session-id>]         read a session Stroq itself recorded

Flags:
  --json               emit the report as JSON
  --fail-on-finding    exit 1 when a credential is found (for a scheduled job)
  -h, --help           show this

Reads sessions recorded by ${readerLabels()}.
--transcript works out which from the file itself; a Cursor session is
addressed as <store>#<session>. It reads this machine's credential files to
know what to look for, and prints names and sources only, never a value. A
finding exits 0 by default: a session that already happened cannot be
changed by today's commit. A transcript match does not confirm provider delivery.
`;

/**
 * `path` with symlinks resolved as far as it exists: a project reached through a link
 * (`/var` → `/private/var` on macOS) is the same project, and a recorded file that has
 * since been deleted is resolved through the nearest directory that is still there.
 */
function real(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(real(parent), basename(absolute));
  }
}

/** Whether `dir` is `root` or somewhere inside it. */
function isWithin(dir: string, root: string): boolean {
  const rel = relative(real(root), real(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Whether a session recorded at `recorded` is this directory's. Either contains the
 * other: a session that ran in a directory containing this one is the same project,
 * and Cursor records the files a session touched rather than a working directory, so
 * its `cwd` is a path inside the project — which 0.20.0 read as another project and
 * refused, for every Cursor session.
 */
export function sessionBelongsHere(cwd: string, recorded: string): boolean {
  return isWithin(cwd, recorded) || isWithin(recorded, cwd);
}

/** Builds the index for `dir`'s project `.env` files and says what it holds. */
async function buildScope(
  index: FileSecretIndex,
  dir: string,
  home: string,
): Promise<SentIndexScope> {
  // Built before anything is scanned so the report can state what it matched against.
  // A report that found nothing because the index was empty must not read like a
  // report that found nothing because the session was clean.
  const stats = await index.refresh(dir);
  return {
    cwd: dir,
    home,
    sourcePaths: index.sourcePaths(dir),
    indexedSecrets: stats.entries + stats.canaries,
  };
}

/**
 * The folder whose `.env` files belong to a session recorded at `recorded`. The
 * session's own folder, when it is one and still there: that is where the agent was
 * started, and so where the project's secrets are, whichever folder of the project
 * `stroq sent` was run from. A recorded FILE (Cursor names the files a session touched,
 * not a folder) or one that has gone says nothing better than the directory we are in.
 */
function projectDirOf(recorded: string | null, cwd: string): string {
  if (recorded === null) return cwd;
  try {
    return statSync(recorded).isDirectory() ? recorded : cwd;
  } catch {
    return cwd;
  }
}

/**
 * Scans `transcript` against this folder's index, or, when the session ran in another
 * folder of the project, against a PRIVATE copy of that index that also reads the other
 * folder's `.env` files.
 *
 * Private, because `~/.stroq/secrets.json` is the live guard's index and is rebuilt for
 * whichever folder it is asked about: building it for a folder the guard never runs in
 * would drop that guard's own project sources, and a sealed sandbox run (which trusts
 * the file as it stands) would then not know the project's secrets. The copy carries
 * the salt and the canaries, so a canary is still found; it is deleted when the scan ends.
 */
async function scanInProject(
  transcript: Transcript,
  source: { readonly agent: string; readonly path: string },
  where: {
    readonly index: FileSecretIndex;
    readonly scope: SentIndexScope;
    readonly cwd: string;
    readonly projectDir: string;
    readonly home: string;
  },
): Promise<SentReport> {
  if (where.projectDir === where.cwd)
    return scanTranscript(transcript, source, where.index, where.scope);
  const scratch = mkdtempSync(join(tmpdir(), 'stroq-sent-index-'));
  try {
    const copy = join(scratch, 'secrets.json');
    if (existsSync(secretsFile())) copyFileSync(secretsFile(), copy);
    // Both folders, whichever one the scan is asked about: the index reads its own
    // argument's `.env` plus these, so the union is the same from either.
    const both = new FileSecretIndex(copy, where.home, process.env, undefined, [
      where.cwd,
      where.projectDir,
    ]);
    // The session's own folder is the scope's `cwd`, so a `.env` it named by a relative
    // path is recognised; the absolute paths of both folders' files are all in the index.
    const scope = {
      ...(await buildScope(both, where.cwd, where.home)),
      cwd: where.projectDir,
      projectDirs: [where.projectDir, where.cwd],
    };
    return await scanTranscript(transcript, source, both, scope);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * What to do when there is no session to read. A newcomer's first run, before any agent
 * has been used in this directory, used to end on a line that named only what was
 * missing. Both of these work with no session and no install.
 */
const NO_SESSION_NEXT =
  'Nothing to read yet? Two commands need no session:\n' +
  '  stroq attack              replay the attack corpus against the default policy\n' +
  '  stroq init --agent <name> guard the next session, then read it with `stroq sent`\n';

export async function runSent(args: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        json: { type: 'boolean' },
        last: { type: 'boolean' },
        transcript: { type: 'string' },
        'fail-on-finding': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (err) {
    // An unknown flag is the visitor invoking the command wrong, not a Stroq
    // fault: answer with the usage line and exit 2, never the raw parser throw.
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  // `--help` is the first thing typed after a command the front page says to run,
  // so it must print usage before any credential file is opened.
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  const out: Output = {
    json: values.json === true,
    failOnFinding: values['fail-on-finding'] === true,
  };

  const cwd = process.cwd();
  const home = homedir();
  const index = new FileSecretIndex(secretsFile(), home);
  const scope = await buildScope(index, cwd, home);

  // The transcript branch is the one that needs no install: the agent recorded the
  // session itself, result text and all, so a credential that only ever appeared in
  // a tool's output can still be found here.
  if (values.transcript !== undefined || values.last === true) {
    const found =
      values.transcript === undefined
        ? await newestTranscript(cwd)
        : // Chosen by what is in the file, not by where it is: a Codex rollout
          // parsed as a Claude transcript yields no events at all, which prints
          // as a clean session rather than as the mistake it is.
          { reader: await readerForFile(values.transcript), path: values.transcript };
    if (found === null) {
      // Any reader that could not look at all says so here. Without it, an agent
      // Stroq cannot read on this machine is indistinguishable from an agent that
      // was never used in this directory.
      const notices = await readerNotices();
      process.stdout.write(
        `no agent transcript found — looked under ${READER_ROOTS()}\n` +
          notices.map((why) => `  note: ${why}\n`).join('') +
          NO_SESSION_NEXT,
      );
      return 1;
    }
    const transcript = await found.reader.read(found.path);
    // `--last` falls back to the newest session anywhere when this directory has
    // none. Scanned, that session would be matched against THIS project's `.env` and
    // reported as this directory's, so it is named instead. A session recorded in a
    // directory that contains this one is the same project and is read.
    if (
      values.transcript === undefined &&
      transcript.cwd !== null &&
      !sessionBelongsHere(cwd, transcript.cwd)
    ) {
      process.stdout.write(
        `no agent session recorded in ${cwd}.\n` +
          `The newest one on this machine ran in ${transcript.cwd}: run \`stroq sent --last\` there,\n` +
          'or name a session with --transcript <path>.\n',
      );
      return 1;
    }
    if (transcript.events.length === 0) {
      process.stdout.write(`no tool calls recorded in ${found.path}\n`);
      return 1;
    }
    // `--last` has confirmed the session is this project's, so the `.env` files of the
    // folder it ran in are compared as well as the ones here: the value can be in either.
    const projectDir = values.transcript === undefined ? projectDirOf(transcript.cwd, cwd) : cwd;
    const report = await scanInProject(
      transcript,
      { agent: found.reader.agent, path: found.path },
      { index, scope, cwd, projectDir, home },
    );
    return emit(
      found.sessions === undefined
        ? report
        : { ...report, coverage: { ...report.coverage, sessionsInProject: found.sessions } },
      out,
    );
  }

  const entries = await new AuditLog(auditFile()).readAll();
  const sessionId = positionals[0] ?? sessionsIn(entries)[0];
  if (sessionId === undefined) {
    process.stdout.write(
      'no audit entries yet — Stroq was not running for any session it can see.\n' +
        "Run `stroq sent --last` to read the agent's own transcript instead: that works\n" +
        'on sessions from before Stroq was installed, and it can see tool results.\n' +
        NO_SESSION_NEXT,
    );
    return 1;
  }
  return emit(scanAuditLog(entries, sessionId, scope), out);
}
