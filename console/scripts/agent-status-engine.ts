// Pure adapter to the CLI's current installation templates and proof validator.
// No config is written and no agent is started from this module.
import { mergeHooks } from '../../packages/cli/src/commands/init.js';
import { mergeCursorHooks } from '../../packages/cli/src/commands/cursor-hooks.js';
import {
  mergeCodexHooks,
  codexApprovedHooks,
} from '../../packages/cli/src/commands/codex-hooks.js';
import { capabilitiesFor } from '../../packages/cli/src/hosts/capabilities.js';
import { displayState } from '../../packages/cli/src/live/states.js';
import { parseHostResult } from '../../packages/cli/src/live/types.js';
import { policySha256 } from '../../packages/cli/src/live/policy-digest.js';
import { DEFAULT_POLICY, PolicySchema } from '@stroq/core';
import { parseDocument } from 'yaml';
import { transformAgentDisconnect } from './agent-disconnect-transform.js';
import { transformAgentSetup } from './agent-setup-transform.js';
export { parseSetupObject } from './agent-setup-transform.js';

export function prepareAgentSetup(
  text: string | Uint8Array | null,
  agent: string,
  command: string,
) {
  return transformAgentSetup(text, agent, expectedConfiguration(agent, command));
}

export function prepareAgentDisconnect(text: string | null, agent: string, command: string) {
  return transformAgentDisconnect(text, agent, expectedConfiguration(agent, command));
}

export function expectedConfiguration(agent: string, command: string) {
  switch (agent) {
    case 'claude-code':
      return mergeHooks({}, command);
    case 'cursor':
      return mergeCursorHooks({}, command);
    case 'codex':
      return mergeCodexHooks({}, command);
    default:
      throw new Error('unsupported-agent');
  }
}

/** Zero approvals proves approval is required; another hook's hash cannot prove ours is approved. */
export function codexApproval(text: string | null): 'required' | 'unknown' {
  return text === null || codexApprovedHooks(text) === 0 ? 'required' : 'unknown';
}

export function policyFingerprint(text: string | null): string | null {
  try {
    if (text === null) return policySha256(DEFAULT_POLICY);
    const document = parseDocument(text);
    if (document.errors.length) return null;
    const parsed = PolicySchema.safeParse(document.toJS({ maxAliasCount: 0 }));
    return parsed.success ? policySha256(parsed.data) : null;
  } catch {
    return null;
  }
}

interface ProofInput {
  agent: string;
  raw: unknown;
  present: boolean;
  changed: boolean;
  recordedAt: string | null;
  stampAt: string | null;
  version: string | null;
  policy: string | null;
  now: number;
}

/** The host version is deliberately unknown: this endpoint never starts the host. */
export function projectProof(input: ProofInput) {
  const capability = capabilitiesFor(input.agent);
  const empty = {
    scope: 'machine',
    state: 'missing',
    checkedAt: null,
    hostVersion: null,
    freshness: 'not-checked',
    reason: 'no-live-proof',
  };
  if (capability?.headless !== true)
    return { ...empty, state: 'unsupported', reason: 'no-live-driver' };
  if (input.raw === null) return empty;
  const parsed = parseHostResult(input.raw);
  if (
    !parsed.ok ||
    parsed.result.agent !== input.agent ||
    parsed.result.mode !== 'live' ||
    !['verified', 'failed'].includes(parsed.result.state) ||
    Date.parse(parsed.result.at) > input.now + 5 * 60_000
  )
    return { ...empty, state: 'invalid', reason: 'proof-invalid', freshness: 'unknown' };
  const stored = parsed.result;
  const base = {
    ...empty,
    checkedAt: stored.at,
    // The parser bounds this, and the browser never needs a vendor's free-form build string.
    hostVersion:
      stored.hostVersion !== null && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(stored.hostVersion)
        ? stored.hostVersion
        : null,
  };
  if (input.version === null || input.policy === null)
    return {
      ...base,
      state: stored.state === 'failed' ? 'failed' : 'stale',
      freshness: 'unknown',
      reason: 'current-context-unavailable',
    };
  const changed =
    !input.present ||
    input.changed ||
    stored.stroqVersion !== input.version ||
    stored.policySha256 !== input.policy ||
    (input.recordedAt !== null && Date.parse(input.recordedAt) > Date.parse(stored.at));
  const shown = displayState({
    capabilities: capability,
    installed: { installed: input.present, changed: input.changed },
    stampAt: input.stampAt === null ? null : new Date(input.stampAt),
    installRecordedAt: input.recordedAt === null ? null : new Date(input.recordedAt),
    stored,
    stroqVersion: input.version,
    policySha256: input.policy,
    hostVersion: null,
  });
  return {
    ...base,
    state: shown.state,
    freshness: changed ? 'changed' : 'host-version-unknown',
    reason:
      stored.state === 'failed'
        ? 'live-check-failed'
        : changed
          ? 'proof-context-changed'
          : 'host-version-not-checked',
  };
}
