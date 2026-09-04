import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, StroqEngine } from '@stroq/core';
import { createEngineAt, loadPolicy, policySource } from '../src/engine-factory.js';
import { policyFile, stroqHome } from '../src/paths.js';

beforeEach(() => {
  process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-engine-factory-'));
});

describe('loadPolicy', () => {
  it('returns DEFAULT_POLICY when no policy.yaml exists', () => {
    expect(loadPolicy()).toEqual(DEFAULT_POLICY);
  });

  it('returns the parsed policy when policy.yaml is present', () => {
    mkdirSync(stroqHome(), { recursive: true });
    writeFileSync(
      policyFile(),
      [
        'version: 1',
        'rules:',
        '  - id: deny-network',
        '    effect: deny',
        '    reason: test',
        '    when:',
        '      classes: [shell.network]',
        '      taint: any',
        '',
      ].join('\n'),
    );
    const policy = loadPolicy();
    expect(policy.rules[0]?.id).toBe('deny-network');
  });

  it('throws when policy.yaml is invalid', () => {
    mkdirSync(stroqHome(), { recursive: true });
    writeFileSync(policyFile(), ['version: 2', 'rules: []', ''].join('\n'));
    expect(() => loadPolicy()).toThrow();
  });
});

describe('createEngineAt / policySource', () => {
  it('builds an engine whose stores live under the given home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stroq-engine-at-'));
    const userHome = mkdtempSync(join(tmpdir(), 'stroq-user-'));
    const engine = createEngineAt({ home, userHome, policy: DEFAULT_POLICY, env: {} });
    expect(engine).toBeInstanceOf(StroqEngine);
    await engine.pre({ sessionId: 's', toolName: 'Bash', toolInput: { command: 'ls' }, cwd: home });
    expect(existsSync(join(home, 'audit.jsonl'))).toBe(true);
    expect(existsSync(join(stroqHome(), 'audit.jsonl'))).toBe(false);
  });

  it('names the policy source', () => {
    expect(policySource()).toBe('default');
    mkdirSync(stroqHome(), { recursive: true });
    writeFileSync(policyFile(), 'version: 1\nrules: []\n');
    expect(policySource()).toBe(policyFile());
  });
});
