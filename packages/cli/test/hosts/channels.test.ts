import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../../src/attack/scenarios/index.js';
import {
  CHANNELS,
  HOST_CHANNELS,
  HOST_IDS,
  channelForStep,
  formatHostsMarkdown,
  isStepSupportedOnHost,
  supportFor,
} from '../../src/hosts/channels.js';

describe('host channels visibility table', () => {
  it('defines the complete 8 hosts and 6 channels', () => {
    expect(HOST_IDS).toHaveLength(8);
    expect(CHANNELS).toEqual([
      'shell command',
      'file write',
      'file read',
      'MCP call',
      'tool result',
      'web fetch',
    ]);
    for (const host of HOST_IDS) {
      expect(HOST_CHANNELS[host]).toBeDefined();
      for (const channel of CHANNELS) {
        const support = HOST_CHANNELS[host][channel];
        expect(support).toBeDefined();
        expect(['seen', 'not seen', 'partial', 'unknown']).toContain(support.status);
        expect(support.evidence.length).toBeGreaterThan(0);
        expect(support.evidence).toMatch(/docs\/AGENTS\.md/);
      }
    }
  });

  it('cross-validates bidirectionally against docs/AGENTS.md host summary table', () => {
    const agentsDocPath = resolve(import.meta.dirname, '../../../../docs/AGENTS.md');
    const content = readFileSync(agentsDocPath, 'utf8');

    // Extract table rows specifically from the summary table before per-host sections
    const summaryTable = content.split('### Cursor')[0] ?? '';
    const agentIdMatches = [...summaryTable.matchAll(/\|\s*`([a-z0-9_-]+)`\s*\|/g)].map(
      (m) => m[1],
    );
    const uniqueAgentIds = [...new Set(agentIdMatches)];

    for (const hostId of HOST_IDS) {
      expect(
        uniqueAgentIds,
        `Expected HOST_ID ${hostId} to be documented in docs/AGENTS.md`,
      ).toContain(hostId);
    }

    for (const agentId of uniqueAgentIds) {
      expect(
        HOST_IDS as readonly string[],
        `Expected agent ID ${agentId} from docs/AGENTS.md to be defined in HOST_IDS`,
      ).toContain(agentId);
    }
  });

  describe('channelForStep', () => {
    it('maps all 36 attack scenario steps to recognised channels', () => {
      expect(SCENARIOS).toHaveLength(36);
      for (const scenario of SCENARIOS) {
        for (const step of scenario.steps) {
          const channel = channelForStep(step.event);
          expect(CHANNELS).toContain(channel);
        }
      }
    });

    it('classifies hook events into the proper channels', () => {
      expect(
        channelForStep({
          session_id: 'test',
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: {},
          tool_result: 'ok',
        }),
      ).toBe('tool result');

      expect(
        channelForStep({
          session_id: 'test',
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        }),
      ).toBe('shell command');

      expect(
        channelForStep({
          session_id: 'test',
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path: 'foo.txt' },
        }),
      ).toBe('file write');

      expect(
        channelForStep({
          session_id: 'test',
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: 'foo.txt' },
        }),
      ).toBe('file read');

      expect(
        channelForStep({
          session_id: 'test',
          hook_event_name: 'PreToolUse',
          tool_name: 'WebFetch',
          tool_input: { url: 'https://example.com' },
        }),
      ).toBe('web fetch');

      expect(
        channelForStep({
          session_id: 'test',
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__server__tool',
          tool_input: {},
        }),
      ).toBe('MCP call');
    });
  });

  describe('isStepSupportedOnHost', () => {
    it.each([
      ['codex', 'Read', false],
      ['codex', 'WebFetch', false],
      ['codex', 'Bash', true],
      ['codex', 'mcp__server__tool', true],
      ['cursor', 'WebFetch', false],
      ['cursor', 'Read', true],
      ['cursor', 'Write', false],
      ['windsurf', 'Bash', false],
      ['windsurf', 'Read', true],
      ['windsurf', 'mcp__server__tool', true],
      ['antigravity', 'Bash', false],
      ['antigravity', 'WebFetch', false],
      ['antigravity', 'mcp__server__tool', false],
      ['antigravity', 'Read', true],
      ['mcp', 'Bash', false],
      ['mcp', 'Read', false],
      ['mcp', 'WebFetch', false],
      ['mcp', 'mcp__server__tool', true],
    ])('checks the origin of %s post results from %s', (host, tool, supported) => {
      const result = isStepSupportedOnHost(host, {
        session_id: 'test',
        hook_event_name: 'PostToolUse',
        tool_name: tool,
        tool_input: {},
        tool_result: 'untrusted output',
      });
      expect(result?.channel).toBe('tool result');
      expect(result?.supported).toBe(supported);
    });

    it('does not assume Cursor matches Edit or an unknown native tool is MCP traffic', () => {
      const event = {
        session_id: 'test',
        hook_event_name: 'PreToolUse' as const,
        tool_name: 'Edit',
        tool_input: { file_path: 'foo.txt' },
      };
      expect(isStepSupportedOnHost('cursor', event)?.supported).toBe(false);
      expect(
        isStepSupportedOnHost('mcp', { ...event, tool_name: 'native_unknown' })?.supported,
      ).toBe(false);
    });

    it('supports all steps on claude-code', () => {
      for (const scenario of SCENARIOS) {
        for (const step of scenario.steps) {
          const support = isStepSupportedOnHost('claude-code', step.event);
          expect(support).not.toBeNull();
          expect(support?.supported).toBe(true);
          expect(support?.status).toBe('seen');
        }
      }
    });

    it('flags not seen channels on constrained hosts', () => {
      const readEvent = {
        session_id: 'test',
        hook_event_name: 'PreToolUse' as const,
        tool_name: 'Read',
        tool_input: { file_path: 'secret.txt' },
      };
      const codexSupport = isStepSupportedOnHost('codex', readEvent);
      expect(codexSupport?.supported).toBe(false);
      expect(codexSupport?.status).toBe('not seen');

      const webEvent = {
        session_id: 'test',
        hook_event_name: 'PreToolUse' as const,
        tool_name: 'WebFetch',
        tool_input: { url: 'https://example.com' },
      };
      const cursorSupport = isStepSupportedOnHost('cursor', webEvent);
      expect(cursorSupport?.supported).toBe(false);
      expect(cursorSupport?.status).toBe('not seen');

      const bashEvent = {
        session_id: 'test',
        hook_event_name: 'PreToolUse' as const,
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
      };
      const mcpSupport = isStepSupportedOnHost('mcp', bashEvent);
      expect(mcpSupport?.supported).toBe(false);
      expect(mcpSupport?.status).toBe('not seen');
    });

    it('returns null for unknown hosts', () => {
      const bashEvent = {
        session_id: 'test',
        hook_event_name: 'PreToolUse' as const,
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
      };
      expect(isStepSupportedOnHost('unknown-host', bashEvent)).toBeNull();
      expect(supportFor('unknown-host', 'shell command')).toBeUndefined();
    });
  });

  describe('formatHostsMarkdown', () => {
    it('formats a complete markdown document containing all hosts and channels', () => {
      const doc = formatHostsMarkdown();
      expect(doc).toContain('# Host channel visibility');
      expect(doc).toContain('## Channels');
      expect(doc).toContain('## Channel visibility matrix');
      expect(doc).toContain('## Host details');
      for (const host of HOST_IDS) {
        expect(doc).toContain(`\`${host}\``);
      }
      for (const channel of CHANNELS) {
        expect(doc).toContain(channel);
      }
    });
  });
});
