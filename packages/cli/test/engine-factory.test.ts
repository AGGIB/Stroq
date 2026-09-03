import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@stroq/core';
import { loadPolicy } from '../src/engine-factory.js';
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
