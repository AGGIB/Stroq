import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newestTranscript } from '../../src/sent/readers.js';
import {
  call,
  claudeSession,
  codexRollout,
  machine,
  sent,
  type Machine,
} from '../helpers/sent-machine.js';

/**
 * `stroq sent --last`: the newest session of this project. Ported from the cases that held the
 * old command to the project's own session, its folders and its `.env` files.
 */

let m: Machine;
const ENV_SECRET = ['sk', 'live', 'FAKE51H8xk2LkdIwHu7ix0abcdEFGH'].join('_');

beforeEach(() => {
  m = machine();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const envResult = () => [
  ...call('a', 'Bash', { command: 'env' }, `STRIPE_API_KEY=${ENV_SECRET}\n`),
];
const nothing = () => [...call('a', 'Bash', { command: 'ls' }, 'nothing')];
const projectEnv = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env'), `STRIPE_API_KEY=${ENV_SECRET}\n`);
};

describe('stroq sent --last, when this directory has no session', () => {
  it("does not quietly read another project's session", async () => {
    claudeSession(m, '/somewhere/else', 'x', envResult());
    const { code, out } = await sent(['--last']);
    expect(code).toBe(1);
    expect(out).toContain(`No agent session was recorded in ${m.cwd}`);
    expect(out).toContain('/somewhere/else');
    expect(out).toContain('--transcript');
    expect(out).not.toContain('STRIPE_API_KEY');
  });

  it('reads the session of the project this directory is inside', async () => {
    projectEnv(m.cwd);
    claudeSession(m, m.cwd, 'x', envResult());
    vi.spyOn(process, 'cwd').mockReturnValue(join(m.cwd, 'packages', 'app'));
    const { code, out } = await sent(['--last']);
    expect(code).toBe(0);
    expect(out).toContain('STRIPE_API_KEY');
  });
});

describe('stroq sent --last, run from another folder of the same project', () => {
  it('compares the session with the .env of the folder it ran in, from a subfolder', async () => {
    projectEnv(m.cwd);
    claudeSession(m, m.cwd, 'sub', envResult());
    const sub = join(m.cwd, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(sub);
    const { out } = await sent(['--last']);
    expect(out).toContain('STRIPE_API_KEY');
    expect(out).not.toContain(ENV_SECRET);
  });

  it('compares the session with the .env of the folder it ran in, from the parent', async () => {
    const app = join(m.cwd, 'packages', 'app');
    projectEnv(app);
    claudeSession(m, app, 'parent', envResult());
    const { out } = await sent(['--last']);
    expect(out).toContain('STRIPE_API_KEY');
    expect(out).toContain(join(app, '.env'));
  });

  it('still compares the session with the .env of the folder the command was typed in', async () => {
    projectEnv(m.cwd);
    const app = join(m.cwd, 'packages', 'app');
    mkdirSync(app, { recursive: true });
    claudeSession(m, app, 'reverse', envResult());
    const { out } = await sent(['--last']);
    expect(out).toContain('STRIPE_API_KEY');
  });
});

describe('stroq sent --last, finding the project’s own session', () => {
  it('reads the session recorded in a folder above, not a newer one of another project', async () => {
    claudeSession(m, m.cwd, 'parent', nothing(), { mtime: new Date('2026-09-01T00:00:00Z') });
    claudeSession(m, '/elsewhere/one', 'other', nothing(), {
      mtime: new Date('2026-09-20T00:00:00Z'),
    });
    const sub = join(m.cwd, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(sub);
    const { code, out } = await sent(['--last']);
    expect(code).toBe(0);
    expect(out).toContain('Checked the newest session of this project (Claude Code)');
  });

  it('prefers this directory’s own session over a newer one another agent recorded elsewhere', async () => {
    claudeSession(m, m.cwd, 'mine', nothing(), { mtime: new Date('2026-09-01T00:00:00Z') });
    codexRollout(m, '/elsewhere/one', 'foreign', 'ls', new Date('2026-09-20T00:00:00Z'));
    const { code, out } = await sent(['--last']);
    expect(code).toBe(0);
    expect(out).toContain('(Claude Code)');
  });

  it('reads a Codex session recorded in a folder above, not a newer one elsewhere', async () => {
    codexRollout(m, m.cwd, 'above', 'ls', new Date('2026-09-01T00:00:00Z'));
    codexRollout(m, '/elsewhere/one', 'foreign', 'ls', new Date('2026-09-20T00:00:00Z'));
    const sub = join(m.cwd, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    const found = await newestTranscript(sub);
    expect(found?.reader.agent).toBe('codex');
    expect(found?.path).toContain('rollout-above');
    expect(found?.sessions).toBe(1);
  });

  it('does not take a session recorded in the home directory for the project’s', async () => {
    claudeSession(m, m.home, 'at-home', nothing(), { mtime: new Date('2026-09-20T00:00:00Z') });
    claudeSession(m, '/elsewhere/one', 'other', nothing(), {
      mtime: new Date('2026-09-01T00:00:00Z'),
    });
    const project = join(m.home, 'work', 'app');
    mkdirSync(project, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const { code, out } = await sent(['--last']);
    expect(code).toBe(1);
    expect(out).toContain('No agent session was recorded in');
    expect(out).not.toContain('None of your');
  });

  it('still reads a session recorded in the home directory when that is where it is run', async () => {
    claudeSession(m, m.home, 'at-home', nothing());
    vi.spyOn(process, 'cwd').mockReturnValue(m.home);
    const { code } = await sent(['--last']);
    expect(code).toBe(0);
  });
});

describe('stroq sent --last, how much it read', () => {
  it('says it read one session of several, and how to read them all', async () => {
    claudeSession(m, m.cwd, 'old', nothing(), { mtime: new Date('2026-09-01T00:00:00Z') });
    claudeSession(m, m.cwd, 'mid', nothing(), { mtime: new Date('2026-09-10T00:00:00Z') });
    claudeSession(m, m.cwd, 'new', nothing(), { mtime: new Date('2026-09-20T00:00:00Z') });
    const { out } = await sent(['--last']);
    expect(out).toContain('This project has 3 sessions. Check them all with `stroq sent --here`.');
  });

  it("counts only this project's sessions, not every project's", async () => {
    claudeSession(m, m.cwd, 'mine-a', nothing(), { mtime: new Date('2026-09-01T00:00:00Z') });
    claudeSession(m, m.cwd, 'mine-b', nothing(), { mtime: new Date('2026-09-02T00:00:00Z') });
    claudeSession(m, '/elsewhere/one', 'other-1', nothing(), {
      mtime: new Date('2026-08-01T00:00:00Z'),
    });
    codexRollout(m, '/elsewhere/two', 'foreign', 'ls', new Date('2026-08-02T00:00:00Z'));
    const { out } = await sent(['--last', '--json']);
    const parsed = JSON.parse(out) as { sessions: { inProject?: number } };
    expect(parsed.sessions.inProject).toBe(2);
  });

  it('says nothing about other sessions when there is only one', async () => {
    claudeSession(m, m.cwd, 'only', nothing());
    const { out } = await sent(['--last']);
    expect(out).not.toContain('This project has');
  });

  it('says where it looked when there is no transcript at all, and what needs none', async () => {
    const { code, out } = await sent(['--last']);
    expect(code).toBe(1);
    expect(out).toContain('~/.claude/projects');
    expect(out).toContain('stroq sent --try');
  });
});

describe('stroq sent --transcript', () => {
  it('reads the file it is given, whatever folder this is', async () => {
    const path = claudeSession(m, '/elsewhere/one', 't', envResult());
    projectEnv(m.cwd);
    const { code, out } = await sent(['--transcript', path]);
    expect(code).toBe(0);
    expect(out).toContain('STRIPE_API_KEY');
  });

  it('says so when the file holds nothing', async () => {
    const path = join(m.root, 'empty.jsonl');
    writeFileSync(path, '');
    const { code, out } = await sent(['--transcript', path]);
    expect(code).toBe(1);
    expect(out).toContain('Nothing is recorded in');
  });
});
