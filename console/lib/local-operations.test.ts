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
  it('admits only fixed local operator-assessment routes without journal or file selectors', () => {
    for (const suffix of ['', '/preview', '/apply', '/recheck']) {
      const path = '/api/incident-assessments' + suffix;
      expect(isLocalOperation(path), path).toBe(true);
      for (const unsafe of [
        path + '/',
        path + '/extra',
        path + '?id=private',
        path + '#private',
        path + '-evil',
        'https://foreign.invalid' + path,
      ])
        expect(isLocalOperation(unsafe), unsafe).toBe(false);
    }
    for (const action of ['resolve', 'clear', 'trust', 'delete', 'apply/all', '../apply'])
      expect(isLocalOperation('/api/incident-assessments/' + action)).toBe(false);
  });
  it('admits only exact taint inspection, preview, clear and record recheck operations', () => {
    for (const suffix of ['', '/inspect', '/preview', '/clear', '/recheck']) {
      const path = '/api/session-taint' + suffix;
      expect(isLocalOperation(path), path).toBe(true);
      for (const unsafe of [
        path + '/',
        path + '/extra',
        path + '?session=private',
        path + '#private',
        path + '-evil',
        '//foreign.invalid' + path,
        'https://foreign.invalid' + path,
      ])
        expect(isLocalOperation(unsafe), unsafe).toBe(false);
    }
    for (const path of [
      '/api/session-taint/all',
      '/api/session-taint/untaint',
      '/api/session-taint/restore',
      '/api/session-taint/../clear',
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('permits only fixed workspace task operations without browser file selectors', () => {
    for (const suffix of ['', '/preview', '/apply', '/restore-preview', '/restore', '/recheck']) {
      const path = '/api/workspace-task-controls' + suffix;
      expect(isLocalOperation(path), path).toBe(true);
      for (const unsafe of [
        path + '/',
        path + '/extra',
        path + '?path=private',
        path + '#private',
        path + '-evil',
        'https://foreign.invalid' + path,
      ])
        expect(isLocalOperation(unsafe), unsafe).toBe(false);
    }
    for (const path of [
      '/api/workspace-task-controls/run',
      '/api/workspace-task-controls/../apply',
      '/api/workspace-task-controls/restore/apply',
      '/api/workspace-task-controls/delete',
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
  it('permits only the fixed manual Codex source inspection without selectors in its URL', () => {
    expect(isLocalOperation('/api/inventory/codex-sources')).toBe(true);
    for (const path of [
      '/api/inventory/codex-sources?path=private',
      '/api/inventory/codex-sources/extra',
      '/api/inventory/codex-sources/apply',
      '/api/inventory/codex-sources-evil',
      '/api/inventory/../codex-sources',
      'https://foreign.invalid/api/inventory/codex-sources',
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('admits only the fixed task page endpoint, keeping cursors and selectors out of URLs', () => {
    expect(isLocalOperation('/api/task-locks/page')).toBe(true);
    for (const path of [
      '/api/task-locks/page?cursor=private',
      '/api/task-locks/page/extra',
      '/api/task-locks/pages',
      '/api/task-locks/../page',
      '//foreign.invalid/api/task-locks/page',
    ])
      expect(isLocalOperation(path)).toBe(false);
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
  it('permits the fixed threat feed read and nothing shaped like it', () => {
    expect(isLocalOperation('/api/threats')).toBe(true);
    for (const path of [
      '/api/threats/',
      '/api/threats/fetch',
      '/api/threats?url=https://x',
      '/api/threats#x',
      '/api/threat',
      '/api/../threats',
      'https://pwn.watch/api/threats',
    ])
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
  it('permits only the fixed workspace review operations', () => {
    for (const path of [
      '/api/workspace-review',
      '/api/workspace-review/check',
      '/api/workspace-review/cancel',
      '/api/workspace-review/review',
    ])
      expect(isLocalOperation(path), path).toBe(true);
    for (const path of [
      '/api/workspace-review/run',
      '/api/workspace-review/check/extra',
      '/api/workspace-review?path=private',
      '/api/workspace-review/../review',
      '/api/workspace-review-evil',
      '//foreign.invalid/api/workspace-review',
    ])
      expect(isLocalOperation(path), path).toBe(false);
  });
  it('allows the implemented hook checks, permission controls and exact finding lookup', () => {
    for (const path of [
      '/api/hook-checks',
      '/api/hook-checks/preview',
      '/api/hook-checks/start',
      '/api/hook-checks/cancel',
      '/api/hook-checks/jobs/11111111-1111-4111-8111-111111111111',
      '/api/task-locks',
      '/api/task-locks/preview',
      '/api/task-locks/apply',
      '/api/incidents/task',
      '/api/task-locks/access/preview',
      '/api/task-locks/access/issue',
      `/api/task-locks/access/task-${'a'.repeat(64)}/${'b'.repeat(64)}`,
    ])
      expect(isLocalOperation(path), path).toBe(true);
  });
  it('rejects ambiguous permission, access and hook-check paths before sending a token', () => {
    for (const path of [
      '/api/task-locks/extend',
      '/api/task-locks/access',
      '/api/task-locks/access/issue/extra',
      '/api/task-locks/access/issue?fingerprint=private',
      '/api/task-locks/access/../issue',
      `/api/task-locks/access/task-${'A'.repeat(64)}/${'b'.repeat(64)}`,
      `/api/task-locks/access/task-${'a'.repeat(63)}/${'b'.repeat(64)}`,
      `/api/task-locks/access/task-${'a'.repeat(64)}/${'b'.repeat(65)}`,
      '/api/hook-checks/jobs/../../private',
      '/api/hook-checks/run',
      '/api/hook-checks/jobs/' + '-'.repeat(36),
      '/api/incidents/task/extra',
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
  it('permits fixed credential-filter routes and rejects lookalikes', () => {
    for (const path of [
      '/api/credential-filters',
      '/api/credential-filters/preview',
      '/api/credential-filters/apply',
    ])
      expect(isLocalOperation(path)).toBe(true);
    for (const path of [
      '/api/credential-filters/run',
      '/api/credential-filters?target=claude-user',
      '/api/credential-filters-evil',
      '/api/credential-filters/apply/extra',
    ])
      expect(isLocalOperation(path)).toBe(false);
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
      '/api/live/start',
      '/api/secrets/cancel',
      '/api/live/jobs/11111111-1111-4111-8111-111111111111',
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
      '/api/live/jobs/' + '-'.repeat(36),
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
it('permits only the fixed inventory watch read, preview and apply operations', () => {
  for (const suffix of ['', '/preview', '/apply']) {
    const path = '/api/inventory-monitor' + suffix;
    expect(isLocalOperation(path)).toBe(true);
    for (const unsafe of [
      path + '/',
      path + '/extra',
      path + '?scope=user',
      path + '#private',
      path + '-evil',
      'https://foreign.invalid' + path,
    ])
      expect(isLocalOperation(unsafe), unsafe).toBe(false);
  }
  for (const path of [
    '/api/inventory-monitor/check',
    '/api/inventory-monitor/run',
    '/api/inventory-monitor/../apply',
  ])
    expect(isLocalOperation(path), path).toBe(false);
});
