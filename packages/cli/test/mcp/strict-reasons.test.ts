import { describe, expect, it } from 'vitest';
import {
  WITHHOLD_REASONS,
  countClass,
  refusedServerRequest,
  withheldMessage,
} from '../../src/mcp/strict-reasons.js';

describe('refusedServerRequest', () => {
  it('echoes a short id so a server can match the refusal to its request', () => {
    expect(refusedServerRequest(7)['id']).toBe(7);
    expect(refusedServerRequest('srv-1')['id']).toBe('srv-1');
    expect(refusedServerRequest('x'.repeat(64))['id']).toBe('x'.repeat(64));
  });

  it('does not echo an id of unbounded size: a hostile server chose it', () => {
    const reply = refusedServerRequest('x'.repeat(200_000));
    expect(reply['id']).toBeNull();
    expect(JSON.stringify(reply).length).toBeLessThan(400);
  });

  it('is a method-not-found error, with a fixed message', () => {
    const reply = refusedServerRequest(1);
    expect(reply['error']).toEqual({
      code: -32601,
      message: 'Stroq strict mode does not forward server-initiated requests to the client.',
    });
  });
});

describe('countClass', () => {
  it.each([
    'unparsable',
    'invalid-shape',
    'unknown-id',
    'id-mismatch',
    'oversize',
    'unread-content',
  ])('counts %s as a malformed or hostile message', (reason) => {
    expect(countClass(reason as (typeof WITHHOLD_REASONS)[number])).toBe('hostile');
  });

  it.each(['scan-timeout', 'oversize-text', 'cloak-refused'])(
    'counts %s as the kind a benign server also produces',
    (reason) => {
      expect(countClass(reason as (typeof WITHHOLD_REASONS)[number])).toBe('benign');
    },
  );

  it('counts log lines and progress messages as benign, and every other unsolicited message as hostile', () => {
    expect(countClass('unsolicited', 'notifications/message')).toBe('benign');
    expect(countClass('unsolicited', 'notifications/progress')).toBe('benign');
    for (const method of [
      'sampling/createMessage',
      'elicitation/create',
      'roots/list',
      'notifications/tools/list_changed',
      'something/new',
      undefined,
    ])
      expect(countClass('unsolicited', method)).toBe('hostile');
  });

  it('classifies every reason there is', () => {
    for (const reason of WITHHOLD_REASONS)
      expect(['hostile', 'benign']).toContain(countClass(reason, 'x'));
  });
});

describe('withheldMessage', () => {
  it('says what the default proxy would have done, and for --cloak that is not forward it', () => {
    // Plain --cloak DROPS a result it cannot cloak and leaves the request unanswered.
    expect(withheldMessage('cloak-refused')).not.toContain('forwarded');
    expect(withheldMessage('cloak-refused')).toContain('--cloak');
    expect(withheldMessage('cloak-refused')).toContain('dropped');
    for (const reason of WITHHOLD_REASONS.filter((r) => r !== 'cloak-refused'))
      expect(withheldMessage(reason)).toContain('would have forwarded it');
  });

  it('takes its sizes from the constants, not from numbers typed twice', () => {
    expect(withheldMessage('oversize')).toContain('8 MiB');
    expect(withheldMessage('oversize-text')).toContain('200,000 characters');
  });

  it('never carries a word that is not its own', () => {
    for (const reason of WITHHOLD_REASONS)
      expect(withheldMessage(reason)).toMatch(
        /^Stroq strict mode withheld this server response \(/,
      );
  });
});
