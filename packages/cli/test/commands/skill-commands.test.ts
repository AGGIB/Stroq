import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_ENTRY } from '../helpers/cli-entry.js';

describe('skill command boundaries', () => {
  function run(...args: string[]) {
    const home = mkdtempSync(join(tmpdir(), 'stroq-skill-cli-'));
    const stroqHome = join(home, '.stroq');
    const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
      input: '',
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, STROQ_HOME: stroqHome },
    });
    return { result, stroqHome };
  }

  it.each(['add', 'remove'])('refuses nonterminal %s without touching Stroq state', (command) => {
    const { result, stroqHome } = run(command, 'demo');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('person at a terminal');
    expect(result.stderr).toContain('stroq vet');
    expect(existsSync(stroqHome)).toBe(false);
  });

  it.each([
    ['add'],
    ['remove'],
    ['add', 'a', 'b'],
    ['remove', 'a', 'b'],
    ['add', ''],
    ['remove', ''],
  ])('requires one argument: %j', (...args) => {
    const { result, stroqHome } = run(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--help');
    expect(existsSync(stroqHome)).toBe(false);
  });

  it.each([
    '--yes',
    '--confirm-digest=0123456789ab',
    '--online',
    '--force',
    '--client=cursor',
    '--config=config.json',
    '--entrypoint=server.js',
    '--pass-env=TOKEN',
    '--name=server',
    '--cwd=.',
  ])('add rejects %s', (flag) => {
    const { result } = run('add', 'demo', flag);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown option');
  });

  it('MCP --force still requires a person at a terminal', () => {
    const { result, stroqHome } = run('add', 'demo', '--kind=mcp', '--force');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('person at a terminal');
    expect(existsSync(stroqHome)).toBe(false);
  });
});
