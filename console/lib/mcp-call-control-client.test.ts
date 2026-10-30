import { describe, expect, it } from 'vitest';
import { mcpCallControlHarness } from './mcp-call-control-client-harness';
import {
  callArtifact,
  callContext,
  callInspection,
  callPreview,
  callReceipt,
  callRecheck,
  callUuid,
  callOverview,
  callWorkspace,
} from './mcp-call-control-fixtures';

function client() {
  const h = mcpCallControlHarness(),
    c: any = {
      inspection: callInspection(),
      preview: callPreview(),
      receipt: callReceipt(),
      recheck: callRecheck(),
      fail: '',
    };
  h.props.target = { kind: 'source', id: callArtifact.id, expectedSha256: callArtifact.sha256 };
  h.handler = async (path) => {
    const op = path.split('/').at(-1);
    if (c.fail === op) throw Error('PRIVATE_DIAGNOSTIC');
    return c[op === 'inspect' ? 'inspection' : op === 'apply' ? 'receipt' : op!];
  };
  h.render();
  return { h, c };
}
async function prepare(h: ReturnType<typeof mcpCallControlHarness>) {
  await h.flush();
  await h.output.prepare('pause');
  await h.flush();
  expect(h.output.preview).not.toBeNull();
  h.output.acknowledge('scope', true);
  await h.flush();
}
describe('actual MCP call control hook', () => {
  it('inspects without a write and requires explicit scope consent for one pause', async () => {
    const { h } = client();
    await h.flush();
    expect(h.calls.map((x) => x.path)).toEqual(['/api/mcp-call-controls/inspect']);
    await h.output.prepare('pause');
    await h.flush();
    await h.output.apply();
    expect(h.calls.some((x) => x.path.endsWith('/apply'))).toBe(false);
    h.output.acknowledge('scope', true);
    await h.flush();
    await h.output.apply();
    await h.flush();
    expect(h.calls.filter((x) => x.path.endsWith('/apply'))).toHaveLength(1);
    expect(h.output.receipt?.authority).toBe('confirmed');
    expect(h.output.needsRecheck).toBe(false);
  });
  it('retains the candidate before held IO, survives unmount and never retries automatically', async () => {
    const { h, c } = client();
    await prepare(h);
    let release!: (v: unknown) => void;
    h.handler = async (path) =>
      path.endsWith('/apply')
        ? new Promise((r) => (release = r))
        : c[path.endsWith('/inspect') ? 'inspection' : path.split('/').at(-1)!];
    const running = h.output.apply();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    h.unmount();
    release(callReceipt());
    await running;
    h.remount();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    expect(h.calls.filter((x) => x.path.endsWith('/apply'))).toHaveLength(1);
    await h.output.recheck(callUuid(4));
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
  });
  it('ordinary refresh never releases unknown completion and exact recheck rejects foreign profile evidence', async () => {
    const { h, c } = client();
    await prepare(h);
    c.fail = 'apply';
    await h.output.apply();
    await h.flush();
    expect(h.output.error).not.toContain('PRIVATE_DIAGNOSTIC');
    await h.output.refresh();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    c.recheck = { ...callRecheck(), contextId: 'context-' + '2'.repeat(64) };
    await h.output.recheck(callUuid(4));
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    expect(h.calls.at(-1)?.body).toMatchObject({
      expectedContextId: callContext,
      operationId: callUuid(4),
    });
  });
  it('keeps pending bound to stable artifact across setup SHA change', async () => {
    const { h, c } = client();
    c.inspection = {
      ...callInspection(),
      capability: 'setup-required',
      configuration: 'plain',
      current: null,
      controlId: null,
      revision: null,
    };
    c.preview = { ...callPreview('setup'), expectedRevision: null };
    c.receipt = { ...callReceipt(c.preview), configuration: 'unconfirmed' };
    await h.flush();
    await h.output.refresh();
    await h.flush();
    await h.output.prepare('setup');
    await h.flush();
    for (const key of ['scope', 'storage']) h.output.acknowledge(key, true);
    await h.flush();
    await h.output.apply();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    h.props.target = { ...h.props.target, expectedSha256: '3'.repeat(64) };
    c.inspection = {
      ...callInspection(),
      artifact: { ...callArtifact, sha256: '3'.repeat(64) },
      current: { ...callInspection().current, mode: 'paused' },
    };
    h.render();
    await h.flush();
    expect(h.output.pending).toHaveLength(1);
    expect(h.output.pending[0].preview.artifact.sha256).toBe(callArtifact.sha256);
  });
  it('does not accept late preview after selection changes or timeout', async () => {
    const { h, c } = client();
    await h.flush();
    let release!: (v: unknown) => void;
    h.handler = async (path) =>
      path.endsWith('/preview') ? new Promise((r) => (release = r)) : c.inspection;
    const run = h.output.prepare('pause');
    await h.flush();
    h.props.target = {
      kind: 'source',
      id: 'item-' + '9'.repeat(24),
      expectedSha256: callArtifact.sha256,
    };
    h.render();
    await h.flush();
    release(callPreview());
    await run;
    await h.flush();
    expect(h.output.preview).toBeNull();
    expect(h.calls.some((x) => x.path.endsWith('/apply'))).toBe(false);
  });
  it('distinguishes recorded candidate from a later current decision', async () => {
    const { h, c } = client();
    await prepare(h);
    c.fail = 'apply';
    await h.output.apply();
    await h.flush();
    c.recheck = { ...callRecheck(), currentEventId: callUuid(9), currentMode: 'enabled' };
    await h.output.recheck(callUuid(4));
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
    expect(h.output.rechecked?.recordedEventId).toBe(callUuid(4));
    expect(h.output.rechecked?.currentEventId).toBe(callUuid(9));
    expect(h.output.receipt).toBeNull();
  });
  it('point-in-time absence and unavailable recheck never release a candidate or allow a retry', async () => {
    const { h, c } = client();
    await prepare(h);
    c.fail = 'apply';
    await h.output.apply();
    await h.flush();
    for (const authority of ['absent', 'unavailable']) {
      c.recheck = {
        ...callRecheck(),
        authority,
        recordedEventId: null,
        currentEventId: callUuid(2),
        currentMode: 'enabled',
      };
      await h.output.recheck(callUuid(4));
      await h.flush();
      expect(h.output.needsRecheck).toBe(true);
      await h.output.prepare('pause');
      await h.flush();
      expect(h.output.preview).toBeNull();
    }
    expect(h.calls.filter((x) => x.path.endsWith('/apply'))).toHaveLength(1);
  });
  it('timeout fences a late confirmation and leaves explicit recheck after remount', async () => {
    const { h } = client();
    await prepare(h);
    let release!: (v: unknown) => void;
    h.handler = async () => new Promise((r) => (release = r));
    const run = h.output.apply();
    await h.flush();
    await h.advance(60_001);
    expect(h.output.busy).toBeNull();
    expect(h.output.needsRecheck).toBe(true);
    release(callReceipt());
    await run;
    await h.flush();
    expect(h.output.receipt).toBeNull();
    expect(h.output.needsRecheck).toBe(true);
  });
  it('recovery selection retains unknown candidates without inspecting an absent source', async () => {
    const { h, c } = client();
    await prepare(h);
    c.fail = 'apply';
    await h.output.apply();
    await h.flush();
    h.props.target = { kind: 'recovery', id: callArtifact.id, contextId: callContext };
    const before = h.calls.length;
    h.render();
    await h.flush();
    expect(h.calls).toHaveLength(before);
    expect(h.output.pending).toHaveLength(1);
    await h.output.recheck(callUuid(4));
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
  });
  it('resume is withheld until a separate weakening consent is given', async () => {
    const { h, c } = client();
    await h.flush();
    c.inspection = {
      ...callInspection(),
      current: { ...callInspection().current, mode: 'paused' },
    };
    c.preview = callPreview('resume');
    c.receipt = callReceipt(c.preview);
    await h.output.refresh();
    await h.flush();
    await h.output.prepare('resume');
    await h.flush();
    h.output.acknowledge('scope', true);
    await h.flush();
    await h.output.apply();
    expect(h.calls.filter((x) => x.path.endsWith('/apply'))).toHaveLength(0);
    h.output.acknowledge('weakening', true);
    await h.flush();
    await h.output.apply();
    await h.flush();
    expect(h.calls.filter((x) => x.path.endsWith('/apply'))).toHaveLength(1);
  });
  it('seeds one verified retained control without source reads and permits only emergency Pause across changed source SHA', async () => {
    const h = mcpCallControlHarness(),
      state = callOverview(),
      row = state.controls[0]!;
    row.artifact = { ...callArtifact, sha256: '9'.repeat(64) };
    h.props.target = { kind: 'retained', state, row };
    h.handler = async () => callPreview();
    h.render();
    await h.flush();
    expect(h.calls).toHaveLength(0);
    await h.output.prepare('resume');
    expect(h.calls).toHaveLength(0);
    await h.output.prepare('pause');
    await h.flush();
    expect(h.output.preview?.artifact.sha256).toBe(callArtifact.sha256);
    expect(h.calls[0]?.body).toEqual({
      retainedSetupId: callUuid(7),
      expectedContextId: callContext,
      action: 'pause',
      expectedRevision: callInspection().revision,
      expectedEventId: callUuid(2),
    });
  });
  it('rechecks a durable unfinished Setup with its retained original SHA and invocation after browser state is gone', async () => {
    const { h, c } = client();
    await h.flush();
    const p = callPreview('setup');
    h.props.recovery = {
      workspaceId: callWorkspace,
      contextId: callContext,
      controlId: p.controlId,
      candidate: {
        operationId: p.operationId,
        artifact: p.artifact,
        invocationSha256: p.invocationSha256,
      },
    };
    h.props.target = { kind: 'source', id: callArtifact.id, expectedSha256: '9'.repeat(64) };
    c.inspection = { ...callInspection(), artifact: { ...callArtifact, sha256: '9'.repeat(64) } };
    h.render();
    await h.flush();
    c.recheck = callRecheck(p);
    await h.output.recheck(p.operationId);
    await h.flush();
    expect(h.calls.at(-1)?.body).toEqual({
      id: callArtifact.id,
      expectedSha256: callArtifact.sha256,
      expectedContextId: callContext,
      operationId: p.operationId,
      action: 'setup',
      controlId: p.controlId,
      invocationSha256: p.invocationSha256,
      expectedEventId: null,
    });
    expect(h.output.rechecked?.authority).toBe('recorded');
    expect(h.output.rechecked?.configuration).toBe('confirmed');
  });
  it('refuses the ninth outstanding write without evicting retained candidates', async () => {
    const { h } = client();
    await h.flush();
    for (let n = 0; n < 8; n++) {
      const p = {
        ...callPreview(),
        operationId: callUuid(20 + n),
        artifact: { ...callArtifact, id: 'item-' + String(n).repeat(24) },
      };
      h.pendingWrites.set(p.operationId, { preview: p, startedAt: p.createdAt });
    }
    h.render();
    await h.flush();
    expect(h.output.capacityReached).toBe(true);
    const before = h.calls.length;
    await h.output.prepare('pause');
    expect(h.calls).toHaveLength(before);
    expect(h.pendingWrites.size).toBe(8);
  });
  it('expires a preview without a write and rejects late apply across a local connection replacement', async () => {
    const { h } = client();
    await prepare(h);
    await h.advance(120_001);
    expect(h.output.preview).toBeNull();
    await h.output.apply();
    expect(h.calls.filter((x) => x.path.endsWith('/apply'))).toHaveLength(0);
  });
  it('a replacement local connection cannot accept the earlier apply response or erase its candidate', async () => {
    const { h, c } = client();
    await prepare(h);
    let release!: (v: unknown) => void;
    h.handler = async (path) =>
      path.endsWith('/apply') ? new Promise((r) => (release = r)) : c.inspection;
    const run = h.output.apply();
    await h.flush();
    h.platform.localContext = { workspace: { id: callWorkspace, label: 'Reconnected' } };
    h.render();
    await h.flush();
    release(callReceipt());
    await run;
    await h.flush();
    expect(h.output.receipt).toBeNull();
    expect(h.output.needsRecheck).toBe(true);
    expect(h.calls.filter((x) => x.path.endsWith('/apply'))).toHaveLength(1);
  });
});

