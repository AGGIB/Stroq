// `stroq sent` — which of your credentials already reached a model provider.
//
// THE NAME. The plan called this `stroq leaked`, which is the punchiest option and
// the wrong one: "leaked" asserts a breach, and what this command observes is that a
// value was in the traffic between an agent and its model. Those are different
// claims, and the second one is the true one. `stroq exposure --context` was rejected
// for a different reason — `exposure` maps this machine's live surface and exits 1 on
// findings, while this reads session history and deliberately does not, so folding
// them together would give one command two incompatible contracts. `stroq context`
// collides with the "context the agent reads" row `exposure` already prints, which
// means instruction files, not credentials. `sent` states exactly the observation and
// nothing more, and it reads as a pair with `stroq replay`: both are retrospective,
// both work on sessions that ran before Stroq was installed.
//
// THE SECRET INDEX. Unlike `stroq replay`, which runs a transcript through a
// throwaway engine with a fake home precisely so that inspecting history never reads
// the operator's credential files, this command uses the REAL index at
// `~/.stroq/secrets.json`, built from this machine's real credential files. It has
// to: it cannot tell you a value reached a model without knowing the value. That is
// stated in the usage text, in the command's own output, and in the docs, because a
// tool that quietly starts reading `~/.aws/credentials` is a nasty surprise however
// good its reason. Nothing is written or printed but names and sources — matching
// goes through the same salted-hash lookup the live guard uses.
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { AuditLog, FileSecretIndex } from '@stroq/core';
import { auditFile, secretsFile } from '../paths.js';
import { formatSent } from '../sent/format.js';
import { newestTranscript, readerForFile, READER_ROOTS } from '../sent/readers.js';
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
 * green by fixing the present: a credential that reached a model three weeks ago will
 * still have reached it after every commit on the branch. A gate that can never be
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

const USAGE = `stroq sent — which of your credentials already reached a model provider

  stroq sent --last                 read the newest session in this directory
  stroq sent --transcript <path>    read a specific transcript or rollout
  stroq sent [<session-id>]         read a session Stroq itself recorded

Flags:
  --json               emit the report as JSON
  --fail-on-finding    exit 1 when a credential is found (for a scheduled job)
  -h, --help           show this

Reads Claude Code transcripts and Codex CLI rollouts; --transcript works out
which from the file itself. It reads this machine's credential files to know what
to look for, and prints names and sources only, never a value. A finding exits 0
by default: a session that already happened cannot be un-sent by today's commit.
`;

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
  // Built before anything is scanned so the report can state what it matched against.
  // A report that found nothing because the index was empty must not read like a
  // report that found nothing because the session was clean.
  const stats = await index.refresh(cwd);
  const scope: SentIndexScope = {
    cwd,
    home,
    sourcePaths: index.sourcePaths(cwd),
    indexedSecrets: stats.entries + stats.canaries,
  };

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
      process.stdout.write(`no agent transcript found — looked under ${READER_ROOTS()}\n`);
      return 1;
    }
    const transcript = await found.reader.read(found.path);
    if (transcript.events.length === 0) {
      process.stdout.write(`no tool calls recorded in ${found.path}\n`);
      return 1;
    }
    const report = await scanTranscript(
      transcript,
      { agent: found.reader.agent, path: found.path },
      index,
      scope,
    );
    return emit(report, out);
  }

  const entries = await new AuditLog(auditFile()).readAll();
  const sessionId = positionals[0] ?? sessionsIn(entries)[0];
  if (sessionId === undefined) {
    process.stdout.write(
      'no audit entries yet — Stroq was not running for any session it can see.\n' +
        "Run `stroq sent --last` to read the agent's own transcript instead: that works\n" +
        'on sessions from before Stroq was installed, and it can see tool results.\n',
    );
    return 1;
  }
  return emit(scanAuditLog(entries, sessionId, scope), out);
}
