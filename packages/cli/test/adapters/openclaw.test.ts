import { classifyTool, parseMcpToolName } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import {
  OPENCLAW_PHASES,
  OpenClawHookInputSchema,
  isOpenClawHighImpact,
  isOpenClawPhase,
  openclawToolName,
} from '../../src/adapters/openclaw.js';
import { OPENCLAW_MCP_SERVER, openclawToolKind } from '../../src/adapters/openclaw-input.js';

const cwd = '/home/dev/project';
const parsed = (fields: Record<string, unknown>) =>
  OpenClawHookInputSchema.parse({
    sessionId: 'openclaw-1',
    toolName: 'exec',
    cwd,
    ...fields,
  });

describe('the payload, and the phase that is not in it', () => {
  it('needs a session and a tool name, and nothing else', () => {
    expect(() => parsed({ sessionId: '' })).toThrow();
    expect(() => parsed({ toolName: 7 })).toThrow();
    expect(OpenClawHookInputSchema.parse({ sessionId: 's', toolName: 'exec' }).cwd).toBe('');
  });

  it('never rejects an event over a field it does not read', () => {
    // A shape surprise in a field Stroq ignores must not discard the whole event:
    // a discarded `post` is a scan that never runs and a taint that is never set.
    const input = parsed({
      agentId: { id: 7 },
      runId: null,
      toolCallId: 42,
      toolKind: ['weird'],
      requester: { channel: 'slack', senderIsOwner: true },
      durationMs: 'not a number',
      some_future_field: 'kept',
    });
    expect(input.sessionId).toBe('openclaw-1');
    expect(input['some_future_field']).toBe('kept');
  });

  it('takes the phase from the command line, because the event does not name itself', () => {
    expect(OPENCLAW_PHASES).toEqual(['pre', 'post']);
    expect(isOpenClawPhase('pre')).toBe(true);
    expect(isOpenClawPhase('post')).toBe(true);
    for (const bad of ['', 'before_tool_call', 'PRE', 'both'])
      expect(isOpenClawPhase(bad), bad).toBe(false);
  });
});

describe('openclawToolKind', () => {
  it.each([
    ['exec', 'shell'],
    // Undocumented aliases. A shell spelling that misses this set is named
    // `mcp__openclaw__<name>` and the shell rule set never runs on it.
    ['bash', 'shell'],
    ['sh', 'shell'],
    ['zsh', 'shell'],
    ['shell', 'shell'],
    ['exec_command', 'shell'],
    ['local_shell', 'shell'],
    ['run_command', 'shell'],
    ['apply_patch', 'patch'],
    ['write', 'write'],
    ['edit', 'write'],
    ['read', 'read'],
    ['web_fetch', 'fetch'],
    ['web_search', 'plain'],
    ['x_search', 'plain'],
    // Review ruling (Task 1 review): the pass-through set is exactly these four —
    // none of them leaves the session, returns external content, or mutates state.
    ['ask_user', 'plain'],
    ['progress_card', 'plain'],
    ['heartbeat_respond', 'plain'],
    ['get_goal', 'plain'],
    // Every side-effecting native tool, every tool that returns external content or
    // generated media, every tool-introspection call, and every name OpenClaw has
    // never documented, is an MCP call: that is what puts its arguments in front of
    // the secret-egress guard and its result in front of the `post` scan
    // (`SCANNED_TOOLS` matches `mcp__`). Self-mapping any of these instead would
    // exempt it from both: a `tts` call given a secret value would be silently
    // allowed, and a poisoned `tool_describe` result would never taint the session.
    ['view_image', 'mcp'],
    ['image_generate', 'mcp'],
    ['music_generate', 'mcp'],
    ['video_generate', 'mcp'],
    ['tts', 'mcp'],
    ['tool_search', 'mcp'],
    ['tool_search_code', 'mcp'],
    ['tool_describe', 'mcp'],
    ['create_goal', 'mcp'],
    ['update_goal', 'mcp'],
    ['message', 'mcp'],
    ['browser', 'mcp'],
    ['process', 'mcp'],
    ['terminal', 'mcp'],
    ['code_execution', 'mcp'],
    ['secrets', 'mcp'],
    ['screen', 'mcp'],
    ['gateway', 'mcp'],
    ['nodes', 'mcp'],
    ['cron', 'mcp'],
    ['sessions_list', 'mcp'],
    ['subagents', 'mcp'],
    ['agents_send', 'mcp'],
    ['mcp__github__add_issue_comment', 'mcp'],
    ['', 'mcp'],
  ])('%s is %s', (tool, kind) => expect(openclawToolKind(tool)).toBe(kind));

  it('normalises case and surrounding whitespace before classifying', () => {
    // A spelling that misses the shell set for nothing but casing or whitespace
    // becomes `mcp__openclaw__EXEC`, and the whole shell rule set never runs on it.
    for (const tool of ['EXEC', 'Exec', 'exec ', ' EXEC', 'BASH', 'Read', 'WRITE '])
      expect(openclawToolKind(tool), tool).not.toBe('mcp');
    expect(openclawToolKind('EXEC')).toBe('shell');
    expect(openclawToolKind('Exec')).toBe('shell');
    expect(openclawToolKind('exec ')).toBe('shell');
    expect(openclawToolKind('BASH')).toBe('shell');
    expect(openclawToolKind('Read')).toBe('read');
    expect(openclawToolKind('WRITE ')).toBe('write');
  });
});

