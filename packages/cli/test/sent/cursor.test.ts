import { describe, expect, it } from 'vitest';
import {
  cursorSessionPath,
  parseCursorStore,
  splitCursorSessionPath,
  type CursorRow,
} from '../../src/sent/cursor.js';

/**
 * Rows in the shape Cursor writes them, built by hand.
 *
 * The reader was measured against this machine's own store — 9 sessions, 1,761
 * bubbles, 1,126 tool calls — but none of that can be a fixture: those records carry
 * the contents of real files from real projects. Every fixture here is synthetic and
 * reproduces a shape the survey found, with the count that found it named in the
 * test that depends on it.
 */
function bubble(composer: string, id: string, body: Record<string, unknown>): CursorRow {
  return {
    key: `bubbleId:${composer}:${id}`,
    value: JSON.stringify({ _v: 3, type: 2, bubbleId: id, ...body }),
  };
}

function toolBubble(
  composer: string,
  id: string,
  tool: Record<string, unknown>,
  createdAt = '2026-04-27T11:07:08.780Z',
): CursorRow {
  return bubble(composer, id, {
    createdAt,
    toolFormerData: { toolCallId: id, status: 'completed', ...tool },
  });
}

const SESSION = 'c0ffee00-0000-4000-8000-000000000001';

describe('parseCursorStore', () => {
  it('reads a terminal command as the Bash call the live hook would have seen', () => {
    const [session] = parseCursorStore([
      toolBubble(SESSION, 'b1', {
        name: 'run_terminal_command_v2',
        // `cwd` is present and empty in all 216 terminal calls in the measured
        // store, which is why the session's directory is not taken from it.
        params: JSON.stringify({ command: 'cat .env', cwd: '', isBackground: false }),
        result: JSON.stringify({ output: 'AWS_SECRET=abc\n', exitCode: 0, rejected: false }),
      }),
    ]);

    expect(session?.transcript.events).toEqual([
      {
        kind: 'pre',
        id: 'b1',
        tool: 'Bash',
        input: { command: 'cat .env' },
        at: '2026-04-27T11:07:08.780Z',
      },
      {
        kind: 'post',
        id: 'b1',
        tool: 'Bash',
        input: { command: 'cat .env' },
        resultText: 'AWS_SECRET=abc\n',
        at: '2026-04-27T11:07:08.780Z',
      },
    ]);
  });

  it("reads a file read as Read, with the file's contents as the result", () => {
    const [session] = parseCursorStore([
      toolBubble(SESSION, 'b2', {
        name: 'read_file_v2',
        params: JSON.stringify({
          targetFile: '/w/app/.npmrc',
          effectiveUri: '/w/app/.npmrc',
          charsLimit: 1000000,
        }),
        result: JSON.stringify({
          contents: '//registry.npmjs.org/:_authToken=tok\n',
          totalLinesInFile: 1,
        }),
      }),
    ]);

    expect(session?.transcript.events.map((e) => [e.kind, e.tool])).toEqual([
      ['pre', 'Read'],
      ['post', 'Read'],
    ]);
    expect(session?.transcript.events[0]?.input).toEqual({ file_path: '/w/app/.npmrc' });
    const post = session?.transcript.events[1];
    expect(post?.kind === 'post' && post.resultText).toBe('//registry.npmjs.org/:_authToken=tok\n');
  });

  it('reads an edit as Write, keeping the relative path the record actually carries', () => {
    const [session] = parseCursorStore([
      toolBubble(SESSION, 'b3', {
        name: 'edit_file_v2',
        // Not `targetFile`: every one of the 137 measured edits names the file
        // relative to the workspace, so there is no absolute path to report.
        params: JSON.stringify({ relativeWorkspacePath: 'lib/main.dart', noCodeblock: false }),
        result: JSON.stringify({ afterContentId: 'x' }),
      }),
    ]);

    expect(session?.transcript.events[0]).toMatchObject({
      tool: 'Write',
      input: { file_path: 'lib/main.dart' },
    });
  });

  it('names an MCP call from the server the record states, not by splitting its label', () => {
    const [session] = parseCursorStore([
      toolBubble(SESSION, 'b4', {
        // The label collapses server and tool with a `-`, and a server name may
        // itself contain `-` — the measured store holds
        // `project-0-smart-smm-flutter-supabase`. Splitting this string cannot
        // recover the pair, so it is never used for that.
        name: 'mcp-project-0-supabase-execute_sql',
        params: JSON.stringify({
          tools: [
            {
              name: 'execute_sql',
              serverName: 'project-0-supabase',
              parameters: JSON.stringify({ query: 'select 1' }),
            },
          ],
        }),
        result: JSON.stringify({ result: '{"rows":[]}' }),
      }),
    ]);

    expect(session?.transcript.events[0]).toMatchObject({
      tool: 'mcp__project-0-supabase__execute_sql',
      input: { query: 'select 1' },
    });
  });

  it('passes through a tool the live hook never sees rather than inventing a name for it', () => {
    const [session] = parseCursorStore([
      toolBubble(SESSION, 'b5', {
        name: 'glob_file_search',
        params: JSON.stringify({ globPattern: '**/*.dart', targetDirectory: '/w' }),
        result: JSON.stringify({ directories: ['/w/lib'] }),
      }),
    ]);

    expect(session?.transcript.events[0]?.tool).toBe('glob_file_search');
  });

  it('keeps a result it cannot recognise verbatim, so a scan still sees every character', () => {
    const [session] = parseCursorStore([
      toolBubble(SESSION, 'b6', {
        name: 'some_future_tool',
        params: JSON.stringify({ thing: 1 }),
        result: '{"unrecognised":"AKIAIOSFODNN7EXAMPLE"}',
      }),
    ]);

    const post = session?.transcript.events[1];
    expect(post?.kind === 'post' && post.resultText).toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('emits only the call when the tool never returned', () => {
    const [session] = parseCursorStore([
      toolBubble(SESSION, 'b7', {
        name: 'run_terminal_command_v2',
        status: 'cancelled',
        params: JSON.stringify({ command: 'sleep 1' }),
      }),
    ]);

    expect(session?.transcript.events.map((e) => e.kind)).toEqual(['pre']);
  });

  it('counts a row it cannot parse instead of dropping the session', () => {
    const [session] = parseCursorStore([
      { key: `bubbleId:${SESSION}:bad`, value: '{not json' },
      toolBubble(SESSION, 'b8', {
        name: 'run_terminal_command_v2',
        params: JSON.stringify({ command: 'ls' }),
      }),
    ]);

    expect(session?.transcript.skipped).toBe(1);
    expect(session?.transcript.events).toHaveLength(1);
  });

  it('groups bubbles by the session in their key and dates each by its newest', () => {
    const other = 'c0ffee00-0000-4000-8000-000000000002';
    const sessions = parseCursorStore([
      toolBubble(SESSION, 'a', { name: 'x' }, '2026-04-27T10:00:00.000Z'),
      toolBubble(SESSION, 'b', { name: 'y' }, '2026-04-27T12:00:00.000Z'),
      toolBubble(other, 'c', { name: 'z' }, '2026-04-28T09:00:00.000Z'),
    ]);

    expect(sessions.map((s) => s.id)).toEqual([other, SESSION]);
    expect(sessions[1]?.mtimeMs).toBe(Date.parse('2026-04-27T12:00:00.000Z'));
  });

  it('collects the absolute paths a session touched, which is the only link it has to a directory', () => {
    const [session] = parseCursorStore([
      toolBubble(SESSION, 'b9', {
        name: 'read_file_v2',
        params: JSON.stringify({ targetFile: '/w/app/main.ts' }),
      }),
      toolBubble(SESSION, 'b10', {
        name: 'edit_file_v2',
        params: JSON.stringify({ relativeWorkspacePath: 'lib/x.dart' }),
      }),
    ]);

    expect(session?.roots).toEqual(['/w/app/main.ts']);
  });

  it('ignores a bubble that is not a tool call', () => {
    const sessions = parseCursorStore([
      bubble(SESSION, 'text', { createdAt: '2026-04-27T10:00:00.000Z', text: 'hello' }),
    ]);

    expect(sessions[0]?.transcript.events).toEqual([]);
  });
});

describe('cursorSessionPath', () => {
  it('round-trips a store path and a session id', () => {
    const path = cursorSessionPath('/db/state.vscdb', SESSION);
    expect(splitCursorSessionPath(path)).toEqual({ db: '/db/state.vscdb', session: SESSION });
  });

  it('reads a bare store path as the store with no session chosen', () => {
    expect(splitCursorSessionPath('/db/state.vscdb')).toEqual({
      db: '/db/state.vscdb',
      session: null,
    });
  });
});
