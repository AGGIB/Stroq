import { HOST_CAPABILITIES } from '../../src/hosts/capabilities.js';
import { displayState, type DisplayStateInput } from '../../src/live/states.js';
import type { HostResult, LiveOutcome, ProbeResult } from '../../src/live/types.js';
import { DIGEST, passedProbe, validResult } from './helpers.js';

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

export const failedProbe: ProbeResult = {
  id: 'deny',
  kind: 'deny',
  mark: 'failed',
  reason: 'executed-despite-deny',
  evidence: { E1: true, E2: true, E3: false, E4: false },
};
export const unsure = (id: string, kind: ProbeResult['kind'], reason: string): ProbeResult => ({
  id,
  kind,
  mark: 'inconclusive',
  reason,
  evidence: { E1: false, E2: false, E3: false, E4: null },
});
export const stored = (state: LiveOutcome, over: Partial<HostResult> = {}): HostResult =>
  validResult({
    state,
    probes:
      state === 'failed'
        ? [passedProbe(), failedProbe]
        : state === 'verified'
          ? [passedProbe()]
          : [unsure('allow', 'allow', 'limit'), unsure('deny', 'deny', 'timeout')],
    ...over,
  });

export const stateOf = (over: Partial<DisplayStateInput>): string =>
  displayState(input(over)).state;
