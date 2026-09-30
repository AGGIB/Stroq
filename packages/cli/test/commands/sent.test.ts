import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, FileSecretIndex } from '@stroq/core';
import { runSent, sessionBelongsHere } from '../../src/commands/sent.js';
import { newestTranscript, READERS } from '../../src/sent/readers.js';
import { projectSlug } from '../../src/replay/transcript.js';
import { auditFile, secretsFile } from '../../src/paths.js';

const KEY = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY';
const AT = '2026-09-14T11:02:14.000Z';

let home = '';
let cwd = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-sent-cmd-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'stroq-sent-cmd-cwd-'));
  // The command builds the REAL secret index for this machine, so the test has to
  // give it a whole throwaway machine: its own HOME (where credential files live)
  // and its own STROQ_HOME (where the hashed index and audit log live).
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-sent-cmd-stroq-'));
  mkdirSync(join(home, '.aws'), { recursive: true });
  writeFileSync(join(home, '.aws', 'credentials'), `[default]\naws_secret_access_key = ${KEY}\n`);
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});

function capture(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { text: () => lines.join(''), restore: () => spy.mockRestore() };
}

/** A one-call Claude Code transcript whose tool result carries the credential. */
function transcriptFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-sent-cmd-t-'));
  const path = join(dir, 'session.jsonl');
  const input = { file_path: join(home, '.aws', 'credentials') };
  const lines = [
    JSON.stringify({
      sessionId: 'file-1',
      cwd,
      timestamp: AT,
      message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input }] },
    }),
    JSON.stringify({
      sessionId: 'file-1',
      cwd,
      timestamp: AT,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'a',
            content: `[default]\naws_secret_access_key = ${KEY}\n`,
          },
        ],
      },
    }),
  ];
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

