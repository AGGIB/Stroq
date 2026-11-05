import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { POSTURE_LIMITATIONS, type PostureAudit, type PostureFinding } from './posture';

vi.mock('@/components/platform-ui', async () => {
  const { createElement: h } = await import('react');
  return {
    Badge: ({ children, tone }: any) => h('span', { 'data-tone': tone }, children),
  };
});

import { AgentSettings, SettingsCheck } from '@/components/platform/agent-settings';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const finding = (over: Partial<PostureFinding> = {}): PostureFinding => ({
  id: 'claude-hooks-off',
  agent: 'claude-code',
  scope: 'user',
  count: null,
  ...over,
});
const audit = (over: Partial<PostureAudit> = {}): PostureAudit => ({
  schema: 'stroq-posture/1',
  source: 'local',
  generatedAt: '2026-11-03T10:00:00.000Z',
  sources: [
    { agent: 'claude-code', scope: 'user', file: 'settings', state: 'read' },
    { agent: 'codex', scope: 'user', file: 'config', state: 'missing' },
    { agent: 'windsurf', scope: 'user', file: 'settings', state: 'read' },
  ],
  findings: [finding()],
  cannotCheck: ['cursor-ide-run-mode'],
  limitations: [...POSTURE_LIMITATIONS],
  ...over,
});

const row = (agent: PostureFinding['agent'], a: PostureAudit | null, state = 'ready' as const) =>
  renderToStaticMarkup(createElement(AgentSettings, { agent, audit: a, changes: null, state }));

describe('the settings of one agent', () => {
  it('lists the findings of that agent and opens when one is serious', () => {
    const out = row('claude-code', audit());
    expect(out).toContain('<details class="agent-row-settings" open="">');
    expect(text(out)).toContain('Settings that weaken it 1 to look at');
    expect(text(out)).toContain('Claude Code hooks are switched off');
    expect(text(out)).toContain('disableAllHooks');
  });

  it('says none found for an agent whose files were read and had nothing', () => {
    const out = row('windsurf', audit());
    expect(out).not.toContain('open=""');
    expect(text(out)).toContain('None found');
    expect(text(out)).toContain('None of the checked settings were found in the 1 file read');
  });

  it('says nothing was checked when no file of the agent could be read', () => {
    const out = row('codex', audit());
    expect(text(out)).toContain('No settings file read');
    expect(text(out)).toContain('nothing was checked');
  });

  it('does not call a clean result safe, and does not say a setting is blocked', () => {
    for (const agent of ['claude-code', 'windsurf', 'codex'] as const)
      expect(text(row(agent, audit()))).not.toMatch(/\b(blocked|safe|protected|secure)\b/i);
  });

  it('names the files that could not be checked', () => {
    const out = row(
      'claude-code',
      audit({
        sources: [{ agent: 'claude-code', scope: 'project', file: 'settings', state: 'oversize' }],
        findings: [],
      }),
    );
    expect(text(out)).toContain('1 file could not be checked; look at it yourself.');
  });

  it('says what is going on while it reads, and when it could not', () => {
    expect(text(row('claude-code', null, 'loading' as never))).toContain('Reading');
    expect(text(row('claude-code', null, 'error' as never))).toContain(
      'could not be read, so nothing is said',
    );
  });
});

describe('the settings check under the agents', () => {
  const render = (a: PostureAudit | null, shown: string[] = ['claude-code', 'codex', 'cursor']) =>
    renderToStaticMarkup(
      createElement(SettingsCheck, {
        audit: a,
        changes: null,
        state: a === null ? 'loading' : 'ready',
        error: null,
        shownAgents: shown,
        onReload: () => undefined,
      }),
    );

  it('is the target of the Settings check address, with a button to check again', () => {
    const out = render(audit());
    expect(out).toContain('id="settings"');
    expect(text(out)).toContain('Check again');
    expect(text(out)).toContain('Files checked (3)');
    expect(text(out)).toContain('What this cannot see');
    expect(text(out)).toContain('It shows the setting, never its value.');
  });

  it('lists the findings of an agent that has no row, and not those that have one', () => {
    const out = render(
      audit({
        findings: [
          finding(),
          finding({ id: 'windsurf-allow-any-exec', agent: 'windsurf', count: 2 }),
        ],
      }),
    );
    expect(out).toContain('Settings of other agents that weaken them');
    expect(text(out)).toContain('Windsurf');
    expect(text(out)).not.toContain('Claude Code hooks are switched off');
    expect(render(audit(), ['claude-code', 'windsurf'])).not.toContain('other agents');
  });

  it('says so while it reads', () => {
    expect(text(render(null))).toContain('Reading settings files');
  });
});
