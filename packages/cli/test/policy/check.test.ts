import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_POLICY } from '@stroq/core';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { runPolicy } from '../../src/commands/policy.js';
import { policySha256 } from '../../src/policy/digest.js';
import { buildMeta } from '../../src/attack/report.js';
import { capture, defaultWithout, workspace, RAW_CONTROL, type Ran } from './policy-files.js';

const ws = workspace();
afterAll(ws.cleanup);

/** STROQ_HOME for the test, so that "the policy in force" is a file the test chose. */
let home = '';
let saved: string | undefined;
beforeEach(() => {
  saved = process.env['STROQ_HOME'];
  home = join(ws.dir, `home-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  process.env['STROQ_HOME'] = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env['STROQ_HOME'];
  else process.env['STROQ_HOME'] = saved;
});

const check = (...args: string[]): Promise<Ran> => capture(() => runPolicy(['check', ...args]));

interface JsonReport {
  version: number;
  ok: boolean;
  source: string;
  file: string | null;
  loaded: boolean;
  policy: { rules: number; default: string; threshold: number; sha256: string } | null;
  faults: { severity: string; kind: string; path: string; message: string; fix: string }[];
  findings: { kind: string; severity: string; message: string; fix: string }[];
}
const jsonOf = (ran: Ran): JsonReport => JSON.parse(ran.stdout) as JsonReport;

describe('stroq policy check: the policy in force', () => {
  it('says the default policy is in force when there is no policy.yaml, and checks that', async () => {
    const ran = await check();
    expect(ran.code).toBe(0);
    expect(ran.stdout).toMatch(/default policy is in force/);
    expect(ran.stdout).toMatch(/No problems found/);
    expect(ran.stderr).toBe('');
  });

  it('reports the default policy as json: no file, nothing that needs attention', async () => {
    const ran = await check('--json');
    const report = jsonOf(ran);
    expect(ran.code).toBe(0);
    expect(report).toMatchObject({ version: 1, ok: true, source: 'default', file: null });
    expect(report.loaded).toBe(true);
    expect(report.faults).toEqual([]);
    expect(report.findings.map((f) => f.kind)).toEqual(['loose-default']);
    expect(report.policy).toEqual({
      rules: DEFAULT_POLICY.rules.length,
      default: 'allow',
      threshold: 0.6,
      sha256: policySha256(DEFAULT_POLICY),
    });
  });

  it('checks the policy.yaml in STROQ_HOME when there is one', async () => {
    const file = join(home, 'policy.yaml');
    writeFileSync(file, stringify(defaultWithout('deny-secret-egress')), 'utf8');
    const ran = await check('--json');
    const report = jsonOf(ran);
    expect(ran.code).toBe(1);
    expect(report.source).toBe('file');
    expect(report.file).toBe(file);
    expect(report.findings.some((f) => f.kind === 'dropped-protection')).toBe(true);
  });
});

describe('stroq policy check <file>', () => {
  it('exits 0 for a copy of the default policy', async () => {
    const file = ws.writePolicy('default-copy.yaml', DEFAULT_POLICY);
    const ran = await check(file);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('No problems found');
  });

  it('exits 1 and names the class, both effects and the fix for a policy without the secret-egress deny', async () => {
    const file = ws.writePolicy('no-egress.yaml', defaultWithout('deny-secret-egress'));
    const ran = await check(file);
    expect(ran.code).toBe(1);
    expect(ran.stdout).toContain('secret.egress');
    expect(ran.stdout).toContain('denies it (rule "deny-secret-egress")');
    expect(ran.stdout).toContain('allows it (no rule matches, so default: allow)');
    expect(ran.stdout).toMatch(/fix: restore the default policy's rule "deny-secret-egress"/);
    expect(ran.stdout).toMatch(/^error /m);
  });

  it('exits 0 when the protection is kept under another rule id', async () => {
    const renamed = {
      ...DEFAULT_POLICY,
      rules: DEFAULT_POLICY.rules.map((r) =>
        r.id === 'deny-secret-egress' ? { ...r, id: 'no-leaks' } : r,
      ),
    };
    const ran = await check(ws.writePolicy('renamed.yaml', renamed));
    expect(ran.code).toBe(0);
  });

  it('exits 1 when the protection is kept but only as ask', async () => {
    const softened = {
      ...DEFAULT_POLICY,
      rules: DEFAULT_POLICY.rules.map((r) =>
        r.id === 'deny-secret-egress' ? { ...r, effect: 'ask' } : r,
      ),
    };
    const ran = await check(ws.writePolicy('softened.yaml', softened), '--json');
    const report = jsonOf(ran);
    expect(ran.code).toBe(1);
    const found = report.findings.find((f) => f.kind === 'dropped-protection');
    expect(found?.severity).toBe('warning');
    expect(found?.message).toContain('asks about it');
  });

  it('exits 1 for a shadowed rule and says where it is', async () => {
    const file = ws.writePolicy('shadow.yaml', {
      version: 1,
      threshold: 0.6,
      default: 'ask',
      rules: [
        { id: 'allow-net', effect: 'allow', reason: 'x', when: { classes: ['shell.network'] } },
        { id: 'deny-net', effect: 'deny', reason: 'x', when: { classes: ['shell.network'] } },
      ],
    });
    const ran = await check(file);
    expect(ran.code).toBe(1);
    expect(ran.stdout).toContain('rule 2 "deny-net" (deny) never decides anything');
    expect(ran.stdout).toContain('1 "allow-net" (allow)');
  });

  it('exits 1 for a threshold far above the default one', async () => {
    const file = ws.writePolicy('high.yaml', { ...DEFAULT_POLICY, threshold: 0.95 });
    const ran = await check(file, '--json');
    expect(ran.code).toBe(1);
    expect(jsonOf(ran).findings.map((f) => f.kind)).toContain('high-threshold');
  });

  it('exits 0 and only notes a default of allow', async () => {
    const ran = await check(ws.writePolicy('allow.yaml', DEFAULT_POLICY), '--json');
    expect(ran.code).toBe(0);
    const [note] = jsonOf(ran).findings;
    expect(note).toMatchObject({ kind: 'loose-default', severity: 'info' });
  });

  it('exits 1 for a misspelled field, which the hook would ignore', async () => {
    const file = ws.write(
      'typo.yaml',
      'version: 1\nrules:\n  - id: r\n    effect: deny\n    reason: x\n    when:\n      classes: [secret.egress]\n      taintt: suspect\n',
    );
    const ran = await check(file, '--json');
    expect(ran.code).toBe(1);
    const typo = jsonOf(ran).findings.find((f) => f.kind === 'unknown-field');
    expect(typo?.severity).toBe('warning');
    expect(typo?.message).toContain('"rules.0.when.taintt"');
  });
});

describe('stroq policy check: a file that does not load', () => {
  const wrong = [
    'version: 1',
    'rules:',
    '  - id: r',
    '    effect: SECRET-VALUE-NOT-TO-ECHO',
    '    reason: x',
    '    when:',
    '      classes: [secret.egress]',
    '',
  ].join('\n');

  it('exits 1, names the path of each fault with a fixed phrase and never the value', async () => {
    const file = ws.write('wrong.yaml', wrong);
    const ran = await check(file);
    expect(ran.code).toBe(1);
    expect(ran.stdout).toContain('"rules.0.effect": a value that is not one of those allowed');
    expect(ran.stdout).toContain('allow, deny or ask');
    expect(ran.stdout).toMatch(/fails closed/);
    expect(ran.stdout).not.toContain('SECRET-VALUE-NOT-TO-ECHO');
  });

  it('gives the faults as json, with the path, the phrase and a fix', async () => {
    const ran = await check(ws.write('wrong2.yaml', wrong), '--json');
    const report = jsonOf(ran);
    expect(report).toMatchObject({ ok: false, loaded: false, policy: null });
    expect(report.faults).toHaveLength(1);
    expect(report.faults[0]).toMatchObject({
      severity: 'error',
      kind: 'schema',
      path: 'rules.0.effect',
    });
    expect(report.faults[0]?.fix).toContain('allow, deny or ask');
    expect(ran.stdout).not.toContain('SECRET-VALUE-NOT-TO-ECHO');
  });

  it('exits 1 for text that is not YAML, with the line and none of the text', async () => {
    const ran = await check(ws.write('syntax.yaml', 'version: 1\nrules: [LEAKY-TEXT\n'));
    expect(ran.code).toBe(1);
    expect(ran.stdout).toMatch(/not valid YAML \(line \d+/);
    expect(ran.stdout).not.toContain('LEAKY-TEXT');
  });

  it('shows no more than a screenful of faults and counts the rest', async () => {
    const rules = Array.from({ length: 200 }, (_, i) => `  - id: r${i}\n    effect: nope\n`).join(
      '',
    );
    const ran = await check(ws.write('many-faults.yaml', `version: 1\nrules:\n${rules}`));
    expect(ran.code).toBe(1);
    expect(ran.stdout).toMatch(/and \d+ more/);
    expect(ran.stdout.split('\n').length).toBeLessThan(120);
  });
});

describe('stroq policy check: a file that cannot be read', () => {
  it('exits 2 for a file that is not there, and says so on stderr', async () => {
    const ran = await check(join(ws.dir, 'absent.yaml'));
    expect(ran.code).toBe(2);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain('stroq policy check:');
    expect(ran.stderr).toMatch(/no such file/);
  });

  it('exits 2 for a file over the bound', async () => {
    const ran = await check(ws.write('big.yaml', `version: 1\n${'#'.repeat(1024 * 1024)}\n`));
    expect(ran.code).toBe(2);
    expect(ran.stderr).toMatch(/more than 1 MiB/);
  });

  it('exits 2 for a directory', async () => {
    const ran = await check(ws.dir);
    expect(ran.code).toBe(2);
  });

  it('exits 2 for a policy.yaml in STROQ_HOME that is a directory, as the hook cannot read it either', async () => {
    mkdirSync(join(home, 'policy.yaml'));
    const ran = await check();
    expect(ran.code).toBe(2);
  });
});

describe('stroq policy check: the command line', () => {
  it.each([
    [[], /needs a subcommand/],
    [['frobnicate'], /unknown subcommand/],
  ])('refuses %j with exit 2', async (args, message) => {
    const ran = await capture(() => runPolicy(args));
    expect(ran.code).toBe(2);
    expect(ran.stderr).toMatch(message);
    expect(ran.stderr).toContain('stroq policy --help');
  });

  it('refuses two files', async () => {
    const ran = await check('a.yaml', 'b.yaml');
    expect(ran.code).toBe(2);
    expect(ran.stderr).toMatch(/one file/);
  });

  it.each(['--cases', '--policy', '--baseline', '--max-new-interruptions'])(
    'refuses %s, which is an option of test',
    async (flag) => {
      const ran = await check(flag, 'x');
      expect(ran.code).toBe(2);
      expect(ran.stderr).toContain(`${flag} is not an option of "check"`);
    },
  );
});

describe('stroq policy check: what a hostile file can make it print', () => {
  const hostile = [
    'version: 1',
    'rules:',
    '  - id: "allow\\e[2J\\e]52;c;AAAA\\a\\u202e-all"',
    '    effect: allow',
    '    reason: x',
    '    when: { classes: [secret.egress] }',
    '    "ev\\e[31mil\\u202e": 1',
    '  - id: "second\\u009b31m"',
    '    effect: deny',
    '    reason: x',
    '    when: { classes: [secret.egress] }',
    '',
  ].join('\n');

  it('prints no raw control character in text', async () => {
    const ran = await check(ws.write('hostile.yaml', hostile));
    expect(ran.stdout).not.toMatch(RAW_CONTROL);
    expect(ran.stdout).toContain('\\u001b');
    expect(ran.stdout).toContain('\\u202e');
  });

  it('prints no raw control character in json', async () => {
    const ran = await check(ws.write('hostile2.yaml', hostile), '--json');
    expect(ran.stdout).not.toMatch(RAW_CONTROL);
    expect(() => JSON.parse(ran.stdout)).not.toThrow();
  });

  it('prints a path with a control character in it safely, when it cannot read it', async () => {
    const ran = await check(join(ws.dir, 'no\u001b[2Jfile‮.yaml'));
    expect(ran.code).toBe(2);
    expect(ran.stderr).not.toMatch(RAW_CONTROL);
  });

  it('shows a bounded number of findings for a file that is nothing but shadowed rules', async () => {
    const rule = (i: number): string =>
      `  - id: r${i}\n    effect: ask\n    reason: x\n    when: { classes: [shell.network] }\n`;
    const text = `version: 1\ndefault: ask\nrules:\n${Array.from({ length: 3000 }, (_, i) => rule(i)).join('')}`;
    const ran = await check(ws.write('shadowed-lot.yaml', text));
    expect(ran.code).toBe(1);
    expect(ran.stdout.split('\n').length).toBeLessThan(200);
    expect(ran.stdout).toMatch(/and \d+ more/);
  });
});

describe('the digest', () => {
  it('is the hash the attack report puts in its meta block', () => {
    const meta = buildMeta({
      policy: DEFAULT_POLICY,
      policySource: 'default',
      corpusId: 'x',
      scenarios: [],
    });
    expect(policySha256(DEFAULT_POLICY)).toBe(meta.policy.sha256);
  });
});
