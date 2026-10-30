import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBundle } from '../../src/rules/bundle.js';
import { SCAN_TARGETS } from '../../src/rules/atr-types.js';
import { compileRule } from '../../src/rules/compile.js';
import { ruleMatches } from '../../src/scan/matcher.js';

/**
 * Narrowing where a rule reads (a condition or a whole rule limited to some surfaces) exists to
 * stop false alarms on the developer's own code. It must never cost a rule its own attacks: an
 * instruction planted in a cloned repository arrives by `Read README.md`, `cat` or `git log`, not
 * only by a fetched page. So every true positive a scoped rule catches with no surface named has
 * to be caught on every surface.
 */
const bundle = JSON.parse(
  readFileSync(new URL('../../src/rules.bundle.json', import.meta.url), 'utf8'),
) as { rules: Array<Record<string, unknown>>; disabled: string[] };
const parsed = parseBundle(bundle);
const disabled = new Set(parsed.disabled);
const raw = new Map(bundle.rules.map((r) => [r['id'] as string, r]));

const scoped = parsed.rules.filter(
  (rule) =>
    !disabled.has(rule.id) &&
    ((rule.tags as Record<string, unknown> | undefined)?.['stroq_surfaces'] !== undefined ||
      rule.detection.conditions.some((c) => c.stroq_surfaces !== undefined)),
);
const SURFACES = SCAN_TARGETS.filter((t) => t !== 'any');

describe('a scoped rule keeps its own attacks on every surface', () => {
  it('has scoped rules to check', () => {
    expect(scoped.length).toBeGreaterThan(0);
  });

  for (const rule of scoped) {
    const compiled = compileRule(rule).compiled!;
    const cases = (
      ((raw.get(rule.id)?.['test_cases'] as Record<string, unknown> | undefined)?.[
        'true_positives'
      ] as Array<Record<string, unknown>> | undefined) ?? []
    )
      .map((c) => c['input'])
      .filter((input): input is string => typeof input === 'string')
      .filter((input) => ruleMatches(compiled, input, {}));
    it(`${rule.id}: ${cases.length} true positives on ${SURFACES.length} surfaces`, () => {
      for (const input of cases)
        for (const target of SURFACES)
          expect(
            ruleMatches(compiled, input, { target }),
            `${rule.id} on ${target}: ${input.slice(0, 80)}`,
          ).toBe(true);
    });
  }
});