describe('verified MCP call-control profile scoping', () => {
  it('scopes pending completion to verified profile while preserving a foreign same-workspace candidate', async () => {
    const { h, c } = client();
    await prepare(h);
    c.fail = 'apply';
    await h.output.apply();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    const nextContext = 'context-' + '8'.repeat(64);
    c.fail = '';
    c.inspection = { ...callInspection(), contextId: nextContext };
    c.preview = { ...callPreview(), contextId: nextContext };
    c.receipt = callReceipt(c.preview);
    let finishInspection!: (v: unknown) => void;
    h.handler = async (path) =>
      path.endsWith('/inspect')
        ? new Promise((r) => (finishInspection = r))
        : path.endsWith('/preview')
          ? c.preview
          : path.endsWith('/apply')
            ? c.receipt
            : { ...callRecheck(), authority: 'absent', recordedEventId: null };
    const read = h.output.refresh();
    await h.flush();
    expect(h.output.contextId).toBeNull();
    expect(h.output.view).toBeNull();
    await h.output.prepare('pause');
    expect(h.output.preview).toBeNull();
    finishInspection(c.inspection);
    await read;
    await h.flush();
    expect(h.output.contextId).toBe(nextContext);
    expect(h.output.pending).toHaveLength(0);
    expect(h.output.foreignPending).toHaveLength(1);
    expect(h.output.needsRecheck).toBe(false);
    const before = h.calls.length;
    await h.output.recheck(callUuid(4));
    expect(h.calls).toHaveLength(before);
    expect(h.pendingWrites.size).toBe(1);
    await h.output.prepare('pause');
    await h.flush();
    expect(h.output.preview?.contextId).toBe(nextContext);
    h.output.acknowledge('scope', true);
    await h.flush();
    await h.output.apply();
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
    expect(h.pendingWrites.size).toBe(1);
    expect([...h.pendingWrites.values()][0]).toMatchObject({ preview: { contextId: callContext } });
    h.handler = async (path) =>
      path.endsWith('/inspect')
        ? callInspection()
        : {
            ...callRecheck(),
            authority: 'absent',
            recordedEventId: null,
            currentEventId: callUuid(2),
            currentMode: 'enabled',
          };
    await h.output.refresh();
    await h.flush();
    expect(h.output.contextId).toBe(callContext);
    expect(h.output.pending).toHaveLength(1);
    expect(h.output.foreignPending).toHaveLength(0);
    await h.output.recheck(callUuid(4));
    await h.flush();
    expect(h.output.rechecked?.authority).toBe('absent');
    expect(h.output.needsRecheck).toBe(true);
    expect(h.pendingWrites.size).toBe(1);
    h.handler = async () => callRecheck();
    await h.output.recheck(callUuid(4));
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
    expect(h.pendingWrites.size).toBe(0);
  });
  it('classifies same-workspace foreign pending separately only after an overview establishes current profile', async () => {
    const h = mcpCallControlHarness('overview'),
      p = callPreview();
    h.pendingWrites.set(p.operationId, { preview: p, startedAt: p.createdAt });
    h.handler = async () => ({ ...callOverview(), contextId: 'context-' + '8'.repeat(64) });
    h.render();
    await h.flush();
    expect(h.output.pending).toHaveLength(0);
    expect(h.output.foreignPending).toHaveLength(1);
    expect(h.output.unscopedPending).toHaveLength(0);
    h.handler = async () => {
      throw Error();
    };
    await h.output.refresh();
    await h.flush();
    expect(h.output.pending).toHaveLength(0);
    expect(h.output.foreignPending).toHaveLength(0);
    expect(h.output.unscopedPending).toHaveLength(1);
    expect(h.pendingWrites.size).toBe(1);
  });
});

