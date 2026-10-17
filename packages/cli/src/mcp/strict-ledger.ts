import { keyOf, type JsonRpcId } from './framing.js';
import { STRICT_CANCELLED_MEMORY, STRICT_MAX_TRACKED } from './strict-limits.js';

/**
 * Every request the client has sent and the server has not yet answered, for strict
 * mode. The default proxy remembers only the requests whose results it scans, which is
 * enough to know what to scan and not enough to know what NOT to forward: a response to
 * `initialize` or `ping` is simply absent from its table, so it cannot tell that from a
 * response nobody asked for. Strict mode needs the second answer, so it keeps this
 * ledger of all of them, with the id each was sent under (to be able to answer it).
 */
export interface TrackedRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  /** The `mcp__<server>__<tool>` name the request is audited and scanned under. */
  readonly toolName: string;
}

/** The key a response id would have under the other type, when the two spell the same value. */
function otherTypeKey(id: JsonRpcId): string | null {
  if (typeof id === 'number') return `s:${id}`;
  const asNumber = Number(id);
  return Number.isFinite(asNumber) && String(asNumber) === id ? `n:${asNumber}` : null;
}

export class StrictLedger {
  private readonly entries = new Map<string, TrackedRequest>();
  private readonly cancelled = new Set<string>();

  get size(): number {
    return this.entries.size;
  }

  /** A client reusing an id still pending overwrites its entry, as the default table does. */
  track(request: TrackedRequest): void {
    const key = keyOf(request.id);
    this.cancelled.delete(key);
    this.entries.set(key, request);
    // A Map iterates in insertion order: the first key is the oldest request.
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= STRICT_MAX_TRACKED) break;
      this.entries.delete(oldest);
    }
  }

  /** The request for `id`, removed: a request is answered exactly once. */
  take(id: JsonRpcId): TrackedRequest | undefined {
    const key = keyOf(id);
    const request = this.entries.get(key);
    if (request !== undefined) this.entries.delete(key);
    return request;
  }

  /** The request a response id of the wrong TYPE was evidently meant for (`"3"` for `3`), left in place. */
  mismatched(id: JsonRpcId): TrackedRequest | undefined {
    const key = otherTypeKey(id);
    return key === null ? undefined : this.entries.get(key);
  }

  /** The client cancelled `id`: it will ignore an answer, so one that still arrives is not a violation. */
  cancel(id: JsonRpcId): void {
    const key = keyOf(id);
    if (!this.entries.delete(key)) return;
    this.cancelled.add(key);
    for (const oldest of this.cancelled) {
      if (this.cancelled.size <= STRICT_CANCELLED_MEMORY) break;
      this.cancelled.delete(oldest);
    }
  }

  /** True once per cancelled id: the late answer is dropped without counting against the server. */
  takeCancelled(id: JsonRpcId): boolean {
    return this.cancelled.delete(keyOf(id));
  }

  /** Everything still waiting, oldest first, leaving the ledger empty. */
  drain(): TrackedRequest[] {
    const all = [...this.entries.values()];
    this.entries.clear();
    return all;
  }
}
