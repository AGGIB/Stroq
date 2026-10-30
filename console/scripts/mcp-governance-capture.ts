import type {
  McpGovernanceChoice,
  McpGovernanceChannel,
  McpGovernanceCapture,
  McpGovernanceSourceRef,
} from '../lib/mcp-governance-types.ts';
import type { ProxyRuntime } from './mcp-containment-proxy.ts';
import { captureGovernanceRegistrations, governanceGap } from './mcp-governance-capture-sources.ts';
import {
  governanceHash,
  governanceNameEligibility,
  governancePairSummary,
  governanceProxyPair,
  governanceRegistration,
  type GovernancePair,
} from './mcp-governance-capture-policy.ts';

/** All inputs are server-selected context. Browser selections carry only id and expectedSha256. */
export interface McpGovernanceCaptureOptions {
  project: string;
  userHome: string;
  home: string;
  platform: NodeJS.Platform;
  mcpEnvironment: Readonly<Record<string, string | undefined>>;
  codexEnvironment?: Readonly<{ CODEX_HOME?: string }>;
  contextId: string;
  policyFingerprint: string;
  proxyRuntime?: ProxyRuntime;
}
type WorkingChoice = {
  pair: GovernancePair | null;
  choice: Omit<McpGovernanceChoice, 'id' | 'expectedSha256'>;
  key: string;
};
/** Fixed-path metadata capture only: no RPC, binary, server, credential file, or config writes. */
export async function captureMcpGovernanceSources(
  options: McpGovernanceCaptureOptions,
  currentAllowed: readonly GovernancePair[],
) {
  if (currentAllowed.length > 64) throw Error('mcp-governance-invalid');
  const captured = await captureGovernanceRegistrations(options);
  const stamp = {
    schema: 'stroq-mcp-governance-sources/1',
    contextId: options.contextId,
    policyFingerprint: options.policyFingerprint,
    project: captured.project,
    userHome: captured.user,
    home: captured.home,
    platform: options.platform,
    selectors: {
      APPDATA: options.mcpEnvironment.APPDATA ?? null,
      XDG_CONFIG_HOME: options.mcpEnvironment.XDG_CONFIG_HOME ?? null,
      CODEX_HOME: options.codexEnvironment?.CODEX_HOME ?? null,
    },
    runtime: options.proxyRuntime ?? null,
    sourcePins: captured.pins,
    allowed: [...currentAllowed].sort((a, b) => governanceHash(a).localeCompare(governanceHash(b))),
  };
  const sha256 = governanceHash(stamp),
    gaps = [...captured.gaps],
    rows = new Map<string, WorkingChoice>();
  const add = (
    pair: GovernancePair | null,
    ref: McpGovernanceSourceRef,
    eligibility: McpGovernanceChoice['eligibility'],
    reason: McpGovernanceChoice['reason'],
    name: string,
  ) => {
    const key = pair === null ? governanceHash({ source: ref.id, name }) : governanceHash(pair);
    const known = rows.get(key);
    if (known) {
      if (!known.choice.sourceRefs.some((r) => r.id === ref.id)) known.choice.sourceRefs.push(ref);
      return;
    }
    if (rows.size >= 192) {
      gaps.push(governanceGap(null, 'source-limit'));
      return;
    }
    rows.set(key, {
      pair,
      key,
      choice: {
        pair: pair === null ? null : governancePairSummary(pair),
        kind: 'registration',
        sourceRefs: [ref],
        eligibility,
        reason,
        inAllowSet: false,
      },
    });
  };
  const addPair = (pair: GovernancePair, ref: McpGovernanceSourceRef) => {
    const state = governanceNameEligibility(pair);
    add(pair, ref, state.eligibility, state.reason, pair.name);
    if (state.eligibility !== 'eligible')
      gaps.push(
        governanceGap(
          { ...ref, sourceId: ref.sourceId },
          state.eligibility === 'ambiguous' ? 'identity-ambiguous' : 'identity-unsupported',
        ),
      );
  };
  for (const registration of captured.registrations) {
    const { name, entry, ref } = registration;
    if (!governanceRegistration(entry)) {
      add(null, ref, 'unavailable', 'missing-identity', name);
      gaps.push(governanceGap(ref, 'identity-unknown'));
      continue;
    }
    if (ref.agent === 'claude-desktop') {
      add(null, ref, 'unsupported', 'unsupported-agent', name);
      gaps.push(governanceGap(ref, 'source-unsupported'));
    } else addPair({ channel: ref.agent as McpGovernanceChannel, name }, ref);
    const proxy = governanceProxyPair(
      entry,
      options.proxyRuntime,
      captured.home,
      captured.user.path,
    );
    if (proxy.gap) gaps.push(governanceGap(ref, proxy.gap));
    if (proxy.pair !== null) addPair(proxy.pair, ref);
  }
  for (const pair of currentAllowed) {
    const key = governanceHash(pair),
      found = rows.get(key);
    if (found) {
      found.choice.kind = 'both';
      found.choice.inAllowSet = true;
      found.choice.eligibility = 'eligible';
      found.choice.reason = null;
    } else
      rows.set(key, {
        pair: { ...pair },
        key,
        choice: {
          pair: governancePairSummary(pair),
          kind: 'retained',
          sourceRefs: [],
          eligibility: 'eligible',
          reason: null,
          inAllowSet: true,
        },
      });
  }
  // Current policy rows stay removable even when registrations hit the fixed capture ceiling.
  const ordered = [...rows.values()]
    .sort(
      (a, b) =>
        Number(b.choice.inAllowSet) - Number(a.choice.inAllowSet) || a.key.localeCompare(b.key),
    )
    .slice(0, 192);
  if (rows.size > 192) gaps.push(governanceGap(null, 'source-limit'));
  const choices: McpGovernanceChoice[] = [],
    privateChoices: { id: string; pair: GovernancePair }[] = [];
  for (const row of ordered) {
    const id = `choice-${governanceHash({ contextId: options.contextId, key: row.key })}`;
    choices.push({
      id,
      expectedSha256: governanceHash({ captureSha256: sha256, key: row.key }),
      ...row.choice,
    });
    if (row.pair !== null && row.choice.eligibility === 'eligible')
      privateChoices.push({ id, pair: { ...row.pair } });
  }
  const uniqueGaps = [
    ...new Map(gaps.map((gap) => [governanceHash(gap), gap])).values(),
  ] as McpGovernanceCapture['gaps'];
  return { sha256, choices, privateChoices, gaps: uniqueGaps, stamp };
}
