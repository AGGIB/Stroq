import { describe, expect, it } from 'vitest';
import { isSubscriptionKeySource, runProblem } from '../../src/live/run-problem.js';
import { REASONS } from '../../src/live/types.js';
import { finished } from './helpers.js';

/**
 * A driver stops a host on the key source of its first message, and `runProblem` judges the finished run on
 * the same words. They are one rule (`isSubscriptionKeySource`), and this holds the two to each other.
 */
describe('isSubscriptionKeySource', () => {
  it.each([
    ['none', true],
    ['oauth', true],
    ['NONE', true],
    [' OAuth ', true],
    ['user', false],
    ['project', false],
    ['org', false],
    ['temporary', false],
    ['ANTHROPIC_API_KEY', false],
    ['', false],
    ['nonexistent', false],
    ['none none', false],
  ])('says %j is a login: %s', (source, wanted) => {
    expect(isSubscriptionKeySource(source)).toBe(wanted);
  });

  it('is the rule runProblem stops a finished run by', () => {
    for (const source of ['none', 'oauth', ' None ', 'user', 'org', '', 'x']) {
      const problem = runProblem(finished([], { apiKeySource: source }));
      expect(problem?.reason === REASONS.apiBilling, source).toBe(!isSubscriptionKeySource(source));
    }
  });
});
