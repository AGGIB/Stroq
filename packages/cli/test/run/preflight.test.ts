import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentHookStatus } from '../../src/commands/doctor.js';
import { preflight } from '../../src/run/preflight.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-preflight-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, env: { ...process.env, HOME: dir } });
  return dir;
}

const hooks =
  (over: Partial<AgentHookStatus> = {}) =>
  (id: string): AgentHookStatus => ({
    id,
    name: `${id} hooks`,
    installed: true,
    changed: false,
    detail: 'project: installed (/repo/.claude/settings.json)',
    ...over,
  });

const run = (cwd: string, over: Partial<Parameters<typeof preflight>[0]> = {}) =>
  preflight({
    agent: 'claude-code',
    command: 'claude',
    cwd,
    inspect: true,
    hooks: hooks(),
    ...over,
  });

describe('what stroq run checks before it starts an agent', () => {
  it('refuses nothing when the hooks are installed and the repository runs nothing early', () => {
    const result = run(repo());
    expect(result.refusals).toEqual([]);
  });

  it('refuses when Stroq has no hook in the agent it was asked to launch', () => {
    const result = run(repo(), {
      agent: 'codex',
      command: 'codex',
      hooks: hooks({ installed: false }),
    });
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.fix).toContain('stroq init --agent codex');
  });

  // An entry that still LOOKS installed but is no longer the command `init` wrote is
  // worse than a missing one: the agent reports a hook and something else runs.
  it('refuses when the installed hook is no longer the one stroq init wrote', () => {
    const result = run(repo(), { hooks: hooks({ changed: true }) });
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.reason).toMatch(/CHANGED|no longer/i);
  });

  it('says plainly that it checked nothing when it cannot place the program', () => {
    const result = run(repo(), { agent: null, command: 'bash' });
    expect(result.refusals).toEqual([]);
    expect(result.notes.join(' ')).toContain('bash');
    expect(result.notes.join(' ')).toContain('--agent');
  });

  it('refuses a repository that runs a command before anyone approves it', () => {
    const dir = repo();
    execFileSync('git', ['config', 'core.fsmonitor', '/tmp/pwn.sh'], { cwd: dir });
    const result = run(dir);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.reason).toContain('core.fsmonitor');
  });

  it('never refuses over the ordinary on-open kind, which honest repositories all have', () => {
    const dir = repo();
    mkdirSync(join(dir, '.husky'));
    writeFileSync(join(dir, '.husky', 'pre-commit'), 'pnpm test\n');
    expect(run(dir).refusals).toEqual([]);
  });

  it('skips the repository read entirely when asked to', () => {
    const dir = repo();
    execFileSync('git', ['config', 'core.fsmonitor', '/tmp/pwn.sh'], { cwd: dir });
    expect(run(dir, { inspect: false }).refusals).toEqual([]);
  });

  it('reports every reason at once, so a second run is not a second refusal', () => {
    const dir = repo();
    execFileSync('git', ['config', 'core.fsmonitor', '/tmp/pwn.sh'], { cwd: dir });
    expect(run(dir, { hooks: hooks({ installed: false }) }).refusals).toHaveLength(2);
  });
});
