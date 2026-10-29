import { closed, member } from './local-guards';

export const DOCTOR_KINDS = [
  'engine',
  'runtime',
  'rules',
  'scanner',
  'agent-hooks',
  'mcp-proxy',
  'mcp-pin',
  'mcp-sandbox',
  'skill-integrity',
  'retained-revisions',
  'data-home',
  'secret-index',
] as const;
export const DOCTOR_AGENTS = [
  'claude-code',
  'cursor',
  'codex',
  'copilot',
  'openclaw',
  'windsurf',
  'antigravity',
] as const;
export const DOCTOR_MCP_CLIENTS = ['claude-desktop', 'windsurf', 'cursor', 'claude-code'] as const;
export const DOCTOR_SCOPES = [
  'project',
  'user',
  'machine',
  'runtime',
  'data',
  'unspecified',
] as const;
export const DOCTOR_CODES = [
  'ready',
  'not-configured',
  'missing-events',
  'changed-registration',
  'unreadable-source',
  'missing-runtime',
  'approval-required',
  'platform-unsupported',
  'shadowed-registration',
  'unrecorded-registration',
  'not-built',
  'corrupt-index',
  'incomplete-index',
  'unavailable',
  'review-required',
  'no-config',
  'unwrapped-servers',
  'stale-wrappers',
  'unfiltered-environment',
  'not-created',
  'sandbox-launch-conflict',
] as const;
export type DoctorDiagnosticKind = (typeof DOCTOR_KINDS)[number];
export type DoctorDiagnosticCode = (typeof DOCTOR_CODES)[number];
export type DoctorScope = (typeof DOCTOR_SCOPES)[number];
export type DoctorAgent = (typeof DOCTOR_AGENTS)[number];
export type DoctorMcpClient = (typeof DOCTOR_MCP_CLIENTS)[number];
export interface DoctorObservation {
  code: DoctorDiagnosticCode;
  scope: DoctorScope;
  agent: DoctorAgent | null;
  client: DoctorMcpClient | null;
}
export interface DoctorDiagnostic {
  kind: DoctorDiagnosticKind;
  observations: DoctorObservation[];
}
const CODES: Record<DoctorDiagnosticKind, readonly DoctorDiagnosticCode[]> = {
  engine: ['ready', 'unavailable'],
  runtime: ['ready', 'platform-unsupported'],
  rules: ['ready', 'unavailable'],
  scanner: ['ready', 'unavailable'],
  'agent-hooks': [
    'ready',
    'not-configured',
    'missing-events',
    'changed-registration',
    'unreadable-source',
    'missing-runtime',
    'approval-required',
    'platform-unsupported',
    'shadowed-registration',
    'unrecorded-registration',
  ],
  'mcp-proxy': [
    'ready',
    'no-config',
    'unwrapped-servers',
    'stale-wrappers',
    'unfiltered-environment',
    'unreadable-source',
    'not-configured',
  ],
  'mcp-pin': ['ready', 'review-required', 'unavailable'],
  'mcp-sandbox': ['sandbox-launch-conflict'],
  'skill-integrity': ['ready', 'review-required', 'unavailable'],
  'retained-revisions': ['ready', 'review-required', 'unavailable'],
  'data-home': ['ready', 'not-created', 'unavailable'],
  'secret-index': ['ready', 'not-built', 'corrupt-index', 'incomplete-index', 'unavailable'],
};
const LABELS: Record<DoctorDiagnosticKind, string> = {
  engine: 'Stroq engine',
  runtime: 'Node runtime',
  rules: 'Bundled rules',
  scanner: 'Scanner self-test',
  'agent-hooks': 'Agent hook registration',
  'mcp-proxy': 'MCP proxy registration',
  'mcp-pin': 'MCP pinned launch',
  'mcp-sandbox': 'MCP sandbox compatibility',
  'skill-integrity': 'Installed skill integrity',
  'retained-revisions': 'Retained revisions',
  'data-home': 'Stroq data location',
  'secret-index': 'Secret-index statistics',
};
export function doctorDiagnosticLabel(kind: DoctorDiagnosticKind): string {
  return LABELS[kind];
}

export function doctorDiagnosticMatchesCheck(v: unknown, ok: boolean): v is DoctorDiagnostic {
  return validateDoctorDiagnostic(v) && (ok || v.observations.some((o) => o.code !== 'ready'));
}

/** Only producer-owned finite facts cross the report boundary; no paths or rendered detail. */
export function validateDoctorDiagnostic(v: unknown): v is DoctorDiagnostic {
  if (
    !closed(v, ['kind', 'observations']) ||
    !member(v.kind, DOCTOR_KINDS) ||
    !Array.isArray(v.observations) ||
    v.observations.length < 1 ||
    v.observations.length > 16
  )
    return false;
  const kind = v.kind as DoctorDiagnosticKind;
  const valid = v.observations.every((o) => {
    if (
      !closed(o, ['code', 'scope', 'agent', 'client']) ||
      !member(o.code, CODES[kind]) ||
      !member(o.scope, DOCTOR_SCOPES) ||
      !(o.agent === null || member(o.agent, DOCTOR_AGENTS)) ||
      !(o.client === null || member(o.client, DOCTOR_MCP_CLIENTS))
    )
      return false;
    if (kind === 'agent-hooks')
      return (
        o.client === null &&
        (o.agent === null
          ? o.scope === 'machine' && o.code === 'not-configured'
          : (o.scope === 'project' || o.scope === 'user') &&
            (o.agent !== 'openclaw' || o.scope === 'user') &&
            (o.code !== 'approval-required' || o.agent === 'codex') &&
            (o.code !== 'shadowed-registration' || o.agent === 'windsurf'))
      );
    if (kind === 'mcp-proxy')
      return (
        o.agent === null &&
        (o.client === null
          ? o.scope === 'machine' && o.code === 'no-config'
          : (o.scope === 'project' || o.scope === 'user') &&
            ((o.client !== 'claude-desktop' && o.client !== 'windsurf') || o.scope === 'user'))
      );
    if (o.agent !== null || o.client !== null) return false;
    if (['engine', 'runtime', 'rules', 'scanner'].includes(kind)) return o.scope === 'runtime';
    if (kind === 'data-home' || kind === 'secret-index') return o.scope === 'data';
    return (
      o.scope === 'unspecified' || o.scope === 'project' || o.scope === 'user' || o.scope === 'data'
    );
  });
  return (
    valid &&
    new Set(v.observations.map((o) => JSON.stringify([o.code, o.scope, o.agent, o.client])))
      .size === v.observations.length
  );
}
