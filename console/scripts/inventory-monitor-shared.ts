import type { InventoryState } from '../lib/inventory.ts';
import {
  INVENTORY_MONITOR_ERRORS,
  type InventoryMonitorError,
  type InventoryMonitorState,
} from '../lib/inventory-monitor.ts';
import type { withAgentConfigurationLock } from './agent-configuration-lock.mjs';

export type MonitorBound = {
  engineVersion: string;
  runtimeSha256: string;
  sourceProfileSha256: string;
};
export type Binding = { home: string; roots: unknown; storeId: string; workspaceId: string };
export type Intent = {
  revision: string;
  record: Binding & MonitorBound & { enabled: boolean; configuredAt: string };
};
export type Lease = { assertCurrent(): Promise<void>; release(): Promise<void> };
export type Timer = ReturnType<typeof setTimeout> | number;
export type MonitorContext = {
  workspaceId: string;
  current(): Promise<MonitorBound>;
  assert(bound: MonitorBound): Promise<void>;
};
export interface MonitorStore {
  readIntent(): Promise<Intent | null>;
  context(): Promise<Binding>;
  updateIntent(
    bound: MonitorBound,
    input: { enabled: boolean; expectedRevision: string | null; configuredAt: string },
    options: { beforeCommit(): Promise<void> },
  ): Promise<Intent>;
  acquireLease(): Promise<Lease | null>;
  appendObservation(
    snapshot: InventoryState,
    bound: MonitorBound,
    input: {
      expectedIntentRevision: string;
      checkId: string;
      observedAt: string;
      beforeCommit(): Promise<void>;
    },
  ): Promise<{ record: { id: string }; latestCheckId: string; latestCaptureId: string }>;
}
export interface InventoryMonitorConfiguration {
  context: MonitorContext;
  store: MonitorStore;
  inventory: { read(): Promise<{ status: number; body: unknown }> };
  now?: () => number;
  setTimeout?: (callback: () => void, milliseconds: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
  withLock?: typeof withAgentConfigurationLock;
}
const finite = new Set<string>(INVENTORY_MONITOR_ERRORS);
export function inventoryMonitorError(error: unknown): InventoryMonitorError {
  const code = (error as Error)?.message;
  return finite.has(code)
    ? (code as InventoryMonitorError)
    : code === 'agent-configuration-busy'
      ? 'workspace-review-busy'
      : 'inventory-unavailable';
}
export const inventoryMonitorFailure = (error: string) => ({
  status:
    error === 'invalid-request'
      ? 400
      : [
            'monitor-store-stale',
            'stale-capture',
            'workspace-review-busy',
            'monitor-preview-expired',
          ].includes(error)
        ? 409
        : error.endsWith('unconfirmed')
          ? 422
          : 503,
  body: { error },
});
export type SchedulerState = Omit<InventoryMonitorState, 'history'>;
