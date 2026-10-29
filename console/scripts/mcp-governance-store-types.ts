import type { McpGovernanceBinding, McpGovernanceHistoryRef } from '../lib/mcp-governance-types.ts';

export interface GovernanceDirectoryPin {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
}
export interface GovernanceRootPin extends GovernanceDirectoryPin {
  path: string;
}
export interface GovernanceStagedPin extends GovernanceDirectoryPin {
  nlink: number;
  size: number;
  mtimeMs: number;
}
export interface GovernanceFilePin extends GovernanceStagedPin {
  ctimeMs: number;
}
export interface McpGovernanceStagedProof {
  file: GovernanceStagedPin;
  parents: GovernanceDirectoryPin[];
  sha256: string;
}
/** Derived metadata only. No policy/configuration bytes, labels, arguments or paths. */
export interface McpGovernanceIntent {
  schema: 'stroq-mcp-governance-intent/1';
  id: string;
  operationId: string;
  binding: McpGovernanceBinding;
  createdAt: string;
  updatedAt: string;
  candidateRawSha256: string;
  candidateFingerprint: string;
  beforePolicy: {
    rawSha256: string | null;
    fingerprint: string;
    file: GovernanceFilePin | null;
    parents: GovernanceDirectoryPin[];
  };
  phase: 'prepared' | 'staged' | 'applied' | 'not-applied';
  staged: McpGovernanceStagedProof | null;
  historyRef: McpGovernanceHistoryRef | null;
  terminalSource: null | 'apply' | 'recheck';
}
export interface McpGovernanceStoreEntry {
  intent: McpGovernanceIntent;
  revision: string;
}
export interface McpGovernanceStoreRead {
  status: 'missing' | 'ready' | 'unavailable';
  records: McpGovernanceStoreEntry[];
  revision: string | null;
}
export interface McpGovernanceStoreLease {
  /** Exact newly created selected Stroq home; null when it already existed. */
  readonly createdHome: GovernanceRootPin | null;
  assertCurrent(): Promise<void>;
}
export type McpGovernanceIntentPatch = Partial<
  Pick<McpGovernanceIntent, 'phase' | 'staged' | 'historyRef' | 'terminalSource'>
>;
export interface McpGovernanceStoreOptions {
  home: string;
  contextId: string;
  workspaceId: string;
  now?: () => number;
}
export interface McpGovernanceStore {
  read(): Promise<McpGovernanceStoreRead>;
  withLease<T>(
    options: { operationId: string; explicitRecovery?: boolean },
    action: (lease: McpGovernanceStoreLease) => Promise<T>,
  ): Promise<T>;
  create(
    intent: McpGovernanceIntent,
    lease: McpGovernanceStoreLease,
  ): Promise<McpGovernanceStoreEntry>;
  update(
    id: string,
    expectedRevision: string,
    patch: McpGovernanceIntentPatch,
    lease: McpGovernanceStoreLease,
  ): Promise<McpGovernanceStoreEntry>;
}
