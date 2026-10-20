import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_KEY } from '../../src/sent/sample.js';
import { AWS_KEY, machine, sent, type Machine } from '../helpers/sent-machine.js';

/**
 * `stroq sent --try`: the check on a built-in sample with a made-up key. It reads nothing on
 * this machine, so real keys planted in the fake HOME, the project and the environment must
 * not show up anywhere in what it prints.
 */

let m: Machine;
const REAL_ENV = 'super-secret-real-env-token-12345';

beforeEach(() => {
  m = machine();
  vi.stubEnv('REAL_SECRET_KEY_FOR_TEST', REAL_ENV);
  mkdirSync(m.cwd, { recursive: true });
  writeFileSync(join(m.cwd, '.env'), 'OPENAI_API_KEY=sk-proj-RealKeyThatMustNotBeRead987654321\n');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('stroq sent --try', () => {
  it('runs on the sample and touches no real key', async () => {
    const { code, out } = await sent(['--try']);
    expect(code).toBe(0);
    expect(out).toContain('This is a built-in sample. The key and the session are made up.');
    expect(out).toContain('STRIPE_SECRET_KEY');
    expect(out).toContain('collector.example, in a curl command');
    for (const text of [
      SAMPLE_KEY.value,
      AWS_KEY,
      'aws_secret_access_key',
      'OPENAI_API_KEY',
      'REAL_SECRET_KEY_FOR_TEST',
      REAL_ENV,
    ])
      expect(out).not.toContain(text);
  });

  it('points to the commands to run next', async () => {
    const { out } = await sent(['--try']);
    expect(out).toContain('`stroq sent` checks every session on this machine.');
    expect(out).toContain('`stroq init` guards the next one.');
  });

  it('exits 0 by default, and 1 with --fail-if third-party or --fail-on-finding', async () => {
    expect((await sent(['--try'])).code).toBe(0);
    expect((await sent(['--try', '--fail-if', 'third-party'])).code).toBe(1);
    expect((await sent(['--try', '--fail-on-finding'])).code).toBe(1);
  });

  it('makes no temporary folder', async () => {
    const before = readdirSync(tmpdir()).filter(
      (n) => n.startsWith('stroq-sent-try-') && !n.includes('test'),
    );
    await sent(['--try']);
    const after = readdirSync(tmpdir()).filter(
      (n) => n.startsWith('stroq-sent-try-') && !n.includes('test'),
    );
    expect(after).toEqual(before);
  });

  it('marks the JSON report, the counts and the card as the sample', async () => {
    const report = JSON.parse((await sent(['--try', '--json'])).out) as {
      synthetic: boolean;
      findings: { name: string; tier: string }[];
    };
    expect(report.synthetic).toBe(true);
    expect(report.findings.map((f) => [f.name, f.tier])).toEqual([
      ['STRIPE_SECRET_KEY', 'third_party'],
    ]);
    expect(JSON.parse((await sent(['--try', '--counts'])).out)).toMatchObject({ synthetic: true });
    expect(JSON.parse((await sent(['--try', '--card', '--json'])).out)).toMatchObject({
      synthetic: true,
    });
    expect((await sent(['--try', '--card'])).out).toContain('made-up key');
  });

  it('keeps the sample marker in an HTML card written to a file', async () => {
    const path = join(m.root, 'sample-card.html');
    expect((await sent(['--try', '--card', '--html', '--out', path])).code).toBe(0);
    const html = readFileSync(path, 'utf8');
    expect(html).toMatch(/made-up key/);
    expect(html).toContain('sent --try');
  });

  it('refuses a session, --last, --transcript or --here beside it', async () => {
    for (const args of [
      ['--try', '--last'],
      ['--try', '--transcript', 'foo.jsonl'],
      ['--try', 'session-123'],
      ['--try', '--here'],
    ]) {
      const { code, err } = await sent(args);
      expect(code).toBe(2);
      expect(err).toContain('--try does not take a session');
    }
  });
});
