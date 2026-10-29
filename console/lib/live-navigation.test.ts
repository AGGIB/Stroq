import { describe, expect, it } from 'vitest';
import { liveHref, liveReadAllowed, liveSelection, resolveLiveSelection } from './live-navigation';
import type { LiveJob, LiveState } from './live-proof';

const workspace = 'workspace-' + 'a'.repeat(24);
const other = 'workspace-' + 'b'.repeat(24);
const id = '00000000-0000-4000-8000-000000000001';
const job: LiveJob = {
  schema: 'stroq-live-job/1',
  id,
  agent: 'codex',
  maxRequests: 3,
  status: 'failed',
  startedAt: '2026-10-23T01:00:00.000Z',
  finishedAt: '2026-10-23T01:00:02.000Z',
};
const state: LiveState = {
  schema: 'stroq-live/1',
  engine: { available: true, version: '0.28.0' },
  target: 'isolated-host',
  agents: [{ id: 'codex', supported: true, reason: null, proof: null }],
  jobs: [job],
};
const parse = (query: string) => liveSelection(new URLSearchParams(query));

describe('exact isolated check links', () => {
  it('round-trips only a workspace-bound job or known agent', () => {
    const href = liveHref({ jobId: id, workspaceId: workspace });
    expect(href).toBe(`/agents/checks/?workspace=${workspace}&job=${id}`);
    expect(parse(href.split('?')[1]!)).toEqual({
      requested: true,
      invalid: false,
      jobId: id,
      agent: null,
      workspaceId: workspace,
    });
    expect(liveHref({ agent: 'codex', workspaceId: workspace })).toBe(
      `/agents/checks/?workspace=${workspace}&agent=codex`,
    );
    expect(liveHref({ jobId: '../private', workspaceId: workspace })).toBe('/agents/checks/');
    expect(liveHref({ jobId: id, agent: 'codex', workspaceId: workspace })).toBe('/agents/checks/');
  });

  it('rejects empty, duplicate, ambiguous and unbound selections', () => {
    for (const query of [
      'job=',
      `job=${id}`,
      `workspace=${workspace}`,
      `workspace=${workspace}&job=${id}&job=${id}`,
      `workspace=${workspace}&workspace=${other}&job=${id}`,
      `workspace=${workspace}&agent=constructor`,
      `workspace=${workspace}&agent=codex&job=${id}`,
    ])
      expect(parse(query).invalid, query).toBe(true);
    expect(parse('').requested).toBe(false);
  });

  it('does not substitute a newer result for an evicted exact job', () => {
    const selection = parse(`workspace=${workspace}&job=${id}`);
    expect(resolveLiveSelection(selection, state, workspace)).toEqual({ kind: 'job', job });
    expect(
      resolveLiveSelection(
        selection,
        { ...state, jobs: [{ ...job, id: '00000000-0000-4000-8000-000000000002' }] },
        workspace,
      ),
    ).toEqual({ kind: 'missing-job' });
    expect(resolveLiveSelection(selection, null, workspace)).toEqual({ kind: 'loading' });
  });

  it('refuses reads and selection from a different or disconnected workspace', () => {
    const selection = parse(`workspace=${workspace}&job=${id}`);
    expect(liveReadAllowed(selection, other)).toBe(false);
    expect(liveReadAllowed(selection, null)).toBe(false);
    expect(liveReadAllowed(selection, workspace)).toBe(true);
    expect(resolveLiveSelection(selection, state, other)).toEqual({ kind: 'workspace-mismatch' });
    expect(resolveLiveSelection(selection, state, null)).toEqual({ kind: 'disconnected' });
    expect(liveReadAllowed(parse('job='), workspace)).toBe(false);
  });

  it('keeps historical proof distinct from retained job history', () => {
    const selection = parse(`workspace=${workspace}&agent=codex`);
    expect(resolveLiveSelection(selection, state, workspace)).toEqual({ kind: 'missing-proof' });
    const proof = {
      state: 'stale',
      checkedAt: job.startedAt,
      hostVersion: '1.0',
      hostVersionRechecked: false,
      reason: 'host-version-not-checked',
      report: {
        state: 'inconclusive',
        mode: 'live',
        hostVersion: '1.0',
        requestsMade: 1,
        probes: [],
        caveats: [],
        advice: [],
      },
    } as const;
    const withProof = {
      ...state,
      agents: [{ ...state.agents[0]!, proof }],
    } as unknown as LiveState;
    expect(resolveLiveSelection(selection, withProof, workspace)).toEqual({
      kind: 'proof',
      agent: 'codex',
      proof,
    });
    expect(resolveLiveSelection(parse(''), state, workspace)).toEqual({ kind: 'overview' });
  });
});
