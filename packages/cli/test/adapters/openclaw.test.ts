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
    ['ask_user', 'plain'],
    ['view_image', 'plain'],
    ['image_generate', 'plain'],
    ['music_generate', 'plain'],
    ['video_generate', 'plain'],
    ['tts', 'plain'],
    ['tool_search', 'plain'],
    ['tool_search_code', 'plain'],
    ['tool_describe', 'plain'],
    ['progress_card', 'plain'],
    ['heartbeat_respond', 'plain'],
    ['get_goal', 'plain'],
    ['create_goal', 'plain'],
    ['update_goal', 'plain'],
    // Every side-effecting native tool, and every name OpenClaw has never
    // documented, is an MCP call: that is what puts its arguments in front of the
    // secret-egress guard.
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
      // put an MCP name on a tool that never leaves the session.
      ['ask_user', 'ask_user'],
      ['view_image', 'view_image'],
      ['tts', 'tts'],
      ['tool_describe', 'tool_describe'],
      ['create_goal', 'create_goal'],
    ] as const)
      expect(openclawToolName(tool), tool).toBe(name);
  });

  it('treats every other name as an MCP call, since OpenClaw documents none', () => {
    expect(OPENCLAW_MCP_SERVER).toBe('openclaw');
    expect(openclawToolName('message')).toBe('mcp__openclaw__message');
    expect(openclawToolName('browser')).toBe('mcp__openclaw__browser');
    expect(openclawToolName('send mail')).toBe('mcp__openclaw__send_mail');
    expect(openclawToolName('')).toBe('mcp__openclaw__call');
    // A name that already carries the prefix keeps its own server, re-sanitised the
    // way the Cursor, Codex and Copilot adapters do it (core splits on the LAST `__`).
    expect(openclawToolName('mcp__sentry__get_issue')).toBe('mcp__sentry__get_issue');
    expect(openclawToolName('mcp__git hub__add_issue_comment')).toBe(
      'mcp__git_hub__add_issue_comment',
    );
    expect(openclawToolName('mcp__srv__send__data')).toBe('mcp__srv__send_data');
    expect(openclawToolName('mcp__')).toBe('mcp__unknown__call');
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
      // An empty or missing name is unknown, i.e. an MCP call, i.e. high impact.
      '',
    ])
      expect(isOpenClawHighImpact(tool), tool).toBe(true);
    for (const tool of ['read', 'web_search', 'x_search', 'ask_user', 'tts', 'tool_describe'])
      expect(isOpenClawHighImpact(tool), tool).toBe(false);
  });
});