describe('one passive overview capture', () => {
  it('reads once without per-row inspections and refuses malformed selectors before IO', async () => {
    const h = mcpCallControlHarness('overview');
    h.handler = async () => callOverview();
    h.render();
    await h.flush();
    expect(h.calls.map((x) => x.path)).toEqual(['/api/mcp-call-controls']);
    expect(h.output.state?.controls).toHaveLength(1);
    h.props.location = { requested: true, invalid: true, controlId: null, contextId: null };
    h.render();
    await h.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.output.state).toBeNull();
  });
  it('fences late overview after connection changes and ignores a read completing after timeout', async () => {
    const h = mcpCallControlHarness('overview');
    let release!: (v: unknown) => void;
    h.handler = async () => new Promise((r) => (release = r));
    h.render();
    await h.flush();
    await h.advance(30_001);
    release(callOverview());
    await h.flush();
    expect(h.output.state).toBeNull();
    expect(h.output.error).toContain('timed out');
  });
  it('preserves unknown candidates even when passive history becomes empty or unavailable', async () => {
    const h = mcpCallControlHarness('overview'),
      p = callPreview();
    h.pendingWrites.set(p.operationId, { preview: p, startedAt: p.createdAt });
    h.handler = async () => ({
      ...callOverview(),
      controls: [],
      authority: 'missing',
      revision: null,
    });
    h.render();
    await h.flush();
    expect(h.output.pending).toHaveLength(1);
    h.handler = async () => {
      throw Error('PRIVATE_DIAGNOSTIC');
    };
    await h.output.refresh();
    await h.flush();
    expect(h.output.state).toBeNull();
    expect(h.output.pending).toHaveLength(0);
    expect(h.output.unscopedPending).toHaveLength(1);
    expect(h.output.error).not.toContain('PRIVATE_DIAGNOSTIC');
  });
  it('does not export a late previous-connection overview into the replacement profile', async () => {
    const h = mcpCallControlHarness('overview'),
      replies: ((v: unknown) => void)[] = [];
    h.handler = async () => new Promise((r) => replies.push(r));
    h.render();
    await h.flush();
    h.platform.localContext = { workspace: { id: callWorkspace, label: 'Another profile' } };
    h.render();
    await h.flush();
    replies[0]!(callOverview());
    await h.flush();
    expect(h.output.state).toBeNull();
    replies[1]!({ ...callOverview(), contextId: 'context-' + '9'.repeat(64) });
    await h.flush();
    expect(h.output.state?.contextId).toBe('context-' + '9'.repeat(64));
  });
});
