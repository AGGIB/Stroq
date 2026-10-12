import { DEFAULT_POLICY, loadPolicyFile } from '@stroq/core';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_POLICY_BYTES, readPolicyFile } from '../../src/policy/load.js';
import { cpuNow } from '../helpers/cpu-time.js';
import { workspace, RAW_CONTROL } from './policy-files.js';

const ws = workspace();
afterAll(ws.cleanup);

const RULE = (id: string, effect = 'deny'): string =>
  `  - id: ${id}\n    effect: ${effect}\n    reason: because\n    when:\n      classes: [secret.egress]\n      taint: any\n`;

describe('readPolicyFile: a file that loads', () => {
  it('gives the very policy the hook loads from the same file', () => {
    const file = ws.writePolicy('same.yaml', DEFAULT_POLICY);
    const read = readPolicyFile(file);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.policy).toEqual(loadPolicyFile(file));
    expect(read.policy).toEqual(DEFAULT_POLICY);
    expect(read.unknownFields).toEqual([]);
  });

  it('applies the defaults the hook applies to a file that leaves them out', () => {
    const file = ws.write('bare.yaml', `version: 1\nrules:\n${RULE('r')}`);
    const read = readPolicyFile(file);
    if (!read.ok) throw new Error('did not load');
    expect(read.policy).toEqual(loadPolicyFile(file));
    expect(read.policy.threshold).toBe(0.6);
    expect(read.policy.default).toBe('allow');
  });
});

describe('readPolicyFile: a file that cannot be read at all', () => {
  it('says a missing file is missing', () => {
    const read = readPolicyFile(join(ws.dir, 'nope.yaml'));
    expect(read).toEqual({ ok: false, problem: 'unreadable', why: 'missing' });
  });

  it('says a directory is not a file', () => {
    const read = readPolicyFile(ws.dir);
    expect(read.ok).toBe(false);
    if (read.ok || read.problem !== 'unreadable') throw new Error('expected unreadable');
    expect(['not-a-file', 'unreadable']).toContain(read.why);
  });

  it('refuses a file bigger than the bound, whatever is in it', () => {
    const file = ws.write('huge.yaml', `version: 1\n${'#'.repeat(MAX_POLICY_BYTES)}\n`);
    expect(readPolicyFile(file)).toEqual({ ok: false, problem: 'unreadable', why: 'too-large' });
  });

  it('reads a file of exactly the bound', () => {
    const head = 'version: 1\nrules: []\n#';
    const file = ws.write(
      'edge.yaml',
      `${head}${'x'.repeat(MAX_POLICY_BYTES - Buffer.byteLength(head))}`,
    );
    expect(readPolicyFile(file).ok).toBe(true);
  });
});

describe('readPolicyFile: a file that is not YAML', () => {
  it('says so, with the line, and repeats nothing of the file', () => {
    const file = ws.write('broken.yaml', 'version: 1\nrules: [SECRET-MARKER-TEXT\n');
    const read = readPolicyFile(file);
    expect(read.ok).toBe(false);
    if (read.ok || read.problem !== 'yaml') throw new Error('expected a YAML fault');
    expect(read.fault.line).toBeGreaterThan(0);
    expect(JSON.stringify(read)).not.toContain('SECRET-MARKER-TEXT');
  });

  it('refuses a document that is two documents, as the hook does', () => {
    const file = ws.write('two.yaml', 'version: 1\nrules: []\n---\nversion: 1\nrules: []\n');
    expect(() => loadPolicyFile(file)).toThrow();
    const read = readPolicyFile(file);
    expect(read.ok).toBe(false);
  });

  it('refuses a key written twice, as the hook does', () => {
    const file = ws.write('dup.yaml', 'version: 1\nversion: 1\nrules: []\n');
    expect(() => loadPolicyFile(file)).toThrow();
    expect(readPolicyFile(file).ok).toBe(false);
  });
});

