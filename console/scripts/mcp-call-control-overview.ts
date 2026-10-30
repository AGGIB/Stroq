import type {
  McpCallControlOverview,
  McpCallControlOverviewRow,
} from '../lib/mcp-call-control-overview.ts';
import {
  readMcpCallControlRegistrations,
  selectMcpCallControl,
  type CallControlOptions,
} from './mcp-call-control-registrations.ts';
import { readMcpCallControlObservations } from './mcp-call-control-observation.ts';
import { readRetainedCallControlSetups } from './mcp-call-control-setup.ts';
import { binding } from './mcp-containment-files.mjs';
const emptyObservation = () => ({
  status: 'unobserved' as const,
  at: null,
  eventId: null,
  invocationSha256: null,
  reason: null,
});

/** One source/native/audit capture. A retained pause remains reachable after configuration removal. */
export async function readMcpCallControlOverview(
  options: CallControlOptions,
): Promise<McpCallControlOverview> {
  const scan = await readMcpCallControlRegistrations(options),
    now = (options.now ?? Date.now)();
  let fingerprint = '';
  try {
    const value = await options.runtimeDigest();
    if (/^[a-f0-9]{64}$/.test(value)) fingerprint = value;
  } catch {}
  const observations = await readMcpCallControlObservations(
      scan.home,
      scan.snapshot?.controls ?? [],
      now,
    ),
    retained = await readRetainedCallControlSetups(scan.ctx),
    records = retained.records.filter((r) => r.manifest.contextId === scan.contextId),
    controls = new Map<string, McpCallControlOverviewRow>(),
    gaps: McpCallControlOverview['gaps'] = [...scan.gaps];
  if (!fingerprint) gaps.push('runtime-unavailable');
  if (!retained.available) gaps.push('setup-unavailable');
  const rowFor = (controlId: string): McpCallControlOverviewRow => ({
    controlId,
    artifact: null,
    retainedSetupId: null,
    proxyWorkspaceId: null,
    invocationSha256: null,
    capability: 'missing-registration',
    reason: null,
    current: scan.snapshot?.controls.find((c) => c.controlId === controlId) ?? null,
    observation: observations.get(controlId) ?? emptyObservation(),
    setup: 'none',
    setupConfiguration: null,
    setupCandidate: null,
  });
  for (const c of scan.snapshot?.controls ?? []) controls.set(c.controlId, rowFor(c.controlId));
  for (const record of records) {
    const m = record.manifest,
      row = controls.get(m.controlId) ?? rowFor(m.controlId);
    // Multiple records for one slot cannot become an automatic recovery selector.
    const duplicate = row.retainedSetupId !== null;
    const source = scan.rows.find(
      (r) =>
        r.source.source === m.sourceType &&
        r.source.relativePath === m.relativePath &&
        binding(r.source.root) === m.sourceRootBinding,
    );
    controls.set(m.controlId, {
      ...row,
      artifact: m.artifact,
      proxyWorkspaceId: m.proxyWorkspaceId,
      invocationSha256: row.current?.invocationSha256 ?? m.invocationSha256,
      retainedSetupId: duplicate ? null : m.operationId,
      setup: m.phase,
      setupConfiguration: source
        ? source.capture.sha256 === m.candidateSha256 && source.capture.mode === m.mode
          ? 'confirmed'
          : 'unconfirmed'
        : 'unavailable',
      setupCandidate:
        m.phase === 'configuration-confirmed' || duplicate
          ? null
          : {
              operationId: m.operationId,
              artifact: m.artifact,
              invocationSha256: m.invocationSha256,
            },
      ...(duplicate
        ? { capability: 'ambiguous' as const, reason: 'duplicate-control' as const }
        : {}),
    });
  }
  const visible = new Set<string>();
  for (const source of scan.rows.filter((r) => r.controlId !== null)) {
    const id = source.controlId!;
    if (visible.has(id)) continue;
    visible.add(id);
    const prior = controls.get(id) ?? rowFor(id);
    try {
      const { inspection: i } = await selectMcpCallControl(
        options,
        { id: source.id, expectedSha256: source.sha256! },
        undefined,
        { scan, fingerprint, observations },
      );
      controls.set(id, {
        ...prior,
        artifact: i.artifact,
        proxyWorkspaceId: i.proxyWorkspaceId ?? prior.proxyWorkspaceId,
        invocationSha256: i.invocationSha256,
        capability: i.capability,
        reason: i.reason,
        current: i.current,
        observation: i.observation,
      });
    } catch {
      controls.set(id, { ...prior, capability: 'unavailable', reason: 'source-unavailable' });
    }
  }
  return {
    schema: 'stroq-mcp-call-controls/1',
    workspaceId: scan.ctx.workspaceId,
    contextId: scan.contextId,
    checkedAt: new Date(now).toISOString(),
    authority: scan.snapshot?.history ?? 'unavailable',
    revision: scan.snapshot?.revision ?? null,
    gaps,
    controls: [...controls.values()].sort((a, b) => a.controlId.localeCompare(b.controlId)),
    hostEnforcement: false,
  };
}