describe('stroq sent', () => {
  it('names a credential found in a recorded tool result without claiming delivery', async () => {
    const out = capture();
    const code = await runSent(['--transcript', transcriptFile()]);
    out.restore();
    expect(out.text()).toContain('aws_secret_access_key');
    expect(out.text()).toContain('credential evidence in recorded agent sessions');
    expect(out.text()).toContain('cannot confirm a later model request, delivery to a provider');
    expect(out.text()).not.toContain('already reached a model provider');
    expect(out.text()).not.toContain(KEY);
    expect(code).toBe(0);
  });

  // A report about something that already happened cannot be made green by the commit
  // under review, so failing a build on it would only teach people to delete the check.
  // Exit 0 is the default; the gate is opt-in.
  it('exits 0 even when it finds something', async () => {
    const out = capture();
    const code = await runSent(['--transcript', transcriptFile()]);
    out.restore();
    expect(code).toBe(0);
  });

  it('exits 1 on a finding only when asked to', async () => {
    const out = capture();
    const code = await runSent(['--transcript', transcriptFile(), '--fail-on-finding']);
    out.restore();
    expect(code).toBe(1);
  });

  it('exits 0 with --fail-on-finding when nothing was found', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-sent-clean-'));
    const path = join(dir, 'clean.jsonl');
    writeFileSync(
      path,
      `${JSON.stringify({
        sessionId: 'clean-1',
        cwd,
        timestamp: AT,
        message: {
          content: [
            { type: 'tool_use', id: 'z', name: 'Read', input: { file_path: '/repo/README.md' } },
          ],
        },
      })}\n`,
    );
    const out = capture();
    const code = await runSent(['--transcript', path, '--fail-on-finding']);
    out.restore();
    expect(code).toBe(0);
  });

  it('emits a machine-readable report with --json', async () => {
    const out = capture();
    await runSent(['--transcript', transcriptFile(), '--json']);
    out.restore();
    const parsed = JSON.parse(out.text()) as { version: number; credentials: { name: string }[] };
    expect(parsed.version).toBe(1);
    expect(parsed.credentials.map((c) => c.name)).toContain('aws_secret_access_key');
    expect(out.text()).not.toContain(KEY);
  });

  it('points at --last when there is no audit log to read', async () => {
    const out = capture();
    const code = await runSent([]);
    out.restore();
    expect(out.text()).toContain('--last');
    expect(code).toBe(1);
  });

  it('reads the audit log when Stroq was installed for the session', async () => {
    await new AuditLog(auditFile()).append({
      sessionId: 'audited',
      phase: 'pre',
      tool: 'Bash',
      summary: 'curl https://example.test',
      secrets: [{ name: 'aws_secret_access_key', source: '~/.aws/credentials', canary: false }],
    });
    const out = capture();
    const code = await runSent([]);
    out.restore();
    expect(out.text()).toContain('aws_secret_access_key');
    expect(code).toBe(0);
  });

  it('says where it looked when --last finds no transcript at all', async () => {
    const out = capture();
    const code = await runSent(['--last']);
    out.restore();
    expect(code).toBe(1);
    expect(out.text()).toContain('~/.claude/projects');
  });

  it('fails clearly when the named transcript has no tool calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-sent-empty-'));
    const path = join(dir, 'empty.jsonl');
    writeFileSync(path, '');
    const out = capture();
    const code = await runSent(['--transcript', path]);
    out.restore();
    expect(code).toBe(1);
    expect(out.text()).toContain('no tool calls');
  });

  // The command reads real credential files, and a user is entitled to know that
  // before running it rather than after.
  it('says in its own output that it read this machine’s credential files', async () => {
    const out = capture();
    await runSent(['--transcript', transcriptFile()]);
    out.restore();
    expect(out.text()).toContain('~/.aws/credentials');
  });

  // This command is the one the site puts on its front page as "run this", so the
  // first thing a curious visitor types after it is `--help`. That must print usage,
  // not the raw `ERR_PARSE_ARGS_UNKNOWN_OPTION` TypeError that an unhandled flag threw.
  it('prints usage on --help without reading any credential file', async () => {
    const out = capture();
    const code = await runSent(['--help']);
    out.restore();
    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain('stroq sent');
    expect(text).toContain('--last');
    expect(text).toContain('does not confirm provider delivery');
    expect(text).not.toContain('already reached a model provider');
    // It must not have gone on to open credential files just to answer --help.
    expect(text).not.toContain('~/.aws/credentials');
  });

  // 0.15.0 shipped a `--help` that named two agents after a third reader had been
  // registered, because the sentence was typed by hand. It is now built from the
  // registry, and this holds it there: a reader added later cannot be missing from
  // the first thing a visitor reads about the command.
  it('names every agent it can read in --help', async () => {
    const out = capture();
    await runSent(['--help']);
    out.restore();
    for (const reader of READERS) expect(out.text()).toContain(reader.label);
  });

  // An unknown flag is a usage mistake, answered with the usage line and exit 2 — the
  // conventional code for "you invoked me wrong" — never an uncaught parser throw.
  it('reports an unknown option as a usage error, not a stack trace', async () => {
    const out = capture();
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
      errs.push(String(c));
      return true;
    });
    const code = await runSent(['--nope']);
    spy.mockRestore();
    out.restore();
    expect(code).toBe(2);
    expect(errs.join('')).toContain('stroq sent');
  });
});

