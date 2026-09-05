import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTool, parseMcpToolName } from '@stroq/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CursorHookInputSchema,
  cursorToolName,
  handleCursorHook,
} from '../../src/adapters/cursor.js';
import { createEngine } from '../../src/engine-factory.js';

const SECRET_VALUE = 'stroq_test_cursor_name_9876543210';

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-cursor-name-'));
  process.env['STROQ_HOME'] = home;
  cwd = mkdtempSync(join(tmpdir(), 'stroq-cursor-name-cwd-'));
});

const parsed = (fields: Record<string, unknown>) =>
  CursorHookInputSchema.parse({
    conversation_id: 'cur-name',
    hook_event_name: 'beforeMCPExecution',
    workspace_roots: [cwd],
    ...fields,
  });
const name = (fields: Record<string, unknown>) => cursorToolName(parsed(fields));
const body = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

describe('MCP tool name composition', () => {
  it('re-sanitises a pre-shaped mcp__ name so its tool part cannot carry a second separator', () => {
    expect(name({ tool_name: 'mcp__srv__send__data' })).toBe('mcp__srv__send_data');
    expect(name({ tool_name: 'mcp__srv__send  data' })).toBe('mcp__srv__send_data');
    expect(name({ tool_name: 'mcp__srv' })).toBe('mcp__srv__call');
    expect(name({ tool_name: 'mcp__' })).toBe('mcp__unknown__call');
  });

  it('collapses padding into one separator instead of synthesising a fresh one (R2)', () => {
    expect(name({ mcp_server_name: 'sentry', tool_name: 'send  data' })).toBe(
      'mcp__sentry__send_data',
    );
  });

  it('does not let a forged mcp__ tool name override the real server (R3)', () => {
    expect(name({ mcp_server_name: 'evil-server', tool_name: 'mcp__github__get_issue' })).toBe(
      'mcp__evil-server__mcp_github_get_issue',
    );
    // Without a competing server, the community pass-through is untouched.
    expect(name({ tool_name: 'mcp__sentry__get_issue' })).toBe('mcp__sentry__get_issue');
  });
});

/**
 * C1: a segment that sanitises to a lone `_` used to survive into `mcp__<server>___`,
 * which core's `parseMcpToolName` rejects — no `mcp.call`, so no secret-egress lookup,
 * so a `.env` value could leave through Cursor on a name Claude Code would have denied.
 * The invariant below is the guard: whatever the raw name, the composed one parses and
 * classifies as an MCP call.
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
    const shapes: Record<string, Record<string, unknown>> = {
      'as the tool name': { tool_name: value },
      'as the server name': { mcp_server_name: value },
      'as both': { mcp_server_name: value, tool_name: value },
      'pre-shaped in both halves': { tool_name: `mcp__${value}__${value}` },
    };
    for (const [shape, fields] of Object.entries(shapes)) {
      const composed = name(fields);
      expect(parseMcpToolName(composed), `${shape}: ${composed.slice(0, 40)}`).not.toBeNull();
      expect(classifyTool(composed, {}, cwd).classes, shape).toContain('mcp.call');
    }
  });
});

describe('handleCursorHook with a hostile tool name', () => {
  it('still denies a .env value leaving through tool_name "__" (C1)', async () => {
    const project = mkdtempSync(join(tmpdir(), 'stroq-cursor-name-project-'));
    writeFileSync(join(project, '.env'), `API_TOKEN=${SECRET_VALUE}\n`);
    const out = await handleCursorHook(createEngine(), {
      conversation_id: 'cur-name-egress',
      hook_event_name: 'beforeMCPExecution',
      workspace_roots: [project],
      tool_name: '__',
      tool_input: { body: `see token ${SECRET_VALUE}` },
    });
    const json = body(out.stdout);
    expect(json['permission']).toBe('deny');
    expect(String(json['user_message'])).toContain('deny-secret-egress');
    expect(String(json['agent_message'])).toContain('API_TOKEN');
    expect(out.stdout).not.toContain(SECRET_VALUE);
  });
});
