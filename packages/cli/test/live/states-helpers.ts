import { HOST_CAPABILITIES } from '../../src/hosts/capabilities.js';
import { displayState, type DisplayStateInput } from '../../src/live/states.js';
import type { HostResult, LiveOutcome } from '../../src/live/types.js';
import { DIGEST, resultOf } from './helpers.js';

export const CLAUDE = HOST_CAPABILITIES['claude-code'];
export const CURSOR = HOST_CAPABILITIES['cursor'];
/** The proxy of MCP, which is checked without any host and so has no host version to know. */
export const MCP = HOST_CAPABILITIES['mcp'];
export const T0 = new Date('2026-10-10T10:00:00.000Z');
export const T1 = new Date('2026-10-10T10:01:00.000Z');
/** When a stored check was made unless a test says otherwise: after the install and the calls above. */
export const STORED_AT = '2026-10-10T12:00:00.000Z';
/** A moment after the stored check was made, for an install that came later. */
export const AFTER_CHECK = new Date('2026-10-10T13:00:00.000Z');

export const input = (over: Partial<DisplayStateInput> = {}): DisplayStateInput => ({
  capabilities: CLAUDE,
  installed: { installed: true, changed: false },
  stampAt: null,
  installRecordedAt: null,
  stored: null,
  stroqVersion: '0.23.0',
  policySha256: DIGEST,
  hostVersion: '2.1.271',
  ...over,
});

/** A stored result of this state, made of the probes that state comes from, after the install. */
export const stored = (state: LiveOutcome, over: Partial<HostResult> = {}): HostResult =>
  resultOf(state, { at: STORED_AT, ...over });

export const stateOf = (over: Partial<DisplayStateInput>): string =>
  displayState(input(over)).state;
