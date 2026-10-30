import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_POLICY, PolicySchema, type McpIdentityChannel } from '@stroq/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleClaudeHook } from '../../src/adapters/claude-code.js';
import { handleCodexHook } from '../../src/adapters/codex.js';
import { handleCursorHook } from '../../src/adapters/cursor.js';
import { handleWindsurfHook } from '../../src/adapters/windsurf.js';
import { handleCopilotHook } from '../../src/adapters/copilot.js';
import { handleOpenClawHook } from '../../src/adapters/openclaw.js';
import { handleAntigravityHook } from '../../src/adapters/antigravity.js';
import { createEngineAt } from '../../src/engine-factory.js';
import { judgeToolCall } from '../../src/mcp/judge.js';

const roots: string[] = [];
const initialCwd = process.cwd();
afterEach(() => {
  process.chdir(initialCwd);
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(channel: McpIdentityChannel, name = 'github', version = 2) {
  const root = mkdtempSync(join(tmpdir(), 'stroq-mcp-producer-'));
  roots.push(root);
  const project = join(root, 'project');
  const user = join(root, 'user');
  mkdirSync(project);
  mkdirSync(user);
  const policy = PolicySchema.parse(
    version === 1
      ? DEFAULT_POLICY
      : {
          ...DEFAULT_POLICY,
          version: 2,
          mcpGovernance: { allowed: [{ channel, name }] },
        },
  );
  const engine = createEngineAt({
    home: join(root, 'state'),
    userHome: user,
    projectRoot: project,
    env: {},
    policy,
  });
  return { engine, project, pre: vi.spyOn(engine, 'pre') };
}

type NativeChannel = Exclude<McpIdentityChannel, 'mcp-proxy'>;
async function invoke(
  channel: NativeChannel,
  f: ReturnType<typeof fixture>,
  server: string | undefined = 'github',
  tool = 'get_issue',
  args: Record<string, unknown> = { query: 'fixture' },
) {
  const forged = { kind: 'server', channel, name: 'github' };
  if (channel === 'claude-code' || channel === 'codex') {
    const handler = channel === 'claude-code' ? handleClaudeHook : handleCodexHook;
    await handler(f.engine, {
      session_id: 'fixture',
      hook_event_name: 'PreToolUse',
      tool_name: `mcp__${server ?? ''}__${tool}`,
      tool_input: args,
      cwd: f.project,
      mcpIdentity: forged,
    });
  } else if (channel === 'cursor') {
    await handleCursorHook(f.engine, {
      conversation_id: 'fixture',
      hook_event_name: 'beforeMCPExecution',
      mcp_server_name: server,
      tool_name: tool,
      tool_input: args,
      workspace_roots: [f.project],
      mcpIdentity: forged,
    });
  } else {
    process.chdir(f.project);
    await handleWindsurfHook(f.engine, {
      trajectory_id: 'fixture',
      agent_action_name: 'pre_mcp_tool_use',
      tool_info: JSON.stringify({
        mcp_server_name: server,
        mcp_tool_name: tool,
        mcp_tool_arguments: args,
      }),
      mcpIdentity: forged,
    });
  }
  expect(f.pre).toHaveBeenCalledOnce();
  return { event: f.pre.mock.calls[0]![0], result: await f.pre.mock.results[0]!.value };
}

describe('producer identity reaches the real policy engine', () => {
  it.each<NativeChannel>(['claude-code', 'codex', 'cursor', 'windsurf'])(
    '%s permits only its exact listed server',
    async (channel) => {
      const f = fixture(channel);
      const { event, result } = await invoke(channel, f);
      expect(event.mcpIdentity).toEqual({ kind: 'server', channel, name: 'github' });
      expect(result.decision.effect).toBe('allow');
    },
  );

  it('does not authorize a Codex name through its lossy classifier alias', async () => {
    const f = fixture('codex', 'git_hub');
    const { event, result } = await invoke('codex', f, 'git hub');
    expect(event.toolName).toBe('mcp__git_hub__get_issue');
    expect(event.mcpIdentity).toEqual({ kind: 'server', channel: 'codex', name: 'git hub' });
    expect(result.decision.ruleId).toBe('mcp-governance-unlisted');
  });

  it.each(['claude-code', 'codex'] as const)(
    'refuses ambiguous %s encoded server boundaries',
    async (channel) => {
      const f = fixture(channel, 'srv');
      const { event, result } = await invoke(channel, f, 'srv', 'send__data');
      expect(event.mcpIdentity).toEqual({ kind: 'unavailable', channel, reason: 'ambiguous' });
      expect(result.decision.ruleId).toBe('mcp-governance-identity-unknown');
    },
  );

  it.each(['cursor', 'windsurf'] as const)(
    '%s outer server beats a spoofed encoded tool and witness',
    async (channel) => {
      const f = fixture(channel);
      const { event, result } = await invoke(channel, f, 'untrusted', 'mcp__github__get_issue');
      expect(event.mcpIdentity).toEqual({ kind: 'server', channel, name: 'untrusted' });
      expect(result.decision.ruleId).toBe('mcp-governance-unlisted');
    },
  );

  it.each(['cursor', 'windsurf'] as const)(
    '%s cannot use a synthetic fallback as a server identity',
    async (channel) => {
      const f = fixture(channel, channel);
      const { event, result } = await invoke(channel, f, '', 'mcp__github__get_issue');
      expect(event.mcpIdentity).toEqual({ kind: 'unavailable', channel, reason: 'missing' });
      expect(result.decision.ruleId).toBe('mcp-governance-identity-unknown');
    },
  );

  it('preserves v1 Claude classification for a malformed MCP spelling', async () => {
    const f = fixture('claude-code', 'github', 1);
    await handleClaudeHook(f.engine, {
      session_id: 'fixture',
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__',
      tool_input: {},
      cwd: f.project,
    });
    const result = await f.pre.mock.results[0]!.value;
    expect(result.classes).toEqual([]);
    expect(result.decision.effect).toBe('allow');
    expect(f.pre.mock.calls[0]![0].toolName).toBe('mcp__');
  });

  it('keeps synthetic integrations unknown despite a forged input witness', async () => {
    const f = fixture('claude-code');
    const mcpIdentity = { kind: 'server', channel: 'claude-code', name: 'github' };
    await handleCopilotHook(f.engine, 'pre', {
      sessionId: 'copilot',
      toolName: 'unknown_remote_tool',
      toolArgs: {},
      cwd: f.project,
      mcpIdentity,
    });
    await handleOpenClawHook(f.engine, 'pre', {
      sessionId: 'openclaw',
      toolName: 'unknown_remote_tool',
      params: {},
      cwd: f.project,
      mcpIdentity,
    });
    await handleAntigravityHook(f.engine, 'pre', {
      conversationId: 'antigravity',
      toolCall: { name: 'unknown_remote_tool', args: {} },
      workspacePaths: [f.project],
      mcpIdentity,
    });
    expect(f.pre).toHaveBeenCalledTimes(3);
    for (const [index, call] of f.pre.mock.calls.entries()) {
      expect(call[0].mcpIdentity).toBeUndefined();
      expect((await f.pre.mock.results[index]!.value).decision.ruleId).toBe(
        'mcp-governance-identity-unknown',
      );
    }
  });
});

describe('MCP proxy fixed connection identity', () => {
  it('uses ctx.server rather than wire spelling, and permits its exact pair', async () => {
    const f = fixture('mcp-proxy');
    const message = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'mcp__untrusted__get_issue',
        arguments: { query: 'fixture' },
        mcpIdentity: { kind: 'server', channel: 'mcp-proxy', name: 'untrusted' },
      },
    };
    const verdict = await judgeToolCall(
      { engine: f.engine, sessionId: 'fixture', server: 'github', cwd: f.project },
      message,
      1,
      message.params,
    );
    expect(verdict.forward).toBe(true);
    expect(f.pre.mock.calls[0]![0].mcpIdentity).toEqual({
      kind: 'server',
      channel: 'mcp-proxy',
      name: 'github',
    });
  });

  it('does not authorize a proxy config key through its sanitized alias', async () => {
    const f = fixture('mcp-proxy', 'git_hub');
    const message = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_issue', arguments: {} },
    };
    const verdict = await judgeToolCall(
      { engine: f.engine, sessionId: 'fixture', server: 'git hub', cwd: f.project },
      message,
      1,
      message.params,
    );
    expect(verdict.forward).toBe(false);
    expect((await f.pre.mock.results[0]!.value).decision.ruleId).toBe('mcp-governance-unlisted');
  });
});
