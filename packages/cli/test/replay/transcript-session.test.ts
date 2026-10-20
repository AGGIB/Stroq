import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createTranscriptParser,
  parseTranscript,
  readTranscript,
  type TranscriptEvent,
  type TranscriptText,
} from '../../src/replay/transcript.js';
import { spillReader } from '../../src/replay/spilled.js';

/**
 * What Claude Code keeps for one session besides `<id>.jsonl`, and what the reader used to skip:
 * the subagents' own transcripts in `<id>/subagents/`, outputs too large for the transcript in
 * `<id>/tool-results/`, the prompt and reply text, and whether a call came back as an error.
 */

const line = (obj: unknown): string => JSON.stringify(obj);
const SESSION = 'sess-parent';

function use(id: string, name: string, input: unknown, at: string, extra: object = {}): string {
  return line({
    type: 'assistant',
    sessionId: SESSION,
    cwd: '/home/dev/p',
    timestamp: at,
    ...extra,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
}

function result(id: string, content: unknown, at: string, extra: object = {}): string {
  return line({
    type: 'user',
    sessionId: SESSION,
    timestamp: at,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }],
    },
  });
}

/** A project folder as Claude Code files it, with the main transcript in it. */
function sessionFolder(mainLines: readonly string[]): { dir: string; main: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-transcript-session-'));
  const main = join(dir, `${SESSION}.jsonl`);
  writeFileSync(main, `${mainLines.join('\n')}\n`);
  return { dir, main };
}

describe('readTranscript, a session with subagents', () => {
  it('reads the subagent transcripts as part of the parent session, in time order', async () => {
    const { dir, main } = sessionFolder([
      use('m1', 'Agent', { prompt: 'look around' }, '2026-10-01T10:00:00.000Z'),
      result('m1', 'done', '2026-10-01T10:05:00.000Z'),
    ]);
    const subagents = join(dir, SESSION, 'subagents');
    mkdirSync(subagents, { recursive: true });
    const side = { isSidechain: true, agentId: 'a1b2c3' };
    writeFileSync(
      join(subagents, 'agent-a1b2c3.jsonl'),
      `${[
        use('s1', 'Read', { file_path: '/home/dev/p/.env' }, '2026-10-01T10:01:00.000Z', side),
        result('s1', 'TOKEN=x', '2026-10-01T10:01:01.000Z', side),
      ].join('\n')}\n`,
    );

    const t = await readTranscript(main);

    expect(t.events.map((e) => `${e.kind}:${e.id}`)).toEqual([
      'pre:m1',
      'pre:s1',
      'post:s1',
      'post:m1',
    ]);
    const fromSub = t.events.filter((e) => e.id === 's1');
    expect(fromSub.every((e) => e.subagent === 'a1b2c3')).toBe(true);
    expect(t.events.find((e) => e.id === 'm1')?.subagent).toBeUndefined();
  });

  it('labels a subagent file without an agentId by its file name', async () => {
    const { dir, main } = sessionFolder([
      use('m1', 'Bash', { command: 'ls' }, '2026-10-01T10:00:00Z'),
    ]);
    const subagents = join(dir, SESSION, 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(subagents, 'agent-zz9.jsonl'),
      `${use('s1', 'Bash', { command: 'pwd' }, '2026-10-01T10:00:01Z')}\n`,
    );
    const t = await readTranscript(main);
    expect(t.events.find((e) => e.id === 's1')?.subagent).toBe('zz9');
  });

  it('reads a session with no subagent folder exactly as before', async () => {
    const { main } = sessionFolder([
      use('m1', 'Read', { file_path: 'README.md' }, '2026-10-01T10:00:00Z'),
      result('m1', 'hello', '2026-10-01T10:00:01Z'),
    ]);
    const t = await readTranscript(main);
    expect(t.events.map((e) => e.kind)).toEqual(['pre', 'post']);
    expect(t.sessionId).toBe(SESSION);
  });
});