describe('openclawToolName', () => {
  it('maps every documented native name onto the Stroq one the classifier knows', () => {
    for (const [tool, name] of [
      ['exec', 'Bash'],
      ['bash', 'Bash'],
      ['sh', 'Bash'],
      ['zsh', 'Bash'],
      ['shell', 'Bash'],
      ['exec_command', 'Bash'],
      ['local_shell', 'Bash'],
      ['run_command', 'Bash'],
      ['read', 'Read'],
      ['write', 'Write'],
      ['edit', 'Edit'],
      ['apply_patch', 'Write'],
      ['web_fetch', 'WebFetch'],
      ['web_search', 'WebSearch'],
      ['x_search', 'WebSearch'],
      // Passed through: they classify to nothing, and pretending otherwise would
      // put an MCP name on a tool that never leaves the session. Review ruling
      // (Task 1 review): exactly these four, and no others.
      ['ask_user', 'ask_user'],
      ['progress_card', 'progress_card'],
      ['heartbeat_respond', 'heartbeat_respond'],
      ['get_goal', 'get_goal'],
    ] as const)
      expect(openclawToolName(tool), tool).toBe(name);
  });

  it('treats every other name as an MCP call, since OpenClaw documents none', () => {
    expect(OPENCLAW_MCP_SERVER).toBe('openclaw');
    expect(openclawToolName('message')).toBe('mcp__openclaw__message');
    expect(openclawToolName('browser')).toBe('mcp__openclaw__browser');
    expect(openclawToolName('send mail')).toBe('mcp__openclaw__send_mail');
    expect(openclawToolName('')).toBe('mcp__openclaw__call');
    // Review ruling (Task 1 review): these ten used to be self-mapped, which
    // exempted each of them from the `post` scan, the secret-egress guard and the
    // fail-closed path all at once. Each now composes an MCP name instead.
    for (const tool of [
      'view_image',
      'image_generate',
      'music_generate',
      'video_generate',
      'tts',
      'tool_search',
      'tool_search_code',
      'tool_describe',
      'create_goal',
      'update_goal',
    ])
      expect(openclawToolName(tool), tool).toBe(`mcp__openclaw__${tool}`);
    // A name that already carries the prefix keeps its own server, re-sanitised the
    // way the Cursor, Codex and Copilot adapters do it (core splits on the LAST `__`).
    expect(openclawToolName('mcp__sentry__get_issue')).toBe('mcp__sentry__get_issue');
    expect(openclawToolName('mcp__git hub__add_issue_comment')).toBe(
      'mcp__git_hub__add_issue_comment',
    );
    expect(openclawToolName('mcp__srv__send__data')).toBe('mcp__srv__send_data');
    expect(openclawToolName('mcp__')).toBe('mcp__unknown__call');
  });

  it('still classifies the narrowed pass-through set to nothing', () => {
    for (const tool of ['ask_user', 'progress_card', 'heartbeat_respond', 'get_goal'])
      expect(classifyTool(openclawToolName(tool), { any: 'thing' }, cwd).classes, tool).toEqual([]);
  });

  it('normalises case and surrounding whitespace, but always emits a canonical name', () => {
    // The emitted Stroq tool name never reflects the raw casing: it always comes
    // from a fixed table (`KIND_NAMES`, `PLAIN_NAMES`'s values), never the raw string.
    for (const [tool, name] of [
      ['EXEC', 'Bash'],
      ['Exec', 'Bash'],
      ['exec ', 'Bash'],
      [' EXEC', 'Bash'],
      ['BASH', 'Bash'],
      ['Read', 'Read'],
      ['WRITE ', 'Write'],
      [' Edit', 'Edit'],
      ['Ask_User', 'ask_user'],
    ] as const)
      expect(openclawToolName(tool), tool).toBe(name);
  });

  it('keeps the side-effecting native tools classified as side effects', () => {
    // `message` sends to a chat channel; `code_execution` runs code. Both are
    // egress-shaped, and core reads that off the tool half of the MCP name.
    for (const tool of ['message', 'code_execution'])
      expect(classifyTool(openclawToolName(tool), { body: 'hi' }, cwd).classes, tool).toContain(
        'mcp.side_effect',
      );
    // `browser` is not side-effect-shaped by name, but it is still an MCP call, so
    // its arguments are read by the secret-egress guard all the same.
    expect(classifyTool(openclawToolName('browser'), { fill: 'x' }, cwd).classes).toEqual([
      'mcp.call',
    ]);
  });
});