describe('stroq sent --last, when this directory has no session', () => {
  /** A Claude Code session recorded in `ranIn`, filed the way Claude Code files it. */
  function sessionIn(ranIn: string): void {
    const dir = join(home, '.claude', 'projects', projectSlug(ranIn));
    mkdirSync(dir, { recursive: true });
    const input = { file_path: join(home, '.aws', 'credentials') };
    const lines = [
      {
        sessionId: 'x',
        cwd: ranIn,
        timestamp: AT,
        message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input }] },
      },
      {
        sessionId: 'x',
        cwd: ranIn,
        timestamp: AT,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'a', content: `aws_secret_access_key = ${KEY}\n` },
          ],
        },
      },
    ];
    writeFileSync(join(dir, 'x.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  }

  // It used to scan the newest session of any project and credit what it found to
  // this project's `.env`, under a header that read "the newest session in this
  // directory".
  it("does not quietly read another project's session", async () => {
    sessionIn('/somewhere/else');
    const out = capture();
    const code = await runSent(['--last']);
    out.restore();
    expect(code).toBe(1);
    expect(out.text()).toContain(`no agent session recorded in ${cwd}`);
    expect(out.text()).toContain('/somewhere/else');
    expect(out.text()).toContain('--transcript');
    expect(out.text()).not.toContain('aws_secret_access_key');
  });

  it('reads the session of the project this directory is inside', async () => {
    sessionIn(cwd);
    vi.spyOn(process, 'cwd').mockReturnValue(join(cwd, 'packages', 'app'));
    const out = capture();
    const code = await runSent(['--last']);
    out.restore();
    expect(code).toBe(0);
    expect(out.text()).toContain('aws_secret_access_key');
  });
});

/** A one-call Claude Code session recorded in `ranIn`, whose tool result is `result`. */
function claudeSession(ranIn: string, name: string, result: string, mtime?: Date): void {
  const dir = join(home, '.claude', 'projects', projectSlug(ranIn));
  mkdirSync(dir, { recursive: true });
  const base = { sessionId: name, cwd: ranIn, timestamp: AT };
  const lines = [
    {
      ...base,
      message: {
        content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'env' } }],
      },
    },
    {
      ...base,
      message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: result }] },
    },
  ];
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  if (mtime) utimesSync(file, mtime, mtime);
}