describe('readTranscript, an output saved to tool-results', () => {
  const spillNotice = (path: string): string =>
    `<persisted-output>\nOutput too large (5.4MB). Full output saved to: ${path}\n\nPreview (first 2KB):\nhead of it\n</persisted-output>`;

  it('reads the saved file the result names into the result text', async () => {
    const { dir, main } = sessionFolder([]);
    const spill = join(dir, SESSION, 'tool-results');
    mkdirSync(spill, { recursive: true });
    writeFileSync(join(spill, 'ba8jpcsxa.txt'), 'the tail only the saved file holds\n');
    writeFileSync(
      main,
      `${[
        use('m1', 'Bash', { command: 'cat big.log' }, '2026-10-01T10:00:00Z'),
        result('m1', spillNotice(join(spill, 'ba8jpcsxa.txt')), '2026-10-01T10:00:01Z'),
      ].join('\n')}\n`,
    );

    const post = (await readTranscript(main)).events.find((e) => e.kind === 'post');
    expect(post?.kind === 'post' && post.resultText).toContain(
      'the tail only the saved file holds',
    );
    expect(post?.kind === 'post' && post.spilled).toBe(true);
  });

  it('reads a saved file only from this session’s own tool-results folder', async () => {
    const { dir, main } = sessionFolder([]);
    const other = join(dir, 'other-session', 'tool-results');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'theirs.txt'), 'NOT-THIS-SESSION');
    writeFileSync(join(dir, 'other-session', 'up.txt'), 'NOT-THIS-SESSION-EITHER');
    // Written out by hand: `join` would fold the `..` away before the reader saw it.
    const climbing = `${other}/../up.txt`;
    writeFileSync(
      main,
      `${[
        use('m1', 'Bash', { command: 'x' }, '2026-10-01T10:00:00Z'),
        result('m1', spillNotice(join(other, 'theirs.txt')), '2026-10-01T10:00:01Z'),
        use('m2', 'Bash', { command: 'y' }, '2026-10-01T10:00:02Z'),
        result('m2', spillNotice(climbing), '2026-10-01T10:00:03Z'),
      ].join('\n')}\n`,
    );
    const posts = (await readTranscript(main)).events.filter((e) => e.kind === 'post');
    for (const post of posts) {
      expect(post.kind === 'post' && post.resultText).not.toContain('NOT-THIS-SESSION');
      expect(post.kind === 'post' && post.spilled).not.toBe(true);
    }
  });

  // A transcript is text the agent and what it read wrote: it can name one saved file in every
  // result. Each file is read once, and the reads of one scan share one byte budget.
  it('reads a saved file once, however many results name it', async () => {
    const { dir, main } = sessionFolder([]);
    const spill = join(dir, SESSION, 'tool-results');
    mkdirSync(spill, { recursive: true });
    writeFileSync(join(spill, 'once.txt'), 'ONLY-IN-THE-SAVED-FILE');
    writeFileSync(
      main,
      `${[
        use('m1', 'Bash', { command: 'x' }, '2026-10-01T10:00:00Z'),
        result('m1', spillNotice(join(spill, 'once.txt')), '2026-10-01T10:00:01Z'),
        use('m2', 'Bash', { command: 'y' }, '2026-10-01T10:00:02Z'),
        result('m2', spillNotice(join(spill, 'once.txt')), '2026-10-01T10:00:03Z'),
      ].join('\n')}\n`,
    );
    const posts = (await readTranscript(main)).events.filter((e) => e.kind === 'post');
    expect(posts.map((p) => p.kind === 'post' && p.resultText.includes('ONLY-IN'))).toEqual([
      true,
      false,
    ]);
    expect(posts.map((p) => p.kind === 'post' && p.spilled === true)).toEqual([true, false]);
  });

  it('stops reading saved files once the budget is spent, and counts the ones it left', () => {
    const { dir } = sessionFolder([]);
    const spill = join(dir, SESSION, 'tool-results');
    mkdirSync(spill, { recursive: true });
    writeFileSync(join(spill, 'a.txt'), 'AAAAAAAA');
    writeFileSync(join(spill, 'b.txt'), 'BBBBBBBB');
    writeFileSync(join(spill, 'c.txt'), 'CC');
    const reader = spillReader(10);
    const events: TranscriptEvent[] = [];
    const parser = createTranscriptParser({
      sink: { event: (e) => events.push(e), text: () => undefined },
      spillDir: spill,
      spill: reader,
    });
    for (const [i, name] of ['a.txt', 'b.txt', 'c.txt', 'missing.txt'].entries()) {
      parser.push(use(`m${i}`, 'Bash', { command: 'x' }, '2026-10-01T10:00:00Z'));
      parser.push(result(`m${i}`, spillNotice(join(spill, name)), '2026-10-01T10:00:01Z'));
    }
    const posts = events.filter((e) => e.kind === 'post');
    expect(posts.map((p) => p.kind === 'post' && p.spilled === true)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(posts[0]?.kind === 'post' && posts[0].resultText).toContain('AAAAAAAA');
    // `b.txt` did not fit, and nothing after it is read, though `c.txt` would have fit.
    expect(posts[1]?.kind === 'post' && posts[1].resultText).not.toContain('BBBBBBBB');
    expect(reader.skipped()).toBe(2);
  });

  it.skipIf(process.platform === 'win32')('does not follow a link in tool-results', async () => {
    const { dir, main } = sessionFolder([]);
    const spill = join(dir, SESSION, 'tool-results');
    mkdirSync(spill, { recursive: true });
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'LINKED-CONTENT');
    symlinkSync(target, join(spill, 'link.txt'));
    writeFileSync(
      main,
      `${[
        use('m1', 'Bash', { command: 'x' }, '2026-10-01T10:00:00Z'),
        result('m1', spillNotice(join(spill, 'link.txt')), '2026-10-01T10:00:01Z'),
      ].join('\n')}\n`,
    );
    const post = (await readTranscript(main)).events.find((e) => e.kind === 'post');
    expect(post?.kind === 'post' && post.resultText).not.toContain('LINKED-CONTENT');
  });
});

