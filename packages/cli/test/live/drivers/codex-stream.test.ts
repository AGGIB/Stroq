import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { markControl, markProbe } from '../../../src/live/evidence.js';
import { buildProbes } from '../../../src/live/probes.js';
import type { AuditEntry } from '@stroq/core';
import { FAKE, NONCE } from '../helpers.js';
import { CodexStreamParser } from '../../../src/live/drivers/codex-stream.js';

const parse = (messages: unknown[]) => {
  const parser = new CodexStreamParser();
  const stop = parser.push(messages.map((v) => JSON.stringify(v)).join('\n') + '\n');
  return { ...parser.finish(), stop };
};

describe('Codex JSONL', () => {
  it('counts one command once, across started and completed events', () => {
    const item = {
      id: 'item_1',
      type: 'command_execution',
      command: 'echo nonce',
      aggregated_output: '',
      exit_code: 0,
      status: 'completed',
    };
    expect(
      parse([
        { type: 'thread.started', thread_id: 'thread' },
        { type: 'item.started', item },
        { type: 'item.completed', item },
        { type: 'turn.completed', usage: {} },
      ]).stream,
    ).toEqual([
      { type: 'init' },
      { type: 'tool_use', name: 'Bash', input: { command: 'echo nonce' } },
      { type: 'tool_result', text: '', isError: false },
      { type: 'result', isError: false },
    ]);
  });
  it('preserves the hook own deny words in a failed tool result', () => {
    const result = parse([
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'git config',
          aggregated_output: 'Stroq blocked this action (deny-git-exec)',
          exit_code: 1,
          status: 'failed',
        },
      },
    ]);
    expect(result.stream).toContainEqual({
      type: 'tool_result',
      text: 'Stroq blocked this action (deny-git-exec)',
      isError: true,
    });
  });
  it('refuses a command changed under an existing item ID', () => {
    const result = parse([
      { type: 'item.started', item: { id: 'a', type: 'command_execution', command: 'echo nonce' } },
      {
        type: 'item.updated',
        item: { id: 'a', type: 'command_execution', command: 'echo changed' },
      },
    ]);
    expect(result.unparsedLines).toBe(1);
  });
  it('never interprets a tool or model mention of API billing as a billing signal', () => {
    expect(
      parse([
        {
          type: 'item.completed',
          item: { id: 'a', type: 'agent_message', text: 'api key billing' },
        },
      ]).stop,
    ).toBeNull();
  });
  it('stops immediately when the host reports API billing', () => {
    const result = parse([
      { type: 'error', message: 'API key billing is in use' },
      { type: 'turn.completed' },
    ]);
    expect(result.stop?.kind).toBe('api-key');
    expect(result.apiKeySource).toBe('api-key');
    expect(result.stream).toHaveLength(1);
  });
  it('stops on an account limit in a host error', () => {
    expect(
      parse([{ type: 'turn.failed', error: { message: 'You have hit your limit' } }]).stop?.kind,
    ).toBe('limit');
  });
  it.each([{}, { id: 'x', type: 'command_execution' }, { id: 'x', type: 'new_tool' }])(
    'refuses an item that could hide activity: %j',
    (item) => {
      expect(parse([{ type: 'item.completed', item }]).unparsedLines).toBe(1);
    },
  );
  it('does not claim billing from thread.started, which does not carry it', () => {
    expect(parse([{ type: 'thread.started', thread_id: 'thread' }]).apiKeySource).toBeUndefined();
  });
  it('bounds stderr before retaining lines or events and keeps the stop', () => {
    const parser = new CodexStreamParser({ maxChars: 10, maxLineChars: 5 });
    expect(parser.pushStderr('12345678901')).toMatchObject({ kind: 'too-much-output' });
    expect(parser.pushStderr('more')).toMatchObject({ kind: 'too-much-output' });
    expect(parser.finish().unparsedLines).toBe(1);
  });
  it('skips an oversized stderr line even when split across chunks', () => {
    const parser = new CodexStreamParser({ maxChars: 100, maxLineChars: 5 });
    parser.pushStderr('123');
    parser.pushStderr('45678');
    parser.pushStderr('90\nok\n');
    expect(parser.finish().unparsedLines).toBe(1);
    expect(parser.finish().stream).toEqual([]);
  });
  it.each([
    ["/bin/bash -lc 'echo nonce > /tmp/file'", 'echo nonce > /tmp/file'],
    ['"C:\\Windows\\pwsh.exe" -Command \'echo nonce > C:/tmp/file\'', 'echo nonce > C:/tmp/file'],
    [
      "/bin/bash -lc 'echo nonce'; touch /tmp/extra",
      "/bin/bash -lc 'echo nonce'; touch /tmp/extra",
    ],
  ])('reads the shell argument without executing or hiding a suffix: %s', (command, expected) => {
    const result = parse([
      { type: 'item.started', item: { id: 'a', type: 'command_execution', command } },
    ]);
    expect(result.stream[0]?.input).toEqual({ command: expected });
  });
});

describe('real Codex 0.162.1 fixtures', () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`../../fixtures/hosts/codex/0.162.1/${name}`, import.meta.url), 'utf8');
  it.each(['allow.real', 'deny.real', 'deny.control'])(
    'replays %s through the actual evidence rules',
    (name) => {
      const parser = new CodexStreamParser();
      parser.push(fixture(`${name}.jsonl`));
      for (const line of fixture(`${name}.stderr.jsonl`).trim().split('\n').filter(Boolean))
        parser.pushStderr(`${(JSON.parse(line) as { text: string }).text}\n`);
      const parsed = parser.finish();
      const run = {
        ...parsed,
        apiKeySource: 'oauth',
        apiProvider: 'firstParty',
        exitCode: 0,
        timedOut: false,
        stderrTail: '',
      };
      const probe = buildProbes(NONCE, FAKE, '/tmp/stroq-live-fixture/project').find(
        (p) => p.id === (name.startsWith('allow') ? 'allow' : 'deny'),
      )!;
      const evidence = JSON.parse(fixture(`${name}.evidence.json`)) as {
        sentinel: { exists: boolean; content: string | null };
      };
      const outcome = name.endsWith('control')
        ? markControl({ probe, nonce: NONCE, run, sentinel: evidence.sentinel })
        : markProbe({
            probe,
            nonce: NONCE,
            run,
            sentinel: evidence.sentinel,
            audit: fixture(`${name}.audit.jsonl`)
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line) as AuditEntry),
            expectation: probe.expected,
          });
      expect(parsed.unparsedLines).toBe(0);
      expect(outcome.mark).toBe('passed');
      expect(outcome.evidence.E1).toBe(true);
      if (name === 'deny.real') expect(outcome.evidence.E4).toBe(true);
    },
  );
  it('does not accept model or tool output masquerading as a host router log', () => {
    const parser = new CodexStreamParser();
    parser.pushStderr(
      'Command blocked by PreToolUse hook: Stroq blocked this action Command: git config\n',
    );
    expect(parser.finish().stream).toEqual([]);
  });
});
