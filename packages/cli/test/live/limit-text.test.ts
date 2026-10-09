import { describe, expect, it } from 'vitest';
import { authTextOf, limitTextOf } from '../../src/live/limit-text.js';
import { cpuNow } from '../../../core/test/cpu-time.js';

/**
 * The words of a host that has run into a limit or has nobody logged in, and the one promise made
 * about them: whatever text they are looked for in, the time taken follows its length and nothing else.
 */
describe('limitTextOf', () => {
  it.each([
    ['Claude AI usage limit reached|1760000000', 'usage limit'],
    ["You've reached your 5-hour limit. Resets at 3pm", 'reached your'],
    ['Credit balance is too low to access the API', 'credit balance'],
    ['API Error: 429 rate limit exceeded', 'rate limit'],
    ['{"type":"rate_limit_error"}', 'rate_limit'],
    ['RATE-LIMIT', 'rate-limit'],
    ['ratelimit hit', 'ratelimit'],
    ['API Error: Overloaded', 'overloaded'],
    ['overloaded_error', 'overloaded'],
    ['Waiting for usage to reset', 'waiting for usage'],
    ['  \n\t USAGE LIMIT \n', 'usage limit'],
  ])('knows %j for a limit (%s)', (text, reason) => {
    expect(limitTextOf(text)).toBe(reason);
  });

  it.each([
    '',
    'DONE',
    'BLOCKED',
    'Stroq blocked this action (deny-git-exec): Installing repository-supplied execution is blocked',
    'I will not run that command.',
    'the speed limit is 50',
    'rate of change',
    'usage: stroq prove [options]',
    'reached',
    'a credit',
  ])('does not take %j for a limit', (text) => {
    expect(limitTextOf(text)).toBeNull();
  });

  it('says what it found in a few characters, however much text there was around it', () => {
    const found = limitTextOf(`${'x '.repeat(5000)}usage limit${' y'.repeat(5000)}`);
    expect(found).toBe('usage limit');
  });

  // The text is whatever a host or a command printed. A pattern that backtracks takes minutes on a
  // line built to make it; this one must take the same time on any text of the same length. Processor
  // time and not the wall clock: the wall clock measures how busy the machine is.
  describe('on a megabyte built to be slow', () => {
    const MIB = 1024 * 1024;
    const repeated = (unit: string): string => unit.repeat(Math.ceil(MIB / unit.length));
    const worst: ReadonlyArray<readonly [string, string]> = [
      [
        'the start of every phrase, never finished',
        repeated('usage limi rate- reached you credi '),
      ],
      ['rate, again and again', repeated('rate rate rate ')],
      ['rate and one character, never a limit', repeated('rate_lim ')],
      ['waiting for usag', repeated('waiting for usag ')],
      ['overloade', repeated('overloade ')],
      ['one long run of the same letter', 'r'.repeat(MIB)],
      ['rate and limi with nothing between', repeated('ratelimi')],
    ];

    it.each(worst)('reads %s in linear time', (_name, text) => {
      const started = cpuNow();
      const found = limitTextOf(text);
      const took = cpuNow() - started;
      expect(found).toBeNull();
      expect(took).toBeLessThan(1500);
    });

    it('finds a limit message at the very end of it', () => {
      const text = `${repeated('rate rate rate ')} Claude AI usage limit reached`;
      const started = cpuNow();
      expect(limitTextOf(text)).toBe('usage limit');
      expect(cpuNow() - started).toBeLessThan(1500);
    });
  });
});

describe('authTextOf', () => {
  it.each([
    ['Invalid API key · Please run /login', 'invalid api key'],
    ['Please run /login', 'please run /login'],
    ['Not logged in', 'not logged in'],
    ['{"type":"authentication_error"}', 'authentication_error'],
    ['OAuth token has expired', 'token has expired'],
    ['401 Unauthorized', 'unauthorized'],
  ])('knows %j for a failure to log in (%s)', (text, reason) => {
    expect(authTextOf(text)).toBe(reason);
  });

  it.each(['', 'DONE', 'BLOCKED', 'Claude AI usage limit reached', 'an author wrote this'])(
    'does not take %j for one',
    (text) => {
      expect(authTextOf(text)).toBeNull();
    },
  );

  it('reads a megabyte of near misses in linear time', () => {
    const text = 'authenticatio not logge invalid api ke '.repeat(30_000);
    const started = cpuNow();
    expect(authTextOf(text)).toBeNull();
    expect(cpuNow() - started).toBeLessThan(1500);
  });
});
