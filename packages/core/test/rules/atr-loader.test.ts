import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRulesFromDir, parseRule } from '../../src/rules/atr-loader.js';

const good = `
id: STROQ-2026-00001
title: Good rule
severity: high
detection:
  conditions:
    - operator: contains
      value: "do not tell the user"
`;

describe('parseRule', () => {
  it('parses a minimal rule and defaults field/condition', () => {
    const { rule, error } = parseRule(good, 'good.yaml');
    expect(error).toBeUndefined();
    expect(rule?.detection.condition).toBe('any');
    expect(rule?.detection.conditions[0]?.field).toBe('content');
  });

  it('returns an error for a rule with a bad id', () => {
    const { rule, error } = parseRule(good.replace('STROQ-2026-00001', 'nope'), 'bad.yaml');
    expect(rule).toBeUndefined();
    expect(error).toMatch(/id/);
  });

  it('returns an error for invalid YAML', () => {
    expect(parseRule('id: [unclosed', 'broken.yaml').error).toBeDefined();
  });
});

describe('loadRulesFromDir', () => {
  it('walks nested directories and separates skipped files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-rules-'));
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'a.yaml'), good);
    writeFileSync(join(dir, 'b.yml'), 'id: bad');
    writeFileSync(join(dir, 'ignored.txt'), 'not yaml');
    const result = loadRulesFromDir(dir);
    expect(result.rules.map((r) => r.id)).toEqual(['STROQ-2026-00001']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.file).toMatch(/b\.yml$/);
  });
});
