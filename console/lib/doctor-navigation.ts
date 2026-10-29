import { validateDoctorDiagnostic } from './doctor-diagnostics';
const WORKSPACE = /^workspace-[a-f0-9]{24}$/;
const SUPPORTED_AGENTS = new Set(['claude-code', 'cursor', 'codex']);
const QUIET = new Set([
  'ready',
  'not-configured',
  'no-config',
  'not-created',
  'not-built',
  'unrecorded-registration',
]);
export interface DoctorNavigationContext {
  workspaceId: string | null;
  matchesCurrentRunContext: boolean;
}
function matchingContext(context?: DoctorNavigationContext) {
  return Boolean(
    context &&
    context.workspaceId &&
    WORKSPACE.test(context.workspaceId) &&
    context.matchesCurrentRunContext === true,
  );
}
export function doctorSetupNavigation(
  context?: DoctorNavigationContext,
): { href: string; label: string } | null {
  return matchingContext(context) ? { href: '/agents/', label: 'Review current agents' } : null;
}
export function doctorDiagnosticNavigation(
  diagnostic: unknown,
  observationIndex: number,
  context?: DoctorNavigationContext,
): { href: string; label: string } | null {
  if (
    !matchingContext(context) ||
    !validateDoctorDiagnostic(diagnostic) ||
    !Number.isInteger(observationIndex)
  )
    return null;
  const observation = diagnostic.observations[observationIndex];
  if (!observation || QUIET.has(observation.code)) return null;
  if (diagnostic.kind === 'agent-hooks') {
    if (
      !observation.agent ||
      !SUPPORTED_AGENTS.has(observation.agent) ||
      (observation.scope !== 'project' && observation.scope !== 'user')
    )
      return null;
    return {
      href: `/agents/${observation.scope === 'user' ? '?scope=user' : ''}#${observation.agent}`,
      label: 'Review current settings',
    };
  }
  if (['mcp-proxy', 'mcp-pin', 'mcp-sandbox'].includes(diagnostic.kind))
    return { href: '/skills/?kind=mcp', label: 'Review current MCP inventory' };
  if (['skill-integrity', 'retained-revisions'].includes(diagnostic.kind))
    return { href: '/skills/?kind=skill', label: 'Review current skill inventory' };
  return null;
}
