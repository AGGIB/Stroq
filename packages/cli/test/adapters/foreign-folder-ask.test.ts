import { describe, expect, it } from 'vitest';
import { renderDecision as codex } from '../../src/adapters/codex.js';
import { renderDecision as windsurf } from '../../src/adapters/windsurf.js';

const asked = {
  effect: 'ask' as const,
  ruleId: 'ask-foreign-folder',
  reason: 'Read them first: stroq inspect.',
};
const ordinary = { effect: 'ask' as const, ruleId: 'ask-destructive', reason: 'Destructive.' };

describe.each([
  ['Codex', codex],
  ['Windsurf', windsurf],
])('%s, which cannot ask', (host, render) => {
  it('does not point at a policy rule that cannot change this', () => {
    const out = JSON.stringify(render(asked, [], []));
    expect(out).toContain(`${host} hooks cannot prompt`);
    expect(out).not.toContain('policy.yaml');
  });

  it('still points at the policy for a rule that is in it', () => {
    expect(JSON.stringify(render(ordinary, [], []))).toContain('policy.yaml');
  });
});