describe('readPolicyFile: a file that is YAML but not a policy', () => {
  it('gives the path of each fault and a fixed phrase, and none of the value', () => {
    const file = ws.write(
      'wrong.yaml',
      `version: 1\nrules:\n  - id: r\n    effect: SECRET-EFFECT-VALUE\n    reason: x\n    when:\n      classes: [not-a-class]\n`,
    );
    const read = readPolicyFile(file);
    expect(read.ok).toBe(false);
    if (read.ok || read.problem !== 'schema') throw new Error('expected a schema fault');
    const paths = read.faults.map((f) => f.path);
    expect(paths).toContain('rules.0.effect');
    expect(paths).toContain('rules.0.when.classes.0');
    for (const fault of read.faults) expect(fault.kind).not.toBe('');
    expect(JSON.stringify(read.faults)).not.toContain('SECRET-EFFECT-VALUE');
    expect(JSON.stringify(read.faults)).not.toContain('not-a-class');
  });

  it('says an empty file is not a policy', () => {
    const read = readPolicyFile(ws.write('empty.yaml', ''));
    expect(read.ok).toBe(false);
    if (read.ok || read.problem !== 'schema') throw new Error('expected a schema fault');
    expect(read.faults[0]?.path).toBe('');
  });

  it('lists a misspelled field, so that the fault can be explained', () => {
    const file = ws.write(
      'typo.yaml',
      `version: 1\nrules:\n  - id: r\n    effect: deny\n    reason: x\n    whenn:\n      classes: [secret.egress]\n`,
    );
    const read = readPolicyFile(file);
    if (read.ok || read.problem !== 'schema') throw new Error('expected a schema fault');
    expect(read.unknownFields).toEqual(['rules.0.whenn']);
  });

  it('lists a misspelled field of a policy that otherwise loads', () => {
    const file = ws.write(
      'typo-ok.yaml',
      `version: 1\nrules:\n  - id: r\n    effect: deny\n    reason: x\n    when:\n      classes: [secret.egress]\n      taintt: suspect\nthresholdd: 0.9\n`,
    );
    const read = readPolicyFile(file);
    if (!read.ok) throw new Error('did not load');
    expect(read.unknownFields).toEqual(['thresholdd', 'rules.0.when.taintt']);
    expect(read.policy.rules[0]?.when.taint).toBe('any');
  });
});

describe('readPolicyFile: a hostile file', () => {
  it('refuses a billion-laughs alias bomb without expanding it', () => {
    const lines = ['l0: &l0 [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 12; i += 1) {
      const refs = Array.from({ length: 10 }, () => `*l${i - 1}`).join(', ');
      lines.push(`l${i}: &l${i} [${refs}]`);
    }
    const file = ws.write('bomb.yaml', `version: 1\nrules: []\n${lines.join('\n')}\n`);
    const started = cpuNow();
    const read = readPolicyFile(file);
    const tookMs = cpuNow() - started;
    expect(read.ok).toBe(false);
    if (read.ok || read.problem !== 'yaml') throw new Error('expected a YAML fault');
    expect(read.fault.what).toMatch(/alias/);
    expect(tookMs).toBeLessThan(2_000);
  });

  it('refuses a flow collection nested far deeper than any policy, and does not crash', () => {
    const file = ws.write('deep.yaml', `version: 1\nrules: ${'['.repeat(100_000)}`);
    const started = cpuNow();
    const read = readPolicyFile(file);
    const tookMs = cpuNow() - started;
    expect(read.ok).toBe(false);
    expect(tookMs).toBeLessThan(5_000);
  });

  it('reads many rules in time that grows with the file, not faster than it', () => {
    const rules = Array.from({ length: 4000 }, (_, i) => RULE(`rule-${i}`, 'ask')).join('');
    const file = ws.write('many.yaml', `version: 1\nrules:\n${rules}`);
    const started = cpuNow();
    const read = readPolicyFile(file);
    const tookMs = cpuNow() - started;
    expect(read.ok).toBe(true);
    expect(tookMs).toBeLessThan(15_000);
  });

  it('puts no control character in any fault it reports', () => {
    const file = ws.write(
      'ctl.yaml',
      `version: 1\nrules:\n  - id: "\\e[31mred\\u202e"\n    effect: "\\e]52;c;AAAA\\a"\n    reason: x\n    when:\n      classes: [secret.egress]\n`,
    );
    const read = readPolicyFile(file);
    if (read.ok || read.problem !== 'schema') throw new Error('expected a schema fault');
    expect(JSON.stringify(read.faults)).not.toMatch(RAW_CONTROL);
  });
});
