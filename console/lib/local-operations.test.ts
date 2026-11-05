import { describe, expect, it } from 'vitest';
import { isLocalOperation } from './local-operations';
describe('local API operation allowlist', () => {
  it('permits only fixed MCP governance operations without URL selectors', () => {
    for (const suffix of ['', '/capture', '/preview', '/apply', '/recheck']) {
      const path = '/api/mcp-governance' + suffix;
      expect(isLocalOperation(path)).toBe(true);
      for (const unsafe of [
        path + '/',
        path + '/extra',
        path + '?home=private',
        path + '#private',
        'https://foreign.invalid' + path,
      ])
        expect(isLocalOperation(unsafe)).toBe(false);
    }
    for (const suffix of ['/run', '/trust', '/all', '/restore', '/../apply'])
      expect(isLocalOperation('/api/mcp-governance' + suffix)).toBe(false);
  });
  it('admits only the exact recorded-evidence operation without URL selectors', () => {
    expect(isLocalOperation('/api/incidents/evidence')).toBe(true);
    for (const path of [
      '/api/incidents/evidence/',
      '/api/incidents/evidence/extra',
      '/api/incidents/evidence?seq=1',
      '/api/incidents/evidence#private',
      '/api/incidents/../evidence',
      '/api/incidents/evidence-evil',
      'https://foreign.invalid/api/incidents/evidence',
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('admits only the fixed protection-check cancellation route', () => {
    expect(isLocalOperation('/api/runs/cancel')).toBe(true);
    for (const path of [
      '/api/runs/cancel/extra',
      '/api/runs/cancel?id=private',
      '/api/runs/../cancel',
      '/api/runs/cancel-evil',
    ])
      expect(isLocalOperation(path)).toBe(false);
  });
  it('no longer admits the removed Codex guard and source routes', () => {
    for (const path of [
      '/api/inventory/codex-sources',
      '/api/inventory/codex-controls',
      '/api/inventory/codex-control-preview',
      '/api/inventory/codex-control-apply',
      '/api/inventory/codex-control-recheck',
      '/api/codex-network-guard',
      '/api/codex-network-guard/preview',
      '/api/codex-network-checks/start',
      '/api/codex-path-guard',
      '/api/codex-path-guard/apply',
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('permits only the fixed journal tail and summary reads', () => {
    expect(isLocalOperation('/api/journal/tail')).toBe(true);
    expect(isLocalOperation('/api/journal/summary')).toBe(true);
    expect(isLocalOperation('/api/journal/since')).toBe(true);
    for (const path of [
      '/api/journal',
      '/api/journal/',
      '/api/journal/tail/',
      '/api/journal/tail?after=1',
      '/api/journal/tail#x',
      '/api/journal/export',
      '/api/journal/since/',
      '/api/journal/since?at=1',
      '/api/journal/../tail',
      '/api/journals/tail',
      'https://foreign.invalid/api/journal/tail',
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('permits the fixed settings check read and nothing shaped like it', () => {
    expect(isLocalOperation('/api/posture')).toBe(true);
    for (const path of [
      '/api/posture/',
      '/api/posture/extra',
      '/api/posture?path=/etc',
      '/api/posture#x',
      '/api/postures',
      '/api/../posture',
      'https://foreign.invalid/api/posture',
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('no longer admits the routes of the pages the console no longer has', () => {
    const job = '11111111-1111-4111-8111-111111111111';
    for (const base of [
      '/api/incident-assessments',
      '/api/session-taint',
      '/api/workspace-task-controls',
      '/api/workspace-review',
      '/api/workspace-monitor',
      '/api/inventory-monitor',
      '/api/secrets',
    ])
      for (const suffix of [
        '',
        '/preview',
        '/apply',
        '/start',
        '/cancel',
        '/check',
        '/review',
        `/jobs/${job}`,
      ])
        expect(isLocalOperation(base + suffix), base + suffix).toBe(false);
  });
  it('admits the card routes and nothing shaped like them', () => {
    expect(isLocalOperation('/api/card')).toBe(true);
    expect(isLocalOperation('/api/card/start')).toBe(true);
    for (const path of [
      '/api/card/',
      '/api/card/start/',
      '/api/card/run',
      '/api/card?days=3650',
      '/api/card/../start',
      '/api/cards',
      'https://foreign.invalid/api/card',
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('no longer admits the removed live-check routes', () => {
    for (const path of [
      '/api/live',
      '/api/live/preview',
      '/api/live/start',
      '/api/live/cancel',
      '/api/live/jobs/11111111-1111-4111-8111-111111111111',
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('no longer admits the removed threat feed route', () => {
    for (const path of ['/api/threats', '/api/threats/fetch', '/api/threats?url=https://x'])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('permits the fixed try-an-action operation and nothing shaped like it', () => {
    expect(isLocalOperation('/api/policy/try')).toBe(true);
    for (const path of [
      '/api/policy/try/',
      '/api/policy/try/extra',
      '/api/policy/try?command=ls',
      '/api/policy/try#x',
      '/api/policy/tryout',
      '/api/policy/../try',
      'https://foreign.invalid/api/policy/try',
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('permits only fixed policy history and restore operations', () => {
    for (const path of [
      '/api/policy/history',
      '/api/policy/restore/preview',
      '/api/policy/restore/apply',
    ])
      expect(isLocalOperation(path), path).toBe(true);
    for (const path of [
      '/api/policy/restore',
      '/api/policy/history/apply',
      '/api/policy/restore/run',
      '/api/policy/restore/apply/extra',
      '/api/policy/restore/apply?file=private',
      '/api/policy/restore/../apply',
      '/api/policy/history-evil',
      'https://foreign.invalid/api/policy/history',
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('allows artifact comparison through the same client gate as inspection and review', () => {
    expect(isLocalOperation('/api/inventory/compare')).toBe(true);
    for (const path of [
      '/api/inventory/compare/extra',
      '/api/inventory/compare?token=private',
      '/api/inventory/../compare',
      '/api/inventory/compare-evil',
    ])
      expect(isLocalOperation(path)).toBe(false);
  });
  it('allows the implemented hook checks', () => {
    for (const path of [
      '/api/hook-checks',
      '/api/hook-checks/preview',
      '/api/hook-checks/start',
      '/api/hook-checks/cancel',
      '/api/hook-checks/jobs/11111111-1111-4111-8111-111111111111',
    ])
      expect(isLocalOperation(path), path).toBe(true);
  });
  it('rejects ambiguous hook-check paths before sending a token', () => {
    for (const path of [
      '/api/hook-checks/jobs/../../private',
      '/api/hook-checks/run',
      '/api/hook-checks/jobs/' + '-'.repeat(36),
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('no longer admits the removed task permission and finding lookup routes', () => {
    for (const path of [
      '/api/task-locks',
      '/api/task-locks/page',
      '/api/task-locks/preview',
      '/api/task-locks/apply',
      '/api/task-locks/access/preview',
      '/api/task-locks/access/issue',
      `/api/task-locks/access/task-${'a'.repeat(64)}/${'b'.repeat(64)}`,
      '/api/incidents/task',
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('allows only fixed hook removal routes', () => {
    for (const path of [
      '/api/agent-disconnect',
      '/api/agent-disconnect/preview',
      '/api/agent-disconnect/apply',
    ])
      expect(isLocalOperation(path)).toBe(true);
    for (const path of [
      '/api/agent-disconnect/run',
      '/api/agent-disconnect?path=private',
      '/api/agent-disconnect/apply/extra',
      '/api/agent-disconnect-evil',
    ])
      expect(isLocalOperation(path)).toBe(false);
  });
  it('allows only the three fixed saved-check routes', () => {
    for (const path of ['/api/policy/cases', '/api/policy/cases/save', '/api/policy/cases/remove'])
      expect(isLocalOperation(path)).toBe(true);
    for (const path of [
      '/api/policy/cases/run',
      '/api/policy/cases/save/extra',
      '/api/policy/cases?path=private',
      '/api/policy/cases-evil',
    ])
      expect(isLocalOperation(path)).toBe(false);
  });
  it('no longer admits the removed credential-filter routes', () => {
    for (const path of [
      '/api/credential-filters',
      '/api/credential-filters/preview',
      '/api/credential-filters/apply',
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('permits only fixed MCP call control operations', () => {
    for (const path of [
      '/api/mcp-call-controls',
      '/api/mcp-call-controls/inspect',
      '/api/mcp-call-controls/preview',
      '/api/mcp-call-controls/apply',
      '/api/mcp-call-controls/recheck',
    ])
      expect(isLocalOperation(path), path).toBe(true);
    for (const path of [
      '/api/mcp-call-controls/run',
      '/api/mcp-call-controls?control=private',
      '/api/mcp-call-controls/apply/extra',
      '/api/mcp-call-controls-evil',
      '/api/mcp-call-controls/../apply',
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('permits all three concrete MCP routes through the actual client gate', () => {
    for (const path of [
      '/api/mcp-containment',
      '/api/mcp-containment/preview',
      '/api/mcp-containment/apply',
    ])
      expect(isLocalOperation(path), path).toBe(true);
  });
  it('preserves existing fixed operations and bounded job reads', () => {
    for (const path of [
      '/api/context',
      '/api/control',
      '/api/agents',
      '/api/quarantine',
      '/api/quarantine/apply',
      '/api/incidents/compare',
      '/api/inventory/inspect',
      '/api/agent-setup/preview',
      '/api/policy/apply',
      '/api/runs/11111111-1111-4111-8111-111111111111',
    ])
      expect(isLocalOperation(path), path).toBe(true);
  });
  it('refuses arbitrary paths, URL tokens and lookalike action names', () => {
    for (const path of [
      '/api/mcp-containment/run',
      '/api/mcp-containment-evil',
      '/api/mcp-containment/apply/extra',
      '/api/mcp-containment?token=private',
      '/api/mcp-containment/../apply',
      '//foreign.invalid/api/mcp-containment',
      'https://foreign.invalid/api/mcp-containment',
      '',
      null,
    ])
      expect(isLocalOperation(path), String(path)).toBe(false);
  });
});

it('admits only exact selected skill signal state, preview and apply routes', () => {
  for (const action of ['state', 'preview', 'apply']) {
    const path = `/api/inventory/signals/${action}`;
    expect(isLocalOperation(path)).toBe(true);
    for (const unsafe of [
      path + '/',
      path + '/extra',
      path + '?token=private',
      path + '#private',
      path + '-evil',
      path.replace('/signals/', '/signals/../'),
      `https://example.invalid${path}`,
    ])
      expect(isLocalOperation(unsafe), unsafe).toBe(false);
  }
  expect(isLocalOperation('/api/inventory/signals')).toBe(false);
  expect(isLocalOperation('/api/inventory/signals/review')).toBe(false);
});
