import {
  validateDoctorDiagnostic,
  type DoctorDiagnostic,
  type DoctorDiagnosticCode,
} from './doctor-diagnostics';
const REASONS: Record<DoctorDiagnosticCode, string> = {
  ready: 'Recorded ready',
  'not-configured': 'Not configured',
  'missing-events': 'Required hook events missing',
  'changed-registration': 'Registration changed',
  'unreadable-source': 'Configuration could not be read',
  'missing-runtime': 'Hook runtime is missing',
  'approval-required': 'Host approval required',
  'platform-unsupported': 'Unsupported on this platform',
  'shadowed-registration': 'Another configuration takes precedence',
  'unrecorded-registration': 'Registration has no install record',
  'not-built': 'Not built yet',
  'corrupt-index': 'Secret index is corrupt',
  'incomplete-index': 'Secret index coverage is incomplete',
  unavailable: 'Evidence unavailable',
  'review-required': 'Needs review',
  'no-config': 'No configuration found',
  'unwrapped-servers': 'Servers are not routed through Stroq',
  'stale-wrappers': 'Wrapper runtime is missing',
  'unfiltered-environment': 'Server environment is not filtered',
  'not-created': 'Not created yet',
  'sandbox-launch-conflict': 'Pinned server launch conflicts with sandbox rules',
};
const QUIET = new Set<DoctorDiagnosticCode>([
  'ready',
  'not-configured',
  'no-config',
  'not-created',
  'not-built',
  'unrecorded-registration',
]);
const AGENTS: Record<string, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex CLI',
  copilot: 'Copilot CLI',
  openclaw: 'OpenClaw',
  windsurf: 'Windsurf',
  antigravity: 'Antigravity',
};
const CLIENTS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
};
const SCOPES = {
  project: 'Workspace',
  user: 'User',
  machine: 'Machine',
  runtime: 'Runtime',
  data: 'Stroq data',
  unspecified: 'Scope unspecified',
};
interface InputCheck {
  id: string;
  label: string;
  ok: boolean;
  diagnostic?: unknown;
}
export interface DoctorInstallationRow {
  id: string;
  label: string;
  reason: string;
  scopeLabel: string | null;
  attention: boolean;
  legacy: boolean;
  diagnostic: DoctorDiagnostic | null;
  observationIndex: number | null;
}
export function doctorSetupMissing(result: {
  checks: InputCheck[];
  diagnosticsVersion?: number;
}): boolean {
  if (
    result.diagnosticsVersion !== 1 ||
    !result.checks.every((check) => validateDoctorDiagnostic(check.diagnostic))
  )
    return false;
  const registrations = result.checks.filter(
    (check) =>
      validateDoctorDiagnostic(check.diagnostic) && check.diagnostic.kind === 'agent-hooks',
  );
  return (
    registrations.some((check) => !check.ok) &&
    registrations.every(
      (check) =>
        validateDoctorDiagnostic(check.diagnostic) &&
        check.diagnostic.observations.every((observation) => observation.code === 'not-configured'),
    )
  );
}
export function doctorInstallationRows(result: {
  checks: InputCheck[];
  diagnosticsVersion?: number;
}): DoctorInstallationRow[] {
  const typed =
    result.diagnosticsVersion === 1 &&
    result.checks.every((check) => validateDoctorDiagnostic(check.diagnostic));
  return result.checks.flatMap<DoctorInstallationRow>((check) => {
    if (!typed || !validateDoctorDiagnostic(check.diagnostic))
      return [
        {
          id: check.id,
          label: check.label,
          reason: check.ok ? 'Recorded OK' : 'Recorded issue',
          scopeLabel: null,
          attention: !check.ok,
          legacy: true,
          diagnostic: null,
          observationIndex: null,
        },
      ];
    const diagnostic = check.diagnostic;
    return diagnostic.observations.map((observation, index) => ({
      id: `${check.id}:${index}`,
      label: check.label,
      reason:
        diagnostic.kind === 'runtime' && observation.code === 'platform-unsupported'
          ? 'Node version is unsupported'
          : REASONS[observation.code],
      scopeLabel: [
        observation.agent
          ? AGENTS[observation.agent]
          : observation.client
            ? CLIENTS[observation.client]
            : null,
        SCOPES[observation.scope],
      ]
        .filter(Boolean)
        .join(' · '),
      attention: !QUIET.has(observation.code),
      legacy: false,
      diagnostic,
      observationIndex: index,
    }));
  });
}
