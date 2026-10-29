import { isDeepStrictEqual } from 'node:util';
import {
  validateCodexNetworkCheckJob,
  type CodexNetworkCheckJob,
} from '../lib/codex-network-check';
import type { Store, NetworkCheckLease } from './codex-network-check-service-shared';

/** Lease-gated publication, pinned passive rereads, and a sticky failure on uncertain history. */
export function createNetworkCheckJournal(store: Store, workspaceId: string) {
  const valid = (rows: unknown): rows is CodexNetworkCheckJob[] =>
    Array.isArray(rows) &&
    rows.length <= 32 &&
    rows.every((j) => validateCodexNetworkCheckJob(j) && j.binding.workspaceId === workspaceId) &&
    new Set(rows.map((j) => j.id)).size === rows.length &&
    rows.filter((j) => j.status === 'running').length <= 1;
  let failed = !valid(store.runs),
    expected: CodexNetworkCheckJob[] = failed
      ? []
      : (structuredClone(store.runs) as CodexNetworkCheckJob[]),
    publishing = false;
  const ready = () => !failed && store.state().status === 'ready';
  const latch = () => {
    failed = true;
  };
  return {
    initial: structuredClone(expected),
    ready,
    latch,
    async refresh(owned = false): Promise<CodexNetworkCheckJob[] | null> {
      try {
        if (!ready()) throw Error('history-unavailable');
        if (owned && publishing) return structuredClone(expected);
        const rows = await store.refresh();
        if (!valid(rows) || (owned && !isDeepStrictEqual(rows, expected)))
          throw Error('history-changed');
        expected = structuredClone(rows);
        return structuredClone(rows);
      } catch {
        latch();
        return null;
      }
    },
    async publish(rows: CodexNetworkCheckJob[], lease: NetworkCheckLease): Promise<boolean> {
      if (publishing) {
        latch();
        return false;
      }
      publishing = true;
      try {
        if (!ready() || !valid(rows)) throw Error('history-unavailable');
        await lease.assertCurrent();
        const fresh = await store.refresh();
        if (!valid(fresh) || !isDeepStrictEqual(fresh, expected)) throw Error('history-changed');
        if (!(await store.write(structuredClone(rows)))) throw Error('write-failed');
        expected = structuredClone(rows);
        await lease.assertCurrent();
        return true;
      } catch {
        latch();
        return false;
      } finally {
        publishing = false;
      }
    },
  };
}
