import { describe, expect, it } from 'vitest';
import { formatExposure, type ExposureReport } from '../../src/exposure/report.js';

const base: ExposureReport = {
  version: 1,
  probed: false,
  agents: [
    { agent: 'claude-code', detected: true, protected: true },
    { agent: 'cursor', detected: true, protected: false },
    { agent: 'codex', detected: false, protected: false },
  ],
  mcp: [
    { client: 'cursor', scope: 'user', file: '/h/.cursor/mcp.json', stdio: 3, wrapped: 1, http: 1 },
  ],
  context: {
    instructionFiles: 2,
    skills: 150,
    subagents: 52,
    commands: 79,
    bytes: 4096,
    flagged: ['/h/a.md'],
    foreignHooks: 0,
    capped: false,
  },
  privilege: [
    {
      key: 'env.ANTHROPIC_BASE_URL',
      file: '/h/.claude/settings.json',
      why: 'redirects API traffic',
    },
  ],
  repo: {
    isRepo: true,
    preTrust: [{ kind: 'git-config-exec', file: '.git/config', what: 'core.fsmonitor' }],
    onOpen: [{ kind: 'husky-hook', file: '.husky/pre-commit', what: 'pre-commit' }],
    capped: false,
  },
  reach: { total: 13, passedPolicy: 0, anyAgentProtected: true },
  findings: [
    {
      class: 'privilege-widened',
      severity: 'critical',
      detail: 'ANTHROPIC_BASE_URL is set',
      fix: null,
    },
    {
      class: 'mcp-unwrapped',
      severity: 'high',
      detail: '2 of 3 stdio servers unwrapped',
      fix: 'stroq init --agent mcp --client cursor',
    },
  ],
};

describe('formatExposure', () => {
  it('counts detected and protected agents in the summary', () => {
    const out = formatExposure(base);
    expect(out).toMatch(/Agents detected\s+2/);
    expect(out).toMatch(/protected\s+1/);
  });

  it('shows the MCP totals across clients', () => {
    const out = formatExposure(base);
    expect(out).toMatch(/stdio, unwrapped\s+2/);
    expect(out).toMatch(/http \(out of reach\)\s+1/);
  });

  it('lists findings most severe first, with the fix', () => {
    const out = formatExposure(base);
    const criticalAt = out.indexOf('CRITICAL');
    const highAt = out.indexOf('HIGH');
    expect(criticalAt).toBeGreaterThan(-1);
    expect(criticalAt).toBeLessThan(highAt);
    expect(out).toContain('stroq init --agent mcp --client cursor');
  });

  it('says the scan was file-only when probed is false', () => {
    expect(formatExposure(base)).toMatch(/--probe/);
  });

  it('says servers were started when probed is true', () => {
    const out = formatExposure({ ...base, probed: true });
    expect(out).toMatch(/tool descriptions scanned/i);
  });

  it('hides flagged file paths unless verbose', () => {
    expect(formatExposure(base)).not.toContain('/h/a.md');
    expect(formatExposure(base, { verbose: true })).toContain('/h/a.md');
  });

  it('states that counts are a lower bound when discovery hit its cap', () => {
    const capped = formatExposure({ ...base, context: { ...base.context, capped: true } });
    expect(capped).toMatch(/lower bound/i);
    expect(formatExposure(base)).not.toMatch(/lower bound/i);
  });

  it('reports a clean machine without findings', () => {
    const clean: ExposureReport = {
      ...base,
      privilege: [],
      findings: [],
      context: { ...base.context, flagged: [] },
    };
    expect(formatExposure(clean)).toMatch(/no findings/i);
  });
});
