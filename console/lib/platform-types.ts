import type { Check, Decision, GuardState } from './status';

export type AgentName = 'Claude Code' | 'Cursor' | 'Codex CLI' | 'Unknown host';

/** One recorded decision, in the shape the local journal snapshot uses. */
export interface ToolCall {
  readonly sessionId?: string;
  /** Exact captured journal-line digest when supported; not an authenticity claim. */
  readonly evidenceSha?: string;
  readonly id: string;
  readonly decision: Decision;
  readonly label: string;
  readonly raw: string;
  readonly agent: AgentName;
  /** ISO date, so two Tuesdays a week apart stay two days. */
  readonly date: string;
  readonly time: string;
  readonly rule?: string;
  readonly reason?: string;
}

export interface Agent {
  readonly id: string;
  readonly name: AgentName;
  readonly version: string;
  readonly state: GuardState;
  /** Stroq in its hooks, hooks call Stroq, blocking tested, test still current. */
  readonly checks: readonly [Check, Check, Check, Check];
  readonly next?: string;
}
