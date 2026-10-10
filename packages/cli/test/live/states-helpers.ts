import { HOST_CAPABILITIES } from '../../src/hosts/capabilities.js';
import { displayState, type DisplayStateInput } from '../../src/live/states.js';
import type { HostResult, LiveOutcome } from '../../src/live/types.js';
import { DIGEST, resultOf } from './helpers.js';

export const CLAUDE = HOST_CAPABILITIES['claude-code'];
export const CURSOR = HOST_CAPABILITIES['cursor'];
export const T0 = new Date('2026-10-10T10:00:00.000Z');
export const T1 = new Date('2026-10-10T10:01:00.000Z');

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

/** A stored result of this state, made of the probes that state comes from. */
export const stored = (state: LiveOutcome, over: Partial<HostResult> = {}): HostResult =>
  resultOf(state, over);

export const stateOf = (over: Partial<DisplayStateInput>): string =>
  displayState(input(over)).state;
