import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@stroq/core';
import { runAttack } from '../src/attack/run.js';
import { SCENARIOS } from '../src/attack/scenarios/index.js';
import { hostStepSupport } from '../src/hosts/channels.js';
import { formatHostsMarkdown } from '../src/hosts/hosts-report.js';

describe('host replay reflects each tool, not just its broad channel', () => {
  it('does not replay shell output that Windsurf never sends', async () => {
    expect(hostStepSupport('windsurf', 'post', 'Bash').supported).toBe(false);
    expect(hostStepSupport('windsurf', 'post', 'mcp__demo__read').supported).toBe(true);
    const scenario = SCENARIOS.find((item) => item.id.startsWith('04'))!;
    const report = await runAttack([scenario], DEFAULT_POLICY, 'default', { host: 'windsurf' });
    expect(report.scenarios[0]?.outcome).toBe('unsupported');
    expect(report.scenarios[0]?.steps[0]?.actual).toBeNull();
    expect(report.totals.blocked).toBe(0);
    expect(report.ok).toBe(false);
  });

  it('keeps Claude WebFetch pre-hooks and WebSearch post-hooks distinct', () => {
    expect(hostStepSupport('claude-code', 'pre', 'WebSearch').supported).toBe(false);
    expect(hostStepSupport('claude-code', 'post', 'WebSearch').supported).toBe(true);
    expect(hostStepSupport('claude-code', 'pre', 'WebFetch').supported).toBe(true);
  });

  it('does not supply absent page bodies or native shell results to the engine', () => {
    expect(hostStepSupport('antigravity', 'post', 'WebFetch').supported).toBe(false);
    expect(hostStepSupport('antigravity', 'pre', 'WebFetch').supported).toBe(true);
    expect(hostStepSupport('mcp', 'post', 'Bash').supported).toBe(false);
    expect(hostStepSupport('mcp', 'post', 'mcp__demo__read').supported).toBe(true);
  });

  it('escapes evidence table separators and HTML placeholders', () => {
    const markdown = formatHostsMarkdown();
    expect(markdown).toContain('Write\\|Delete');
    expect(markdown).toContain('&lt;tool&gt;');
    expect(markdown).not.toContain('mcp__copilot__<tool>');
  });
});
