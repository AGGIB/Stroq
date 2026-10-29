import { describe, expect, it } from 'vitest';
import { sessionTaintHarness } from './session-taint-client-harness';
import { SESSION_TAINT_ERROR_MESSAGES } from './session-taint';
import {
  taintAt,
  taintHash,
  taintHistory,
  taintInspection,
  taintPreview,
  taintReceipt,
  taintRecord,
} from './session-taint-fixtures';
function client() {
  const h = sessionTaintHarness();
  h.props.incident = {
    id: taintInspection().incident.id,
    evidenceSha: taintHash('a'),
    sequence: 12,
    recordedAt: '2026-10-24T09:00:00.000Z',
  };
  const c: any = {
    fail: '',
    inspection: taintInspection(),
    preview: taintPreview(),
    receipt: taintReceipt(),
    state: taintHistory(),
  };
  h.handler = async (path) => {
    const op = path.split('/').at(-1);
    if (op === 'clear' && c.refusal) throw c.refusal;
    if (c.fail === op) throw Error('PRIVATE_DIAGNOSTIC');
    return op === 'inspect'
      ? c.inspection
      : op === 'preview'
        ? c.preview
        : op === 'clear' || op === 'recheck'
          ? c.receipt
          : c.state;
  };
  h.render();
  return { h, c };
}
async function prepared(h: ReturnType<typeof sessionTaintHarness>) {
  await h.flush();
  await h.output.inspect();
  await h.flush();
  await h.output.prepare();
  await h.flush();
  expect(h.output.preview).not.toBeNull();
}
async function consent(h: ReturnType<typeof sessionTaintHarness>) {
  h.output.acknowledge('effects', true);
  h.output.acknowledge('retention', true);
  await h.flush();
}
describe('actual stored session taint client lifecycle', () => {
  it.each([
    ['stale-state', 409],
    ['stale-evidence', 409],
    ['not-tainted', 422],
    ['preview-expired', 409],
    ['preview-unavailable', 409],
    ['recovery-full', 422],
    ['recovery-required', 422],
    ['session-busy', 409],
  ] as const)(
    'releases only this pending clear after a verified %s refusal, then reads history without retrying',
    async (code, status) => {
      const { h, c } = client();
      await prepared(h);
      await consent(h);
      c.refusal = h.refusal(code, status);
      await h.output.apply();
      await h.flush();
      expect(h.output.needsRecheck).toBe(false);
      expect(h.output.inspection).toBeNull();
      expect(h.output.preview).toBeNull();
      expect(h.output.ack).toEqual({ effects: false, retention: false });
      expect(h.output.error).toBe(SESSION_TAINT_ERROR_MESSAGES[code]);
      expect(h.calls.at(-1)?.path).toBe('/api/session-taint');
      expect(h.calls.at(-1)?.body).toBeUndefined();
      expect(h.calls.filter((call) => call.path.endsWith('/clear'))).toHaveLength(1);
      const before = h.calls.length;
      await h.output.prepare();
      expect(h.calls).toHaveLength(before);
      await h.output.inspect();
      await h.flush();
      await h.output.prepare();
      await h.flush();
      expect(h.output.preview).not.toBeNull();
      expect(h.output.ack).toEqual({ effects: false, retention: false });
    },
  );
  it('retains newly observed other unfinished changes when a verified refusal refreshes history', async () => {
    const { h, c } = client();
    await prepared(h);
    await consent(h);
    const other = {
      ...taintRecord(),
      id: '33333333-3333-4333-8333-333333333333',
      status: 'prepared' as const,
      afterTaintSha256: null,
      preservedProvenanceSha256: null,
    };
    c.state = taintHistory([other]);
    c.refusal = h.refusal('stale-state', 409);
    await h.output.apply();
    await h.flush();
    expect(h.output.unresolved).toHaveLength(0);
    expect(h.output.unresolvedRecords.map((r: any) => r.id)).toEqual([other.id]);
    expect(h.output.needsRecheck).toBe(true);
  });
  it.each(['plain text', 'forged fields', 'wrong status'])(
    'keeps %s refusal lookalikes unknown and blocked without an automatic retry',
    async (kind) => {
      const { h, c } = client();
      await prepared(h);
      await consent(h);
      const error = new Error(SESSION_TAINT_ERROR_MESSAGES['stale-state']);
      c.refusal =
        kind === 'forged fields'
          ? Object.assign(error, { name: 'SessionTaintRefusal', code: 'stale-state', status: 409 })
          : kind === 'wrong status'
            ? (h.refusal('stale-state', 422) ?? error)
            : error;
      await h.output.apply();
      await h.flush();
      expect(h.output.needsRecheck).toBe(true);
      expect(h.output.error).toContain('Completion is unknown');
      expect(h.calls.at(-1)?.path).toBe('/api/session-taint/clear');
      expect(h.calls.filter((call) => call.path.endsWith('/clear'))).toHaveLength(1);
    },
  );
  it('keeps a timed-out clear unknown when an abort-ignoring transport later returns success', async () => {
    const { h } = client();
    await prepared(h);
    await consent(h);
    let release!: (value: unknown) => void;
    h.handler = async () => new Promise((resolve) => (release = resolve));
    const attempt = h.output.apply();
    await h.advance(60_001);
    expect(h.output.busy).toBeNull();
    expect(h.output.needsRecheck).toBe(true);
    expect(h.output.error).toContain('Completion is unknown');
    expect(h.calls.at(-1)?.signal?.aborted).toBe(true);
    release(taintReceipt());
    await attempt;
    await h.flush();
    expect(h.output.receipt).toBeNull();
    expect(h.output.needsRecheck).toBe(true);
    expect(h.calls.at(-1)?.path).toBe('/api/session-taint/clear');
  });
  it('only reads history on entry and requires explicit inspection, exact preview and two fresh acknowledgements', async () => {
    const { h } = client();
    await h.flush();
    expect(h.calls.map((c) => c.path)).toEqual(['/api/session-taint']);
    await h.output.apply();
    expect(h.calls).toHaveLength(1);
    await prepared(h);
    expect(h.calls[1]?.body).toEqual({
      id: h.props.incident.id,
      expectedEvidenceSha: taintHash('a'),
    });
    expect(h.calls[2]?.body).toEqual({
      id: h.props.incident.id,
      expectedEvidenceSha: taintHash('a'),
      expectedRevisionSha256: taintHash('c'),
    });
    h.output.acknowledge('effects', true);
    await h.flush();
    await h.output.apply();
    expect(h.calls).toHaveLength(3);
    h.output.acknowledge('retention', true);
    await h.flush();
    await h.output.apply();
    await h.flush();
    expect(h.calls[3]?.body).toEqual({
      previewId: taintPreview().id,
      acknowledgeWeakenRestrictions: true,
      acknowledgeRecoveryRetention: true,
    });
    expect(h.output.receipt.writeConfirmed).toBe(true);
  });
  it('rejects a foreign inspection, changed preview, and a stale receipt without revealing diagnostics', async () => {
    const { h, c } = client();
    await h.flush();
    c.inspection = { ...taintInspection(), workspaceId: `workspace-${'f'.repeat(24)}` };
    await h.output.inspect();
    await h.flush();
    expect(h.output.inspection).toBeNull();
    c.inspection = taintInspection();
    await h.output.inspect();
    await h.flush();
    c.preview = {
      ...taintPreview(),
      inspection: { ...taintInspection(), revisionSha256: taintHash('9') },
    };
    await h.output.prepare();
    await h.flush();
    expect(h.output.preview).toBeNull();
    c.preview = taintPreview();
    await h.output.prepare();
    await h.flush();
    await consent(h);
    c.receipt = { ...taintReceipt(), checkedAt: '2026-10-24T09:59:59.999Z' };
    await h.output.apply();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    expect(h.output.error).not.toContain('PRIVATE');
  });
  it('retains an unknown write across unmount and automatic history; only exact conclusive explicit recheck resolves it', async () => {
    const { h, c } = client();
    await prepared(h);
    await consent(h);
    c.fail = 'clear';
    await h.output.apply();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    h.remount();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    const before = h.calls.length;
    await h.output.inspect();
    await h.flush();
    await h.output.prepare();
    expect(h.calls).toHaveLength(before + 1);
    c.receipt = {
      ...taintReceipt('recheck'),
      writeConfirmed: false,
      record: {
        ...taintRecord(),
        status: 'uncertain',
        afterTaintSha256: null,
        preservedProvenanceSha256: null,
      },
    };
    await h.output.recheck(taintRecord().id);
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    c.receipt = taintReceipt('recheck');
    await h.output.recheck(taintRecord().id);
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
  });
  it('requires explicit recheck of durable unfinished records after restart, including another finding in this workspace', async () => {
    const { h, c } = client();
    c.state = taintHistory([
      {
        ...taintRecord(),
        status: 'prepared',
        afterTaintSha256: null,
        preservedProvenanceSha256: null,
      },
    ]);
    await h.flush();
    await h.output.refresh();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    await h.output.inspect();
    await h.flush();
    const before = h.calls.length;
    await h.output.prepare();
    expect(h.calls).toHaveLength(before);
    c.receipt = taintReceipt('recheck');
    await h.output.recheck(taintRecord().id);
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
  });
  it('accepts an explicit historical no-publication recheck even when current taint changed later', async () => {
    const { h, c } = client();
    await prepared(h);
    await consent(h);
    c.fail = 'clear';
    await h.output.apply();
    await h.flush();
    c.receipt = {
      ...taintReceipt('recheck'),
      writeConfirmed: false,
      record: {
        ...taintRecord(),
        status: 'unchanged',
        afterTaintSha256: null,
        preservedProvenanceSha256: null,
        current: {
          ...taintInspection(),
          revisionSha256: taintHash('9'),
          taint: { ...taintInspection().taint, sources: 3, sha256: taintHash('8') },
        },
      },
    };
    await h.output.recheck(taintRecord().id);
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
    expect(h.output.receipt.writeConfirmed).toBe(false);
    expect(h.output.inspection.taint.sources).toBe(3);
  });
  it('does not let a later automatic history read resolve an already observed unfinished change', async () => {
    const { h, c } = client();
    c.state = taintHistory([
      {
        ...taintRecord(),
        status: 'prepared',
        afterTaintSha256: null,
        preservedProvenanceSha256: null,
      },
    ]);
    await h.flush();
    await h.output.refresh();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    c.state = taintHistory([taintRecord()]);
    h.remount();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    c.receipt = taintReceipt('recheck');
    await h.output.recheck(taintRecord().id);
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
  });
  it('revokes expired consents and refuses retained callbacks after selection/connection changes and actual unmount', async () => {
    const { h } = client();
    await prepared(h);
    await consent(h);
    await h.advance(120001);
    const before = h.calls.length;
    await h.output.apply();
    expect(h.calls).toHaveLength(before);
    expect(h.output.preview).toBeNull();
    const old = h.output;
    h.platform.localContext = {
      workspace: { id: taintInspection().workspaceId, label: 'Reconnected' },
    };
    h.render();
    await h.flush();
    const connected = h.calls.length;
    await old.refresh();
    await old.inspect();
    await old.prepare();
    await old.apply();
    await old.recheck(taintRecord().id);
    expect(h.calls).toHaveLength(connected);
    const retained = h.output;
    h.unmount();
    await retained.refresh();
    await retained.inspect();
    await retained.prepare();
    await retained.recheck(taintRecord().id);
    expect(h.calls).toHaveLength(connected);
  });
  it('does not accept a late abort-ignoring clear response after cleanup and keeps its pending obligation', async () => {
    const { h, c } = client();
    await prepared(h);
    await consent(h);
    let release!: (v: unknown) => void;
    h.handler = async () => new Promise((r) => (release = r));
    const attempt = h.output.apply();
    h.unmount();
    expect(h.calls.at(-1)?.signal?.aborted).toBe(true);
    release(taintReceipt());
    await attempt;
    h.handler = async () => c.state;
    h.remount();
    await h.flush();
    expect(h.output.receipt).toBeNull();
    expect(h.output.needsRecheck).toBe(true);
  });
  it('shows historical confirmation independently of failed current readback and refuses preview while provenance is pending', async () => {
    const { h, c } = client();
    await prepared(h);
    await consent(h);
    c.receipt = {
      ...taintReceipt(),
      record: { ...taintRecord(), current: null, error: 'session-unavailable' },
    };
    await h.output.apply();
    await h.flush();
    expect(h.output.receipt.writeConfirmed).toBe(true);
    expect(h.output.inspection).toBeNull();
    c.inspection = {
      ...taintInspection(),
      provenance: { ...taintInspection().provenance, pending: 1 },
    };
    await h.output.inspect();
    await h.flush();
    const before = h.calls.length;
    await h.output.prepare();
    expect(h.calls).toHaveLength(before);
  });
});