/**
 * C1, replicated from the Cursor, Codex and Copilot adapters: a segment that
 * sanitises to a lone `_` would survive into `mcp__<server>___`, which core's
 * `parseMcpToolName` rejects — no `mcp.call`, so no secret-egress lookup, so a `.env`
 * value could leave through OpenClaw on a name the other adapters would have denied.
 * Whatever the raw name, the composed one must parse and classify as an MCP call.
 */
const HOSTILE: readonly { readonly label: string; readonly value: string }[] = [
  { label: 'a bare double underscore', value: '__' },
  { label: 'punctuation only', value: '!' },
  { label: 'an envelope symbol', value: '✉' },
  { label: 'CJK text', value: '发送' },
  { label: 'a slash', value: '/' },
  { label: 'an underscore-padded word', value: '_send_' },
  { label: 'an empty string', value: '' },
  { label: '10 000 underscores', value: '_'.repeat(10_000) },
];

describe('every composed MCP name stays parseable and classified (C1)', () => {
  it.each(HOSTILE)('$label', ({ value }) => {
    const names = [value, `mcp__${value}`, `mcp__${value}__${value}`, `mcp__server__${value}`];
    for (const raw of names) {
      const composed = openclawToolName(raw);
      expect(
        parseMcpToolName(composed),
        `${raw.slice(0, 40)} -> ${composed.slice(0, 40)}`,
      ).not.toBeNull();
      expect(classifyTool(composed, {}, cwd).classes, composed.slice(0, 40)).toContain('mcp.call');
    }
  });
});

describe('isOpenClawHighImpact', () => {
  it('covers every tool a deny could actually stop, unknown names included', () => {
    for (const tool of [
      'exec',
      'shell',
      'write',
      'edit',
      'apply_patch',
      'web_fetch',
      'message',
      'browser',
      'code_execution',
      'mcp__github__add_issue_comment',
      // These used to be self-mapped and low impact; the Task 1 review ruling moved
      // them onto the MCP path, so a Stroq failure on one of them now fails closed
      // like any other MCP call rather than silently allowing it through.
      'tts',
      'tool_describe',
      // An empty or missing name is unknown, i.e. an MCP call, i.e. high impact.
      '',
    ])
      expect(isOpenClawHighImpact(tool), tool).toBe(true);
    for (const tool of [
      'read',
      'web_search',
      'x_search',
      'ask_user',
      'progress_card',
      'heartbeat_respond',
      'get_goal',
    ])
      expect(isOpenClawHighImpact(tool), tool).toBe(false);
  });

  it('normalises case before the lookup, like every other kind check', () => {
    expect(isOpenClawHighImpact('READ')).toBe(false);
    expect(isOpenClawHighImpact(' Ask_User ')).toBe(false);
    expect(isOpenClawHighImpact('EXEC')).toBe(true);
  });
});
