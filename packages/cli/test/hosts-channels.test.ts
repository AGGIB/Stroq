import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ATTACK_CHANNELS,
  ATTACK_HOSTS,
  HOST_CHANNELS,
  hostStepSupport,
  isAttackHost,
  isChannelSupported,
  stepChannel,
} from '../src/hosts/channels.js';
import { computeHostStepAccounting, formatHostsMarkdown } from '../src/hosts/hosts-report.js';

const readAgentsMd = (): string =>
  readFileSync(fileURLToPath(new URL('../../../docs/AGENTS.md', import.meta.url)), 'utf8');

describe('hosts channel matrix', () => {
  it('has a bijective mapping between ATTACK_HOSTS and docs/AGENTS.md host sections', () => {
    const agentsMd = readAgentsMd();
    for (const host of ATTACK_HOSTS) {
      const entry = HOST_CHANNELS[host];
      expect(entry).toBeDefined();
      expect(entry.id).toBe(host);
      // Ensure the anchor or heading exists in docs/AGENTS.md
      const headingOrAnchor = new RegExp(
        `(#+\\s*.*${entry.label}|<a\\s+id="${entry.agentsAnchor}"|#${entry.agentsAnchor})`,
        'i',
      );
      expect(
        headingOrAnchor.test(agentsMd),
        `docs/AGENTS.md must document host "${host}" (anchor: ${entry.agentsAnchor})`,
      ).toBe(true);
    }
  });

  it('guarantees every "not seen" cell cites concrete evidence in docs/AGENTS.md or fixture', () => {
    for (const host of ATTACK_HOSTS) {
      const entry = HOST_CHANNELS[host];
      for (const channel of ATTACK_CHANNELS) {
        const cell = entry.channels[channel];
        expect(cell).toBeDefined();
        if (cell.status === 'not seen') {
          expect(
            cell.evidence.length,
            `Host ${host} channel ${channel} is "not seen" and must have evidence`,
          ).toBeGreaterThan(10);
          expect(
            cell.evidence.includes('docs/AGENTS.md') ||
              cell.evidence.includes('packages/cli/test/fixtures/hosts/'),
            `Host ${host} channel ${channel} evidence must point to docs/AGENTS.md or a fixture`,
          ).toBe(true);
        }
      }
    }
  });

  it('classifies scenario step channels accurately', () => {
    expect(stepChannel('pre', 'Bash')).toBe('shell command');
    expect(stepChannel('pre', 'Write')).toBe('file write');
    expect(stepChannel('pre', 'Read')).toBe('file read');
    expect(stepChannel('pre', 'mcp__test__tool')).toBe('MCP call');
    expect(stepChannel('post', 'Bash')).toBe('tool result');
    expect(stepChannel('pre', 'WebFetch')).toBe('web fetch');
  });

  it('computes host step accounting and generates HOSTS.md format without throwing', () => {
    for (const host of ATTACK_HOSTS) {
      const accounting = computeHostStepAccounting(host);
      expect(accounting.totalScenarios).toBe(36);
      expect(accounting.totalSteps).toBeGreaterThan(36);
      expect(accounting.supportedSteps + accounting.unsupportedSteps).toBe(accounting.totalSteps);
    }
    const md = formatHostsMarkdown();
    expect(md).toContain('# Host Channel Coverage');
    expect(md).toContain('Claude Code');
    expect(md).toContain('Google Antigravity');
  });
});
