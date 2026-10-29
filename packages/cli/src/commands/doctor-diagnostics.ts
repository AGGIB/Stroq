import type { SecretIndexStats } from '@stroq/core';
import type { McpClient } from './mcp-config.js';

/** Producer facts only. These codes never describe a live host test or enforcement proof. */
export type DoctorDiagnosticKind =
  | 'engine'
  | 'runtime'
  | 'rules'
  | 'scanner'
  | 'agent-hooks'
  | 'mcp-proxy'
  | 'mcp-pin'
  | 'mcp-sandbox'
  | 'skill-integrity'
  | 'retained-revisions'
  | 'data-home'
  | 'secret-index';
export type DoctorDiagnosticCode =
  | 'ready'
  | 'not-configured'
  | 'missing-events'
  | 'changed-registration'
  | 'unreadable-source'
  | 'missing-runtime'
  | 'approval-required'
  | 'platform-unsupported'
  | 'shadowed-registration'
  | 'unrecorded-registration'
  | 'not-built'
  | 'corrupt-index'
  | 'incomplete-index'
  | 'unavailable'
  | 'review-required'
  | 'no-config'
  | 'unwrapped-servers'
  | 'stale-wrappers'
  | 'unfiltered-environment'
  | 'not-created'
  | 'sandbox-launch-conflict';
export type DoctorDiagnosticScope =
  'project' | 'user' | 'machine' | 'runtime' | 'data' | 'unspecified';
export type DoctorDiagnosticAgent =
  'claude-code' | 'cursor' | 'codex' | 'copilot' | 'openclaw' | 'windsurf' | 'antigravity';
export interface DoctorObservation {
  readonly code: DoctorDiagnosticCode;
  readonly scope: DoctorDiagnosticScope;
  readonly agent: DoctorDiagnosticAgent | null;
  readonly client: McpClient | null;
}
export interface DoctorDiagnostic {
  readonly kind: DoctorDiagnosticKind;
  readonly observations: readonly DoctorObservation[];
}

export const observation = (
  code: DoctorDiagnosticCode,
  scope: DoctorDiagnosticScope,
  agent: DoctorDiagnosticAgent | null = null,
  client: McpClient | null = null,
): DoctorObservation => ({ code, scope, agent, client });

export const doctorDiagnostic = (
  kind: DoctorDiagnosticKind,
  code: DoctorDiagnosticCode,
  scope: DoctorDiagnosticScope = 'unspecified',
): DoctorDiagnostic => ({ kind, observations: [observation(code, scope)] });

export interface HookDiagnosticScope {
  readonly scope: 'project' | 'user';
  readonly installed: boolean;
  readonly error: string | null;
  readonly missing?: readonly string[];
  readonly drift?: 'intact' | 'changed' | 'unrecorded';
  readonly vanished?: readonly string[];
  readonly unapproved?: boolean;
  readonly unstartable?: boolean;
  readonly shadowedBy?: string;
}

export function hookDiagnostic(
  agent: DoctorDiagnosticAgent,
  scopes: readonly HookDiagnosticScope[],
): DoctorDiagnostic {
  return {
    kind: 'agent-hooks',
    observations: scopes.flatMap((scope) => {
      const codes: DoctorDiagnosticCode[] = [
        ...(scope.error !== null ? ['unreadable-source' as const] : []),
        ...((scope.missing?.length ?? 0) > 0 ? ['missing-events' as const] : []),
        ...(scope.drift === 'changed' ? ['changed-registration' as const] : []),
        ...((scope.vanished?.length ?? 0) > 0 ? ['missing-runtime' as const] : []),
        ...(scope.unapproved === true ? ['approval-required' as const] : []),
        ...(scope.unstartable === true ? ['platform-unsupported' as const] : []),
        ...(scope.shadowedBy !== undefined ? ['shadowed-registration' as const] : []),
        ...(scope.drift === 'unrecorded' ? ['unrecorded-registration' as const] : []),
      ];
      const actual =
        codes.length > 0
          ? codes
          : [scope.installed ? ('ready' as const) : ('not-configured' as const)];
      return actual.map((code) => observation(code, scope.scope, agent));
    }),
  };
}

export interface ProxyDiagnosticScope {
  readonly scope: 'project' | 'user';
  readonly proxyScope?: 'project' | 'user';
  readonly client?: McpClient;
  readonly error: string | null;
  readonly proxyCounts?: {
    readonly wrapped: number;
    readonly stdio: number;
    readonly stale: number;
    readonly unfiltered: number;
  };
}

export function proxyDiagnostic(scopes: readonly ProxyDiagnosticScope[]): DoctorDiagnostic {
  return {
    kind: 'mcp-proxy',
    observations: scopes.flatMap((source) => {
      if (source.client === undefined) return [observation('no-config', 'machine')];
      const scope = source.proxyScope ?? source.scope;
      if (source.error !== null)
        return [observation('unreadable-source', scope, null, source.client)];
      const counts = source.proxyCounts;
      if (counts === undefined)
        return [observation('unreadable-source', scope, null, source.client)];
      // A stale wrapper is reported separately; it is not an unwrapped foreign entry.
      // At most three reasons for each of the five distinct known source files (15 total).
      const codes: DoctorDiagnosticCode[] = [
        ...(counts.stdio > counts.wrapped + counts.stale ? ['unwrapped-servers' as const] : []),
        ...(counts.stale > 0 ? ['stale-wrappers' as const] : []),
        ...(counts.unfiltered > 0 ? ['unfiltered-environment' as const] : []),
      ];
      const actual =
        codes.length > 0
          ? codes
          : [counts.stdio > 0 ? ('ready' as const) : ('not-configured' as const)];
      return actual.map((code) => observation(code, scope, null, source.client ?? null));
    }),
  };
}

export function secretDiagnostic(stats: SecretIndexStats): DoctorDiagnostic {
  const codes: DoctorDiagnosticCode[] = [
    ...(stats.corrupt ? ['corrupt-index' as const] : []),
    ...(!stats.corrupt && stats.builtAt === null ? ['not-built' as const] : []),
    ...(stats.truncated || stats.unreadable > 0 ? ['incomplete-index' as const] : []),
  ];
  return {
    kind: 'secret-index',
    observations: (codes.length > 0 ? codes : ['ready' as const]).map((code) =>
      observation(code, 'data'),
    ),
  };
}