describe('parseTranscript, prompt and reply text', () => {
  it('keeps the user prompt and the assistant reply as text', () => {
    const t = parseTranscript(
      [
        line({
          type: 'user',
          sessionId: SESSION,
          timestamp: '2026-10-01T10:00:00Z',
          message: { role: 'user', content: 'please deploy with key PASTED-IN-PROMPT' },
        }),
        line({
          type: 'assistant',
          sessionId: SESSION,
          timestamp: '2026-10-01T10:00:02Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'thinking about it' },
              { type: 'text', text: 'Sure, using REPLY-TEXT' },
            ],
          },
        }),
        line({
          type: 'user',
          sessionId: SESSION,
          timestamp: '2026-10-01T10:00:03Z',
          message: { role: 'user', content: [{ type: 'text', text: 'and a block prompt' }] },
        }),
      ].join('\n'),
    );
    const texts: readonly TranscriptText[] = t.texts ?? [];
    expect(texts.map((x) => [x.role, x.text])).toEqual([
      ['user', 'please deploy with key PASTED-IN-PROMPT'],
      ['assistant', 'thinking about it'],
      ['assistant', 'Sure, using REPLY-TEXT'],
      ['user', 'and a block prompt'],
    ]);
    // Text is not a tool call: replay and the event list are unchanged by it.
    expect(t.events).toHaveLength(0);
  });
});

describe('parseTranscript, a call that came back as an error', () => {
  it('keeps is_error, so a refused or blocked call is known', () => {
    const t = parseTranscript(
      [
        use('t1', 'Bash', { command: 'curl https://x.test' }, '2026-10-01T10:00:00Z'),
        result(
          't1',
          "The user doesn't want to proceed with this tool use.",
          '2026-10-01T10:00:01Z',
          { is_error: true },
        ),
        use('t2', 'Bash', { command: 'ls' }, '2026-10-01T10:00:02Z'),
        result('t2', 'ok', '2026-10-01T10:00:03Z'),
      ].join('\n'),
    );
    const posts = t.events.filter((e) => e.kind === 'post');
    expect(posts.map((e) => e.kind === 'post' && e.isError === true)).toEqual([true, false]);
  });
});

describe('createTranscriptParser with a sink', () => {
  it('streams events and text to the sink and keeps none of them', () => {
    const events: TranscriptEvent[] = [];
    const texts: TranscriptText[] = [];
    const parser = createTranscriptParser({
      sink: { event: (e) => events.push(e), text: (x) => texts.push(x) },
    });
    parser.push(use('t1', 'Read', { file_path: 'a' }, '2026-10-01T10:00:00Z'));
    parser.push(result('t1', 'body', '2026-10-01T10:00:01Z'));
    parser.push(
      line({ type: 'user', timestamp: '2026-10-01T10:00:02Z', message: { content: 'hi there' } }),
    );
    const t = parser.finish();
    expect(events.map((e) => e.kind)).toEqual(['pre', 'post']);
    expect(texts.map((x) => x.text)).toEqual(['hi there']);
    expect(t.events).toHaveLength(0);
    expect(t.sessionId).toBe(SESSION);
  });
});