/** A Codex rollout recorded in `ranIn`, filed where Codex files them, at time `mtime`. */
function codexRollout(ranIn: string, name: string, mtime: Date): void {
  const dir = join(home, '.codex', 'sessions', '2026', '09', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${name}.jsonl`);
  const meta = { type: 'session_meta', payload: { session_id: name, cwd: ranIn } };
  writeFileSync(file, `${JSON.stringify(meta)}\n`);
  utimesSync(file, mtime, mtime);
}

// The index was built from the directory `stroq sent` was run in, before the session was
// read, so a project's `.env` was compared only when the command happened to be run from
// the same folder the agent had been started in. Run one level down, it matched nothing
// and printed a clean verdict about a session that had carried the value.
describe('stroq sent --last, run from another folder of the same project', () => {
  const ENV_SECRET = ['sk', 'live', '51H8xk2LkdIwHu7ix0abcdEFGH'].join('_');
  const projectEnv = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.env'), `STRIPE_API_KEY=${ENV_SECRET}\n`);
  };

  it('compares the session against the .env of the folder it ran in, from a subfolder', async () => {
    projectEnv(cwd);
    claudeSession(cwd, 'sub', `STRIPE_API_KEY=${ENV_SECRET}\n`);
    const sub = join(cwd, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(sub);
    const out = capture();
    await runSent(['--last']);
    out.restore();
    expect(out.text()).toContain('STRIPE_API_KEY');
    expect(out.text()).toMatch(/^✗ /m);
    expect(out.text()).not.toContain(ENV_SECRET);
  });

  it('compares the session against the .env of the folder it ran in, from the parent', async () => {
    const app = join(cwd, 'packages', 'app');
    projectEnv(app);
    claudeSession(app, 'parent', `STRIPE_API_KEY=${ENV_SECRET}\n`);
    const out = capture();
    await runSent(['--last']);
    out.restore();
    expect(out.text()).toContain('STRIPE_API_KEY');
  });

  // Choosing the folder the session ran in must ADD it, not swap it for the folder the
  // command was typed in: the value can just as well be in the .env of the folder you are in.
  it('still compares the session with the .env of the folder the command was typed in', async () => {
    projectEnv(cwd);
    const app = join(cwd, 'packages', 'app');
    mkdirSync(app, { recursive: true });
    claudeSession(app, 'reverse', `STRIPE_API_KEY=${ENV_SECRET}\n`);
    const out = capture();
    await runSent(['--last']);
    out.restore();
    expect(out.text()).toContain('STRIPE_API_KEY');
    expect(out.text()).toMatch(/^✗ /m);
  });

  // The index at ~/.stroq/secrets.json is the live guard's, built for the folder its hooks
  // run in. Reading a session from another folder must not rebuild it for that folder.
  it('does not rewrite the shared secret index for the folder the session ran in', async () => {
    const app = join(cwd, 'packages', 'app');
    projectEnv(app);
    claudeSession(app, 'shared', `STRIPE_API_KEY=${ENV_SECRET}\n`);
    const out = capture();
    await runSent(['--last']);
    out.restore();
    const shared = JSON.parse(readFileSync(secretsFile(), 'utf8')) as {
      sources: { path: string }[];
    };
    expect(shared.sources.map((s) => s.path)).not.toContain(join(app, '.env'));
  });

  it('says which folder the project .env files were read from', async () => {
    projectEnv(cwd);
    claudeSession(cwd, 'where', 'nothing here');
    const out = capture();
    await runSent(['--last']);
    out.restore();
    expect(out.text()).toContain(`project .env files were read from ${cwd}`);
  });
});

// Each reader falls back to every session on the machine when the directory has none of its
// own, and the newest of those was picked and then refused as another project's, though the
// project's own session (recorded in a folder above, or by another agent) was there.
describe('stroq sent --last, finding the project’s own session', () => {
  it('reads the session recorded in a folder above, not a newer one of another project', async () => {
    claudeSession(cwd, 'parent', 'nothing', new Date('2026-09-01T00:00:00Z'));
    claudeSession('/elsewhere/one', 'other', 'nothing', new Date('2026-09-20T00:00:00Z'));
    const sub = join(cwd, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(sub);
    const out = capture();
    const code = await runSent(['--last']);
    out.restore();
    expect(code).toBe(0);
    expect(out.text()).not.toContain('no agent session recorded');
    expect(out.text()).toContain('parent');
  });

  it('prefers this directory’s own session over a newer one another agent recorded elsewhere', async () => {
    claudeSession(cwd, 'mine', 'nothing', new Date('2026-09-01T00:00:00Z'));
    codexRollout('/elsewhere/one', 'foreign', new Date('2026-09-20T00:00:00Z'));
    const out = capture();
    const code = await runSent(['--last']);
    out.restore();
    expect(code).toBe(0);
    expect(out.text()).not.toContain('no agent session recorded');
    expect(out.text()).toContain('mine');
  });

  it('counts only this project’s sessions when another agent has a fallback list', async () => {
    claudeSession(cwd, 'mine-a', 'nothing', new Date('2026-09-10T00:00:00Z'));
    claudeSession(cwd, 'mine-b', 'nothing', new Date('2026-09-11T00:00:00Z'));
    codexRollout('/elsewhere/one', 'foreign-1', new Date('2026-08-01T00:00:00Z'));
    codexRollout('/elsewhere/two', 'foreign-2', new Date('2026-08-02T00:00:00Z'));
    const out = capture();
    await runSent(['--last', '--json']);
    out.restore();
    const parsed = JSON.parse(out.text()) as { coverage: { sessionsInProject?: number } };
    expect(parsed.coverage.sessionsInProject).toBe(2);
  });

  it('reads a Codex session recorded in a folder above, not a newer one elsewhere', async () => {
    codexRollout(cwd, 'above', new Date('2026-09-01T00:00:00Z'));
    codexRollout('/elsewhere/one', 'foreign', new Date('2026-09-20T00:00:00Z'));
    const sub = join(cwd, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    const found = await newestTranscript(sub);
    expect(found?.reader.agent).toBe('codex');
    expect(found?.path).toContain('rollout-above');
    expect(found?.sessions).toBe(1);
  });

  // Both readers have sessions of the project, but one's are in this very folder and the
  // other's are only in a folder above: the nearer wins, whatever the times say.
  it('prefers sessions in this folder over newer ones only in a folder above it', async () => {
    const sub = join(cwd, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    claudeSession(cwd, 'above', 'nothing', new Date('2026-09-20T00:00:00Z'));
    codexRollout(sub, 'exact', new Date('2026-09-01T00:00:00Z'));
    const found = await newestTranscript(sub);
    expect(found?.reader.agent).toBe('codex');
    expect(found?.sessions).toBe(1);
  });

  // The nearest folder above is the project's; the user's home directory is not a project.
  // A session started in ~ used to be the answer for every folder under it.
  it('does not take a session recorded in the home directory for the project’s', async () => {
    claudeSession(home, 'at-home', 'nothing', new Date('2026-09-01T00:00:00Z'));
    claudeSession('/elsewhere/one', 'other', 'nothing', new Date('2026-09-20T00:00:00Z'));
    const project = join(home, 'work', 'app');
    mkdirSync(project, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const out = capture();
    const code = await runSent(['--last']);
    out.restore();
    expect(code).toBe(1);
    expect(out.text()).toContain('no agent session recorded');
    expect(out.text()).not.toContain('at-home');
  });

  it('still reads a session recorded in the home directory when that is where it is run', async () => {
    claudeSession(home, 'at-home', 'nothing', new Date('2026-09-01T00:00:00Z'));
    vi.spyOn(process, 'cwd').mockReturnValue(home);
    const out = capture();
    const code = await runSent(['--last']);
    out.restore();
    expect(code).toBe(0);
    expect(out.text()).toContain('at-home');
  });
});

describe('stroq sent --last, the private index it uses for the session’s folder', () => {
  const ENV_SECRET = ['sk', 'live', '51H8xk2LkdIwHu7ix0abcdEFGH'].join('_');
  const CANARY = 'canary-value-9x8y7z6w5v4u3t2s';
  const scratchDirs = (): string[] =>
    readdirSync(tmpdir()).filter((name) => name.startsWith('stroq-sent-index-'));

  function subfolderSession(result: string): void {
    const app = join(cwd, 'packages', 'app');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, '.env'), `STRIPE_API_KEY=${ENV_SECRET}\n`);
    claudeSession(app, 'union', result);
  }

  it('leaves nothing of it behind', async () => {
    const before = scratchDirs();
    subfolderSession(`STRIPE_API_KEY=${ENV_SECRET}\n`);
    const out = capture();
    await runSent(['--last']);
    out.restore();
    expect(scratchDirs()).toEqual(before);
  });

  it('still finds a canary the guard planted', async () => {
    await new FileSecretIndex(secretsFile(), home).addCanary(CANARY, 'decoy_token');
    subfolderSession(`saw ${CANARY} in the file\n`);
    const out = capture();
    await runSent(['--last']);
    out.restore();
    expect(out.text()).toContain('decoy_token');
    expect(out.text()).toContain('canary');
    expect(out.text()).not.toContain(CANARY);
  });

  it('names both folders whose .env files it read', async () => {
    subfolderSession('nothing');
    const out = capture();
    await runSent(['--last']);
    out.restore();
    const app = join(cwd, 'packages', 'app');
    expect(out.text()).toContain(`project .env files were read from ${app} and ${cwd}`);
  });
});

describe('stroq sent --last, how much it read', () => {
  it('says it read one session of several, and how to read another', async () => {
    claudeSession(cwd, 'old', 'nothing', new Date('2026-09-01T00:00:00Z'));
    claudeSession(cwd, 'mid', 'nothing', new Date('2026-09-10T00:00:00Z'));
    claudeSession(cwd, 'new', 'nothing', new Date('2026-09-20T00:00:00Z'));
    const out = capture();
    await runSent(['--last']);
    out.restore();
    expect(out.text()).toContain('Read the newest of 3 sessions recorded for this project');
    expect(out.text()).toContain('--transcript');
    expect(out.text()).not.toContain('--all');
  });

  // Every reader falls back to the sessions of ALL projects when this directory has
  // none, so summing what `find` returned counted other projects' sessions and called
  // them "recorded for this project", in a security report.
  it("counts only this project's sessions, not the fallback list of every project", async () => {
    claudeSession(cwd, 'mine-a', 'nothing', new Date('2026-09-01T00:00:00Z'));
    claudeSession(cwd, 'mine-b', 'nothing', new Date('2026-09-02T00:00:00Z'));
    claudeSession('/elsewhere/one', 'other-1', 'nothing', new Date('2026-08-01T00:00:00Z'));
    claudeSession('/elsewhere/two', 'other-2', 'nothing', new Date('2026-08-02T00:00:00Z'));
    claudeSession('/elsewhere/three', 'other-3', 'nothing', new Date('2026-08-03T00:00:00Z'));
    const out = capture();
    await runSent(['--last', '--json']);
    out.restore();
    const parsed = JSON.parse(out.text()) as { coverage: { sessionsInProject?: number } };
    expect(parsed.coverage.sessionsInProject).toBe(2);
  });

  it('says nothing about a count it does not have, when the folder has no session of its own', async () => {
    claudeSession(cwd, 'parent', 'nothing', new Date('2026-09-20T00:00:00Z'));
    claudeSession('/elsewhere/one', 'other-1', 'nothing', new Date('2026-08-01T00:00:00Z'));
    claudeSession('/elsewhere/two', 'other-2', 'nothing', new Date('2026-08-02T00:00:00Z'));
    const sub = join(cwd, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(sub);
    const out = capture();
    await runSent(['--last']);
    out.restore();
    expect(out.text()).not.toContain('sessions recorded for this project');
  });

  it('says nothing about other sessions when there is only one', async () => {
    claudeSession(cwd, 'only', 'nothing');
    const out = capture();
    await runSent(['--last']);
    out.restore();
    expect(out.text()).not.toContain('sessions recorded for this project');
  });

  it('carries the count in the JSON report', async () => {
    claudeSession(cwd, 'a', 'nothing', new Date('2026-09-01T00:00:00Z'));
    claudeSession(cwd, 'b', 'nothing', new Date('2026-09-02T00:00:00Z'));
    const out = capture();
    await runSent(['--last', '--json']);
    out.restore();
    const parsed = JSON.parse(out.text()) as { coverage: { sessionsInProject?: number } };
    expect(parsed.coverage.sessionsInProject).toBe(2);
  });
});

describe('stroq sent, with no session to read', () => {
  it('ends with two commands that need no session: attack, and init for an agent', async () => {
    const out = capture();
    const code = await runSent(['--last']);
    out.restore();
    expect(code).toBe(1);
    expect(out.text()).toContain('stroq attack');
    expect(out.text()).toContain('stroq init --agent');
  });

  it('does the same when Stroq recorded nothing either', async () => {
    const out = capture();
    const code = await runSent([]);
    out.restore();
    expect(code).toBe(1);
    expect(out.text()).toContain('stroq attack');
    expect(out.text()).toContain('stroq init --agent');
  });
});

describe('what stroq sent suggests next', () => {
  it('ends with the commands to run next', async () => {
    const out = capture();
    await runSent(['--transcript', transcriptFile()]);
    out.restore();
    const text = out.text();
    expect(text).toContain('NEXT');
    expect(text).toContain('stroq replay --last');
    expect(text).toContain('stroq init');
    expect(text).toMatch(/rotate/i);
  });
});

describe('which recorded session belongs to this directory', () => {
  it.each([
    ['/w/app', '/w/app', true],
    ['/w/app/packages/cli', '/w/app', true],
    // Cursor records the files a session touched, not a working directory.
    ['/w/app', '/w/app/src/index.ts', true],
    ['/w/app', '/elsewhere', false],
    ['/w/app', '/w/application', false],
  ])('%s and a session recorded at %s → %s', (cwd, recorded, expected) => {
    expect(sessionBelongsHere(cwd, recorded)).toBe(expected);
  });
});
