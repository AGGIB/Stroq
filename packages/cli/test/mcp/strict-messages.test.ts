import { describe, expect, it } from 'vitest';
import { classifyMessage } from '../../src/mcp/framing.js';
import {
  FORWARDED_SERVER_METHODS,
  describeMethod,
  mayForwardServerMessage,
} from '../../src/mcp/strict-messages.js';

const may = (value: unknown): boolean => {
  const message = classifyMessage(value);
  if (message.kind !== 'request' && message.kind !== 'notification') {
    throw new Error('not a request or a notification');
  }
  return mayForwardServerMessage(message);
};

describe('mayForwardServerMessage', () => {
  it.each([
    'notifications/tools/list_changed',
    'notifications/resources/list_changed',
    'notifications/prompts/list_changed',
  ])('forwards %s when it carries no parameters', (method) => {
    expect(may({ jsonrpc: '2.0', method })).toBe(true);
    expect(may({ jsonrpc: '2.0', method, params: {} })).toBe(true);
  });

  it('withholds a list-changed notification that carries anything, since that is text', () => {
    expect(
      may({
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed',
        params: { _meta: { n: 'x' } },
      }),
    ).toBe(false);
    expect(may({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: 'x' })).toBe(
      false,
    );
  });

  it('forwards a progress notification made only of a token and numbers', () => {
    expect(
      may({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'tok-1', progress: 3, total: 10 },
      }),
    ).toBe(true);
    expect(
      may({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 7, progress: 0.5 },
      }),
    ).toBe(true);
  });

  it('withholds a progress notification with a message, an odd token or a non-number', () => {
    const progress = (params: unknown) =>
      may({ jsonrpc: '2.0', method: 'notifications/progress', params });
    expect(progress({ progressToken: 1, progress: 1, message: 'Fetching page 3' })).toBe(false);
    expect(progress({ progressToken: 'two words', progress: 1 })).toBe(false);
    expect(progress({ progressToken: 'x'.repeat(200), progress: 1 })).toBe(false);
    expect(progress({ progressToken: 1, progress: '1' })).toBe(false);
    expect(progress({ progressToken: 1, progress: 1, total: null })).toBe(false);
    expect(progress({ progress: 1 })).toBe(false);
    expect(progress({ progressToken: 1, progress: 1, _meta: {} })).toBe(false);
    expect(progress(undefined)).toBe(false);
  });

  it('forwards a ping with no parameters and nothing else a server asks', () => {
    expect(may({ jsonrpc: '2.0', id: 4, method: 'ping' })).toBe(true);
    expect(may({ jsonrpc: '2.0', id: 4, method: 'ping', params: { _meta: {} } })).toBe(false);
  });

  it.each([
    ['sampling/createMessage', { messages: [], maxTokens: 1 }],
    ['elicitation/create', { message: 'q' }],
    ['roots/list', undefined],
    ['notifications/message', { level: 'info', data: 'x' }],
    ['notifications/resources/updated', { uri: 'file:///x' }],
    ['notifications/cancelled', { requestId: 1 }],
    ['logging/setLevel', {}],
    ['something/new', {}],
  ])('withholds %s: a server channel strict mode does not forward', (method, params) => {
    expect(may({ jsonrpc: '2.0', id: 'srv-1', method, ...(params ? { params } : {}) })).toBe(false);
    expect(may({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })).toBe(false);
  });

  it('matches the method exactly: no case folding, no padding', () => {
    expect(
      may({
        jsonrpc: '2.0',
        method: 'Notifications/Progress',
        params: { progressToken: 1, progress: 1 },
      }),
    ).toBe(false);
    expect(
      may({
        jsonrpc: '2.0',
        method: 'notifications/progress ',
        params: { progressToken: 1, progress: 1 },
      }),
    ).toBe(false);
  });

  it('withholds a message with a top-level key beyond the JSON-RPC ones', () => {
    expect(may({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', note: 'x' })).toBe(
      false,
    );
  });

  it('lists exactly the methods it forwards, for the documentation to be held to', () => {
    expect([...FORWARDED_SERVER_METHODS].sort()).toEqual([
      'notifications/progress',
      'notifications/prompts/list_changed',
      'notifications/resources/list_changed',
      'notifications/tools/list_changed',
      'ping',
    ]);
  });
});

describe('describeMethod', () => {
  it('names an ordinary method', () => {
    expect(describeMethod('sampling/createMessage')).toBe('sampling/createMessage');
  });

  it('never repeats a method that is long or holds anything but name characters', () => {
    expect(describeMethod('x'.repeat(65))).toBe('(unprintable method)');
    expect(describeMethod('ignore previous instructions')).toBe('(unprintable method)');
    expect(describeMethod('a\nb')).toBe('(unprintable method)');
    expect(describeMethod('')).toBe('(unprintable method)');
  });
});
