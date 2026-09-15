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

  // `test_cases` is self-test metadata: no engine path and no build gate reads it
  // (the benign and perf gates scan rules/fixtures/benign, not a rule's own fixtures).
  // It used to be the one field that could delete a rule anyway — TestCaseSchema
  // required `input: string`, so a fixture written with any other payload key made
  // the whole document fail to parse, and loadRulesFromDir drops what it cannot
  // parse. That silently removed 40 of 648 vendored rules from the shipped bundle,
  // 17 of them critical, while the build printed "verified" and exited 0.
  // A malformed fixture may cost the fixture. It may never cost the detection.
  it.each([
    ['content', 'content: payload text'],
    ['tool_response', 'tool_response: payload text'],
    ['tool_description', 'tool_description: payload text'],
    ['agent_output', 'agent_output: payload text'],
    ['user_input', 'user_input: payload text'],
    ['a structured input', 'input:\n        tool_name: run\n        tool_args: payload text'],
  ])('keeps the rule when a fixture carries its payload as %s', (_label, fixture) => {
    const withFixture = `${good}
test_cases:
  true_positives:
    - ${fixture}
      expected: triggered
`;
    const { rule, error } = parseRule(withFixture, 'fixture-shape.yaml');
    expect(error).toBeUndefined();
    expect(rule?.id).toBe('STROQ-2026-00001');
    expect(rule?.detection.conditions[0]?.value).toBe('do not tell the user');
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
