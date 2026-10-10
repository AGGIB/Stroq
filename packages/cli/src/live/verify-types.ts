// What `verifyHost` is spoken to in: the options of a run, the directories it is given, and where its ids
// come from. Kept apart from the code so that the requests of a run and the run itself can both name them.
import type { Policy } from '@stroq/core';
import type { HostCapability } from '../hosts/capabilities.js';
import type { Ledger } from './budget.js';
import type { ProbeContext } from './types.js';

/** Where the ids of a request come from. A test gives its own so that a failure can name a request. */
export interface IdSource {
  nonce(): string;
  session(): string;
  fake(): string;
}

export interface VerifyOptions {
  /** The agent id, as `HOOK_ROWS` in doctor.ts spells it. */
  readonly agent: string;
  /** The policy in force: what each probe is expected to be decided as, and what the hook is given. */
  readonly policy: Policy;
  readonly stroqVersion: string;
  readonly ledger: Ledger;
  /**
   * Run each deny that was stopped again with a hook that allows everything. On unless it is turned off
   * with `false`, because a deny that "did not happen" proves nothing until the same command is shown to
   * happen without the hook: with the control off no host is ever verified, and the denies that were
   * stopped are `deny-not-proven-armed`.
   */
  readonly control?: boolean | undefined;
  /**
   * What produced the answers. The result is live only if the driver says it is (`mode: 'live'`) and
   * this does not say it is a stand-in: a driver that does not say what it is makes a stand-in, and this
   * cannot make a stand-in live.
   */
  readonly mode?: 'live' | 'stand-in' | undefined;
  /** The most host requests this run may make, on top of what the ledger allows. */
  readonly maxRequests?: number | undefined;
  /** What the host table says of the agent; by default its entry for `agent`. */
  readonly capabilities?: HostCapability | undefined;
  readonly now?: (() => Date) | undefined;
  readonly ids?: Partial<IdSource> | undefined;
  /** How long past a request's deadline a driver that has not answered is waited for. */
  readonly graceMs?: number | undefined;
  /** How long a driver is given to say whether its host is there. */
  readonly detectMs?: number | undefined;
}

/** The directories and limits of a run. The session, nonce and hook mode are made for each request. */
export type BaseContext = Omit<ProbeContext, 'sessionId' | 'nonce' | 'hookMode'> &
  Partial<Pick<ProbeContext, 'sessionId' | 'nonce' | 'hookMode'>>;
