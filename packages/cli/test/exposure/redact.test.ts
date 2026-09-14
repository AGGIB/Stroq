import { describe, expect, it } from 'vitest';
import { formatShareable, toShareable } from '../../src/exposure/redact.js';
import type { ExposureReport } from '../../src/exposure/report.js';

const report: ExposureReport = {
  version: 1,
  probed: false,
  agents: [
    { agent: 'claude-code', detected: true, protected: true },
    { agent: 'cursor', detected: true, protected: false },
  ],
  mcp: [
    {
      client: 'cursor',
      scope: 'user',
      file: '/Users/secretname/.cursor/mcp.json',
      stdio: 3,
      wrapped: 1,
      http: 1,
    },
  ],
  context: {
    instructionFiles: 2,
    skills: 150,
    subagents: 52,
    commands: 79,
    bytes: 4096,
    flagged: ['/Users/secretname/.claude/skills/private-thing/SKILL.md'],
    foreignHooks: 1,
    capped: false,
  },
  privilege: [
    {
      key: 'env.ANTHROPIC_BASE_URL',
      file: '/Users/secretname/.claude/settings.json',
      why: 'redirects API traffic',
    },
  ],
  reach: { total: 13, passedPolicy: 4, anyAgentProtected: true },
  findings: [
    {
      class: 'privilege-widened',
      severity: 'critical',
      detail: 'set in /Users/secretname/.claude/settings.json',
      fix: null,
    },
  ],
};

const LEAKS = [
  'secretname',
  '/Users',
  'private-thing',
  'mcp.json',
  'settings.json',
  'redirects API traffic',
];

describe('toShareable', () => {
  it('keeps the counts', () => {
    const share = toShareable(report);
    expect(share.agentsDetected).toBe(2);
    expect(share.agentsProtected).toBe(1);
    expect(share.mcpStdio).toBe(3);
    expect(share.mcpWrapped).toBe(1);
    expect(share.mcpHttp).toBe(1);
    expect(share.contextFlagged).toBe(1);
    expect(share.reachPassed).toBe(4);
  });

  it('keeps privilege key names but not where they were found', () => {
    const share = toShareable(report);
    expect(share.privilegeKeys).toEqual(['env.ANTHROPIC_BASE_URL']);
  });

  it('keeps finding classes and severities but not details', () => {
    const share = toShareable(report);
    expect(share.findings).toEqual([{ class: 'privilege-widened', severity: 'critical' }]);
  });

  it('carries exactly the whitelisted fields and no others', () => {
    expect(Object.keys(toShareable(report)).sort()).toEqual(
      [
        'agentsDetected',
        'agentsProtected',
        'contextFiles',
        'contextFlagged',
        'findings',
        'foreignHooks',
        'mcpHttp',
        'mcpStdio',
        'mcpWrapped',
        'privilegeKeys',
        'probed',
        'reachPassed',
        'reachTotal',
        'version',
      ].sort(),
    );
  });

  it('leaks nothing identifying through the serialized record', () => {
    const json = JSON.stringify(toShareable(report));
    for (const leak of LEAKS) expect(json).not.toContain(leak);
  });
});

describe('formatShareable', () => {
  it('leaks nothing identifying through the rendered text', () => {
    const text = formatShareable(toShareable(report));
    for (const leak of LEAKS) expect(text).not.toContain(leak);
  });

  it('still says something useful', () => {
    const text = formatShareable(toShareable(report));
    expect(text).toContain('stroq exposure');
    expect(text).toMatch(/4\s*\/\s*13|4 of 13/);
  });
});
