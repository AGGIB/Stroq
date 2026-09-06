import { classifyTool, parseMcpToolName } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import {
  COPILOT_PHASES,
  CopilotHookInputSchema,
  copilotAskOutput,
  copilotBadPhaseOutput,
  copilotBlockOutput,
  copilotDenyOutput,
  copilotResultText,
  copilotToolInput,
  copilotToolName,
  isCopilotHighImpact,
  isCopilotPhase,
  renderDecision,
} from '../../src/adapters/copilot.js';
import { COPILOT_MCP_SERVER, copilotToolKind } from '../../src/adapters/copilot-input.js';

const cwd = '/home/dev/project';
const parsed = (fields: Record<string, unknown>) =>
  CopilotHookInputSchema.parse({
    sessionId: 'copilot-1',
    toolName: 'bash',
    cwd,
    timestamp: 1_757_000_000_000,
    ...fields,
  });
const call = (toolName: string, toolArgs?: unknown) => copilotToolInput({ toolName, toolArgs });
const body = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

const PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new.ts',
  '+export const a = 1;',
  '*** Delete File: .github/hooks/stroq.json',
  '*** End Patch',
].join('\n');

describe('the payload, and the phase that is not in it', () => {
  it('needs a session and a tool name, and nothing else', () => {
    expect(() => parsed({ sessionId: '' })).toThrow();
    expect(() => parsed({ toolName: 7 })).toThrow();
    expect(CopilotHookInputSchema.parse({ sessionId: 's', toolName: 'bash' }).cwd).toBe('');
  });

  it('never rejects an event over a field it does not read', () => {
    // A shape surprise in a field Stroq ignores must not discard the whole event:
    // a discarded `post` is a scan that never runs and a taint that is never set.
    const input = parsed({
      timestamp: 'not a number',
      traceparent: { v: 1 },
      tracestate: null,
      some_future_field: 'kept',
    });
    expect(input.sessionId).toBe('copilot-1');
    expect(input['some_future_field']).toBe('kept');
  });

  it('takes the phase from the command line, because the event does not name itself', () => {
    expect(COPILOT_PHASES).toEqual(['pre', 'post']);
    expect(isCopilotPhase('pre')).toBe(true);
    expect(isCopilotPhase('post')).toBe(true);
    for (const bad of ['', 'preToolUse', 'PRE', 'both'])
      expect(isCopilotPhase(bad), bad).toBe(false);
  });
});

describe('copilotToolKind', () => {
  it.each([
    ['bash', undefined, 'shell'],
    ['powershell', undefined, 'shell'],
    ['apply_patch', undefined, 'patch'],
    ['create', undefined, 'write'],
    ['edit', undefined, 'write'],
    ['view', undefined, 'read'],
    ['str_replace_editor', { command: 'view' }, 'read'],
    ['str_replace_editor', { command: 'str_replace' }, 'write'],
    ['str_replace_editor', { command: 'undo_edit' }, 'write'],
    // No `command` at all is an edit, not a view: the safe direction.
    ['str_replace_editor', {}, 'write'],
    ['str_replace_editor', '{"command":"view"}', 'read'],
    ['web_fetch', undefined, 'fetch'],
    ['web_search', undefined, 'plain'],
    ['grep', undefined, 'plain'],
    ['rg', undefined, 'plain'],
    ['glob', undefined, 'plain'],
    ['ask_user', undefined, 'plain'],
    ['task', undefined, 'plain'],
    ['mcp__github__add_issue_comment', undefined, 'mcp'],
    ['add_issue_comment', undefined, 'mcp'],
    ['', undefined, 'mcp'],
  ])('%s is %s', (tool, args, kind) => expect(copilotToolKind(tool, args)).toBe(kind));
});

describe('copilotToolName', () => {
  it('maps every documented native name onto the Stroq one the classifier knows', () => {
    for (const [tool, name] of [
      ['bash', 'Bash'],
      ['powershell', 'Bash'],
      ['view', 'Read'],
      ['create', 'Write'],
      ['edit', 'Edit'],
      ['apply_patch', 'Write'],
      ['web_fetch', 'WebFetch'],
      ['web_search', 'WebSearch'],
      ['grep', 'Grep'],
      ['rg', 'Grep'],
      ['glob', 'Glob'],
      // Passed through: they classify to nothing, and pretending otherwise would
      // put an MCP name on a tool that never leaves the session.
      ['ask_user', 'ask_user'],
      ['task', 'task'],
    ] as const)
      expect(copilotToolName(tool), tool).toBe(name);
  });

  it("reads str_replace_editor's sub-command, which is not a shell command", () => {
    expect(copilotToolName('str_replace_editor', { command: 'view', path: 'a.ts' })).toBe('Read');
    for (const command of ['create', 'str_replace', 'insert', 'undo_edit'])
      expect(copilotToolName('str_replace_editor', { command }), command).toBe('Edit');
    expect(copilotToolName('str_replace_editor', '{"command":"view"}')).toBe('Read');
  });

  it('treats every other name as an MCP call, since hooks never report a server', () => {
    expect(COPILOT_MCP_SERVER).toBe('copilot');
    expect(copilotToolName('add_issue_comment')).toBe('mcp__copilot__add_issue_comment');
    expect(copilotToolName('send mail')).toBe('mcp__copilot__send_mail');
    expect(copilotToolName('')).toBe('mcp__copilot__call');
    // A name that already carries the prefix keeps its own server, re-sanitised the
    // way the Cursor and Codex adapters do it (core splits on the LAST `__`).
    expect(copilotToolName('mcp__sentry__get_issue')).toBe('mcp__sentry__get_issue');
    expect(copilotToolName('mcp__git hub__add_issue_comment')).toBe(
      'mcp__git_hub__add_issue_comment',
    );
    expect(copilotToolName('mcp__srv__send__data')).toBe('mcp__srv__send_data');
    expect(copilotToolName('mcp__')).toBe('mcp__unknown__call');
  });
});

