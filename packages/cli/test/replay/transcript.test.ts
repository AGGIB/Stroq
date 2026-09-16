import { describe, expect, it } from 'vitest';
import { parseTranscript, projectSlug } from '../../src/replay/transcript.js';

const line = (obj: unknown): string => JSON.stringify(obj);

const assistant = (blocks: unknown[], at = '2026-09-16T10:00:00.000Z'): string =>
  line({
    type: 'assistant',
    sessionId: 'sess-1',
    cwd: '/home/dev/p',
    timestamp: at,
    message: { role: 'assistant', content: blocks },
  });

const user = (blocks: unknown[], at = '2026-09-16T10:00:05.000Z'): string =>
  line({
    type: 'user',
    sessionId: 'sess-1',
    timestamp: at,
    message: { role: 'user', content: blocks },
  });

describe('parseTranscript', () => {
  it('turns a tool call and its result into the pre and post events the hooks would see', () => {
    const text = [
      assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'hello world' }]),
    ].join('\n');

    const t = parseTranscript(text);

    expect(t.sessionId).toBe('sess-1');
    expect(t.cwd).toBe('/home/dev/p');
    expect(t.events).toHaveLength(2);
    expect(t.events[0]).toMatchObject({
      kind: 'pre',
      tool: 'Read',
      input: { file_path: 'README.md' },
    });
    expect(t.events[1]).toMatchObject({ kind: 'post', tool: 'Read', resultText: 'hello world' });
  });

  it('keeps the call before its result, which is what provenance depends on', () => {
    // An atom has to be recorded by the read before a later action can match it, so
    // a parser that emitted results first would silently produce an empty graph.
    const text = [
      assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'x' }]),
      assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }]),
    ].join('\n');

    expect(parseTranscript(text).events.map((e) => e.kind)).toEqual(['pre', 'post', 'pre']);
  });

  it('carries the call input onto the result, since a post event needs both', () => {
    const text = [
      assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat x' } }]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'contents' }]),
    ].join('\n');

    expect(parseTranscript(text).events[1]).toMatchObject({
      kind: 'post',
      input: { command: 'cat x' },
    });
  });

  it('flattens a result given as content blocks', () => {
    const text = [
      assistant([{ type: 'tool_use', id: 't1', name: 'Grep', input: {} }]),
      user([
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      ]),
    ].join('\n');

    expect(parseTranscript(text).events[1]).toMatchObject({ resultText: 'first\nsecond' });
  });

  it('ignores a result whose call is not in the transcript', () => {
    const text = user([{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }]);
    expect(parseTranscript(text).events).toHaveLength(0);
  });

  it('counts unparseable lines instead of failing, since a live transcript is partial', () => {
    const text = [
      assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
      '{ this is not json',
      '',
    ].join('\n');

    const t = parseTranscript(text);
    expect(t.events).toHaveLength(1);
    expect(t.skipped).toBe(1);
  });

  it('ignores records that carry no tool blocks', () => {
    const text = [
      line({ type: 'ai-title', sessionId: 'sess-1', content: 'a title' }),
      assistant([{ type: 'text', text: 'thinking out loud' }]),
    ].join('\n');

    expect(parseTranscript(text).events).toHaveLength(0);
  });
});

describe('projectSlug', () => {
  it('matches the agent’s own directory naming', () => {
    expect(projectSlug('/Users/dev/Documents/stroq')).toBe('-Users-dev-Documents-stroq');
    expect(projectSlug('/home/dev/my.app')).toBe('-home-dev-my-app');
  });
});
