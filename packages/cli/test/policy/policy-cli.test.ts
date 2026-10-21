import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DEFAULT_POLICY } from '@stroq/core';
import { afterAll, describe, expect, it } from 'vitest';
import { CLI_ENTRY } from '../helpers/cli-entry.js';
import { defaultWithout, workspace, RAW_CONTROL } from './policy-files.js';

const ws = workspace();
afterAll(ws.cleanup);

/**
 * `stroq policy` as it is run: the built CLI, in its own home, with standard input that is not a
 * terminal. This is where the wiring shows (the command table, the unknown-option check, the exit
 * code, the filter on what reaches the terminal), which the tests that call the command in this
 * process do not go through.
 */
function stroq(...args: string[]) {
  const home = join(ws.dir, 'cli-home');
  const result = spawnSync(process.execPath, [CLI_ENTRY, 'policy', ...args], {
    cwd: ws.dir,
    encoding: 'utf8',
    input: '',
    env: { ...process.env, HOME: home, USERPROFILE: home, STROQ_HOME: join(home, '.stroq') },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe('stroq policy, as a command', () => {
  it('checks the default policy in force and exits 0', () => {
    const ran = stroq('check');
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('the built-in default policy is in force');
  });

  it('exits 1 with the dropped protection named, for a policy without the secret-egress deny', () => {
    const file = ws.writePolicy('no-egress.yaml', defaultWithout('deny-secret-egress'));
    const ran = stroq('check', file);
    expect(ran.code).toBe(1);
    expect(ran.out).toContain('secret.egress');
    expect(ran.out).toContain('deny-secret-egress');
  });

  it('exits 0 for a copy of the default policy, and prints json that parses', () => {
    const file = ws.writePolicy('default-copy.yaml', DEFAULT_POLICY);
    const ran = stroq('check', file, '--json');
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.out)).toMatchObject({ version: 1, ok: true, file });
  });

  it('exits 2 for a file that is not there, with the reason on standard error', () => {
    const ran = stroq('check', join(ws.dir, 'absent.yaml'));
    expect(ran.code).toBe(2);
    expect(ran.out).toBe('');
    expect(ran.err).toContain('no such file');
  });

  it('exits 2 with a usage line for no subcommand, an unknown one and an unknown option', () => {
    const none = stroq();
    expect(none.code).toBe(2);
    expect(none.err).toContain('needs a subcommand');
    expect(stroq('frobnicate').code).toBe(2);
    const option = stroq('check', '--bogus');
    expect(option.code).toBe(2);
    expect(option.err).toContain('stroq policy: unknown option --bogus');
    expect(option.err).not.toMatch(/TypeError|ERR_PARSE_ARGS/);
  });

  it('prints its usage for --help, and lists itself in stroq help --all', () => {
    const help = stroq('--help');
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/^stroq policy check/);
    expect(help.out).toContain('--max-new-interruptions');
    const all = spawnSync(process.execPath, [CLI_ENTRY, 'help', '--all'], { encoding: 'utf8' });
    expect(all.stdout).toMatch(/^ {2}stroq policy check\b/m);
  });

  it('writes no raw control character to the terminal for a hostile file', () => {
    const file = ws.write(
      'hostile.yaml',
      [
        'version: 1',
        'rules:',
        '  - id: "allow\\e[2J\\e]52;c;AAAA\\a\\u202e-all"',
        '    effect: allow',
        '    reason: x',
        '    when: { classes: [secret.egress] }',
        '',
      ].join('\n'),
    );
    const ran = stroq('check', file);
    expect(ran.code).toBe(1);
    expect(ran.out).not.toMatch(RAW_CONTROL);
    expect(ran.out).toContain('\\u001b');
  });

  it('replays the corpora and exits 0 for the default policy against itself', () => {
    const ran = stroq('test', '--json');
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.out)).toMatchObject({ version: 1, ok: true, changes: [] });
  }, 120_000);

  it('exits 1 and names the attacks for a policy that drops the secret-egress deny', () => {
    const file = ws.writePolicy('drops-egress.yaml', defaultWithout('deny-secret-egress'));
    const ran = stroq('test', '--policy', file);
    expect(ran.code).toBe(1);
    expect(ran.out).toContain('03-token-in-mcp-comment/1: deny -> allow (looser)');
    expect(ran.out).toContain('Result: FAILED');
  }, 120_000);
});