/**
 * C1, replicated from the Cursor and Codex adapters: a segment that sanitises to a
 * lone `_` would survive into `mcp__<server>___`, which core's `parseMcpToolName`
 * rejects — no `mcp.call`, so no secret-egress lookup, so a `.env` value could leave
 * through Copilot on a name the other adapters would have denied. Whatever the raw
 * name, the composed one must parse and classify as an MCP call.
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
      const composed = copilotToolName(raw);
      expect(
        parseMcpToolName(composed),
        `${raw.slice(0, 40)} -> ${composed.slice(0, 40)}`,
      ).not.toBeNull();
      expect(classifyTool(composed, {}, cwd).classes, composed.slice(0, 40)).toContain('mcp.call');
    }
  });
});

describe('isCopilotHighImpact', () => {
  it('covers every tool a deny could actually stop, unknown names included', () => {
    for (const tool of [
      'bash',
      'powershell',
      'create',
      'edit',
      'str_replace_editor',
      'apply_patch',
      'web_fetch',
      'add_issue_comment',
      'mcp__github__add_issue_comment',
      // An empty or missing name is unknown, i.e. an MCP call, i.e. high impact.
      '',
    ])
      expect(isCopilotHighImpact(tool), tool).toBe(true);
    for (const tool of ['view', 'grep', 'rg', 'glob', 'web_search', 'ask_user', 'task'])
      expect(isCopilotHighImpact(tool), tool).toBe(false);
  });
});

describe('copilotToolInput', () => {
  it('normalises the shell input, whatever shape it arrived in', () => {
    expect(call('bash', { command: 'ls -la', description: 'list' })).toEqual({ command: 'ls -la' });
    expect(call('powershell', { command: 'Get-ChildItem' })).toEqual({ command: 'Get-ChildItem' });
    expect(call('bash', '{"command":"ls -la"}')).toEqual({ command: 'ls -la' });
    expect(call('bash', 'ls -la')).toEqual({ command: 'ls -la' });
    // `<shell> -c` argv classifies the script alone; any other argv is POSIX-quoted,
    // so an argument is never re-read as a command of its own (Codex's rules, reused).
    expect(call('bash', { command: ['bash', '-lc', 'ls'] })).toEqual({ command: 'ls' });
    expect(call('bash', { command: ['git', 'commit', '-m', 'rm -rf /'] })).toEqual({
      command: "git commit -m 'rm -rf /'",
    });
    expect(call('bash')).toEqual({ command: '' });
  });

  it('renames Copilot’s `path` to the `file_path` every rule reads', () => {
    expect(call('create', { path: 'src/new.ts', content: 'x' })).toEqual({
      content: 'x',
      file_path: 'src/new.ts',
    });
    expect(call('edit', { path: 'src/old.ts', old_str: 'a', new_str: 'b' })).toEqual({
      old_str: 'a',
      new_str: 'b',
      file_path: 'src/old.ts',
    });
    expect(call('view', { path: '.env' })).toEqual({ file_path: '.env' });
    // An agent that already spells it `file_path`, and a bare string, both work.
    expect(call('create', { file_path: 'src/a.ts' })).toEqual({ file_path: 'src/a.ts' });
    expect(call('create', 'src/a.ts')).toEqual({ raw: 'src/a.ts', file_path: 'src/a.ts' });
    expect(call('create', {})).toEqual({ file_path: '' });
  });

  it("drops str_replace_editor's sub-command from the record it hands the engine", () => {
    // `summarizeInput` prefers a key called `command`, so leaving it in would label
    // every editor call `str_replace` in `stroq log` instead of naming the file — and
    // it is not a shell command, so no classifier should ever read it as one.
    expect(
      call('str_replace_editor', { command: 'str_replace', path: 'a.ts', old_str: 'x' }),
    ).toEqual({ file_path: 'a.ts', old_str: 'x' });
    expect(call('str_replace_editor', { command: 'view', path: 'a.ts' })).toEqual({
      file_path: 'a.ts',
    });
  });

  it('exposes the first patched path plus the whole list', () => {
    expect(call('apply_patch', { input: PATCH })).toEqual({
      file_path: 'src/new.ts',
      file_paths: ['src/new.ts', '.github/hooks/stroq.json'],
    });
    for (const key of ['command', 'patch'])
      expect(call('apply_patch', { [key]: PATCH })['file_path'], key).toBe('src/new.ts');
    expect(call('apply_patch', { command: 'no headers' })).toEqual({
      file_path: '',
      file_paths: [],
    });
  });

  it('guarantees web_fetch a string url without losing its other arguments', () => {
    // `network.fetch` is an egress class, so the whole record is scanned for secret
    // values; dropping fields here would be a value that can never be caught leaving.
    expect(call('web_fetch', { url: 'https://x.example/a', prompt: 'summarise' })).toEqual({
      url: 'https://x.example/a',
      prompt: 'summarise',
    });
    expect(call('web_fetch', { url: 7 })).toEqual({ url: '' });
  });

  it('keeps MCP and pass-through arguments visible to the secret guard', () => {
    expect(call('add_issue_comment', { body: 'hi' })).toEqual({ body: 'hi' });
    expect(call('add_issue_comment', '{"body":"hi"}')).toEqual({ body: 'hi' });
    expect(call('add_issue_comment', 'TOKEN=abcdefghijkl')).toEqual({ raw: 'TOKEN=abcdefghijkl' });
    expect(call('add_issue_comment', ['a', 'b'])).toEqual({ raw: '["a","b"]' });
    expect(call('add_issue_comment', 7)).toEqual({ raw: '7' });
    expect(call('add_issue_comment')).toEqual({});
    expect(call('web_search', { query: 'stroq' })).toEqual({ query: 'stroq' });
    expect(call('grep', { pattern: 'TODO', path: 'src' })).toEqual({
      pattern: 'TODO',
      path: 'src',
    });
  });
});

describe('copilotResultText', () => {
  it('prefers textResultForLlm, then output, then stdout+stderr, then the generic reader', () => {
    expect(copilotResultText({ resultType: 'success', textResultForLlm: 'official' })).toBe(
      'official',
    );
    // An empty official field must not shadow a stream that carries the real result.
    expect(copilotResultText({ textResultForLlm: '', stdout: 'o', stderr: 'e' })).toBe('o\ne');
    expect(copilotResultText({ output: 'legacy' })).toBe('legacy');
    expect(copilotResultText('plain string')).toBe('plain string');
    expect(copilotResultText({ text: 'content block' })).toBe('content block');
    expect(copilotResultText(undefined)).toBe('');
    expect(copilotResultText(null)).toBe('');
  });
});

describe('renderDecision', () => {
  const secrets = [{ name: 'DB_PASSWORD', source: '.env', canary: false }];

  it('prints nothing for an allow', () => {
    expect(renderDecision({ effect: 'allow', ruleId: null, reason: 'ok' }, [], [])).toEqual({
      stdout: '',
      exitCode: 0,
    });
  });

  it('denies at the top level, with no hookSpecificOutput envelope', () => {
    const out = renderDecision(
      {
        effect: 'deny',
        ruleId: 'deny-secret-egress',
        reason: 'Arguments contain the value of a known secret; outbound use is blocked',
      },
      [],
      secrets,
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBeUndefined();
    // Copilot ignores Claude's envelope for a decision; wrapping it would fail open.
    expect(out.stdout).not.toContain('hookSpecificOutput');
    const fields = body(out.stdout);
    expect(fields['permissionDecision']).toBe('deny');
    expect(String(fields['permissionDecisionReason'])).toMatch(
      /^Stroq blocked this action \(deny-secret-egress\): Arguments contain the value of a known secret; outbound use is blocked Evidence: /,
    );
    expect(String(fields['permissionDecisionReason'])).toContain('DB_PASSWORD');
    expect(String(fields['permissionDecisionReason'])).toContain('.env');
  });

  it('asks for real, because Copilot can prompt', () => {
    const out = renderDecision(
      {
        effect: 'ask',
        ruleId: 'ask-destructive',
        reason: 'Destructive command requires confirmation',
      },
      [],
      [],
    );
    expect(body(out.stdout)).toEqual({
      permissionDecision: 'ask',
      permissionDecisionReason:
        'Stroq asks before this action (ask-destructive): Destructive command requires confirmation',
    });
  });

  it('separates the JSON decisions from the exit-2 block and the bad-phase block', () => {
    expect(copilotDenyOutput('nope')).toEqual({
      stdout: '{"permissionDecision":"deny","permissionDecisionReason":"nope"}',
      exitCode: 0,
    });
    expect(copilotAskOutput('maybe')).toEqual({
      stdout: '{"permissionDecision":"ask","permissionDecisionReason":"maybe"}',
      exitCode: 0,
    });
    expect(copilotBlockOutput('boom')).toEqual({ stdout: '', stderr: 'boom', exitCode: 2 });
    const badPhase = copilotBadPhaseOutput('preToolUse');
    expect(badPhase.exitCode).toBe(2);
    expect(badPhase.stdout).toBe('');
    expect(String(badPhase.stderr)).toContain('needs a phase argument');
    expect(String(badPhase.stderr)).toContain('preToolUse');
  });
});
