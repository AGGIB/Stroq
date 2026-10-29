import { describe, expect, it } from 'vitest';
import { doctorDiagnosticNavigation, doctorSetupNavigation } from './doctor-navigation';
const workspaceId = `workspace-${'a'.repeat(24)}`;
const context = { workspaceId, matchesCurrentRunContext: true };
const diagnostic = (
  kind = 'agent-hooks',
  code = 'missing-events',
  scope = 'user',
  agent: string | null = 'claude-code',
  client: string | null = null,
) => ({ kind, observations: [{ code, scope, agent, client }] });
describe('typed diagnostic navigation', () => {
  it('offers an unselected current Agents chooser for a setup gap only in a matching local context', () => {
    expect(doctorSetupNavigation(context)).toEqual({
      href: '/agents/',
      label: 'Review current agents',
    });
    expect(doctorSetupNavigation()).toBeNull();
    expect(doctorSetupNavigation({ workspaceId: null, matchesCurrentRunContext: true })).toBeNull();
    expect(
      doctorSetupNavigation({ workspaceId: 'private/path', matchesCurrentRunContext: true }),
    ).toBeNull();
    expect(doctorSetupNavigation({ workspaceId, matchesCurrentRunContext: false })).toBeNull();
  });
  it('uses only fixed scoped agent routes without opening an unrelated filter action', () => {
    expect(doctorDiagnosticNavigation(diagnostic(), 0, context)).toEqual({
      href: '/agents/?scope=user#claude-code',
      label: 'Review current settings',
    });
    expect(
      doctorDiagnosticNavigation(
        diagnostic('agent-hooks', 'changed-registration', 'project', 'cursor'),
        0,
        context,
      )?.href,
    ).toBe('/agents/#cursor');
  });
  it('requires a current matching local context and never pretends a historical report is a repair plan', () => {
    for (const candidate of [
      undefined,
      { workspaceId: null, matchesCurrentRunContext: true },
      { workspaceId: 'private/path', matchesCurrentRunContext: true },
      { workspaceId, matchesCurrentRunContext: false },
    ]) {
      expect(doctorDiagnosticNavigation(diagnostic(), 0, candidate)).toBeNull();
    }
  });
  it('routes inventory families to fixed existing tabs and does not invent a secret-index repair', () => {
    expect(
      doctorDiagnosticNavigation(
        diagnostic('mcp-proxy', 'stale-wrappers', 'user', null, 'cursor'),
        0,
        context,
      )?.href,
    ).toBe('/skills/?kind=mcp');
    expect(
      doctorDiagnosticNavigation(
        diagnostic('skill-integrity', 'review-required', 'project', null),
        0,
        context,
      )?.href,
    ).toBe('/skills/?kind=skill');
    expect(
      doctorDiagnosticNavigation(
        diagnostic('secret-index', 'incomplete-index', 'data', null),
        0,
        context,
      ),
    ).toBeNull();
  });
  it('refuses unsupported agents, absent targets, malformed metadata and forged destinations', () => {
    for (const value of [
      diagnostic('agent-hooks', 'missing-events', 'user', 'copilot'),
      diagnostic('agent-hooks', 'missing-events', 'machine', 'claude-code'),
      diagnostic('agent-hooks', 'bad', 'user', 'claude-code'),
      diagnostic('agent-hooks', 'missing-events', 'user', 'bad'),
      diagnostic('mcp-proxy', 'stale-wrappers', 'user', null, 'bad'),
      { ...diagnostic(), href: 'https://evil.test' },
      { kind: 'agent-hooks', observations: [{ ...diagnostic().observations[0], href: '/keys/' }] },
    ]) {
      expect(doctorDiagnosticNavigation(value, 0, context)).toBeNull();
    }
    expect(doctorDiagnosticNavigation(diagnostic(), -1, context)).toBeNull();
    expect(doctorDiagnosticNavigation(diagnostic(), 1, context)).toBeNull();
    expect(
      doctorDiagnosticNavigation(diagnostic('agent-hooks', 'ready', 'user', 'codex'), 0, context),
    ).toBeNull();
  });
});
