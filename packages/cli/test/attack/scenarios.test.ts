import { describe, expect, it } from 'vitest';
import { ClaudeHookInputSchema } from '../../src/adapters/claude-code.js';
import {
  CWD_PLACEHOLDER,
  SYNTHETIC_SECRET_PREFIX,
  type Scenario,
} from '../../src/attack/scenario.js';
import { SCENARIOS } from '../../src/attack/scenarios/index.js';

const REAL_SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
];

const lastStep = (s: Scenario) => s.steps[s.steps.length - 1];

describe('attack scenarios', () => {
  it('ships twelve scenarios with sequential, unique ids', () => {
    expect(SCENARIOS).toHaveLength(12);
    SCENARIOS.forEach((s, i) =>
      expect(s.id).toMatch(new RegExp(`^${String(i + 1).padStart(2, '0')}-[a-z0-9-]+$`)),
    );
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(12);
  });

  it('cites a dated public incident for each scenario', () => {
    for (const s of SCENARIOS) {
      expect(s.incident.url).toMatch(/^https:\/\//);
      expect(s.incident.date).toMatch(/^\d{4}-\d{2}$/);
      expect(s.incident.name.length).toBeGreaterThan(5);
      expect(s.title.length).toBeGreaterThan(10);
    }
  });

  it('ends every scenario with the attack as a PreToolUse expected to be stopped', () => {
    for (const s of SCENARIOS) {
      const last = lastStep(s);
      expect(last?.event.hook_event_name).toBe('PreToolUse');
      expect(['deny', 'ask']).toContain(last?.expect);
    }
  });

  it('records events in the Claude Code hook shape with the cwd placeholder', () => {
    for (const s of SCENARIOS)
      for (const step of s.steps) {
        expect(() => ClaudeHookInputSchema.parse(step.event)).not.toThrow();
        expect(step.event.cwd).toBe(CWD_PLACEHOLDER);
        expect(step.event.session_id).toBe('stroq-attack');
      }
  });

  it('pairs each expectation with its phase', () => {
    for (const s of SCENARIOS)
      for (const step of s.steps) {
        const allowed =
          step.event.hook_event_name === 'PreToolUse'
            ? ['deny', 'ask', 'allow']
            : ['suspect', 'clean'];
        expect(allowed).toContain(step.expect);
      }
  });

  it('contains only synthetic secrets', () => {
    const text = JSON.stringify(SCENARIOS);
    for (const re of REAL_SECRET_SHAPES) expect(text).not.toMatch(re);
    for (const s of SCENARIOS)
      for (const body of Object.values(s.files ?? {}))
        for (const line of body.split('\n').filter((l) => l.includes('=')))
          expect(line.split('=')[1]).toMatch(new RegExp(`^${SYNTHETIC_SECRET_PREFIX}`));
  });
});
