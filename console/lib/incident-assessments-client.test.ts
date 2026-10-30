import { describe, expect, it } from 'vitest';
import { incidentAssessmentsHarness } from './incident-assessments-client-harness';
import {
  assessmentAt,
  assessmentBinding,
  assessmentHash,
  assessmentId,
  assessmentPreview,
  assessmentReceipt,
  assessmentRecord,
  assessmentState,
} from './incident-assessment-fixtures';
const incident = () => ({
  ...assessmentBinding(),
  evidenceSha: assessmentBinding().evidenceSha256,
});
function client(selected: any = incident()) {
  const h = incidentAssessmentsHarness();
  h.props.incident = selected;
  const c: any = {
    state: assessmentState(),
    preview: assessmentPreview(),
    receipt: assessmentReceipt(),
    fail: '',
    keepState: false,
  };
  h.handler = async (path) => {
    const op = path.split('/').at(-1);
    if (c.fail === op) throw Error('PRIVATE_DIAGNOSTIC');
    if (op === 'preview') return c.preview;
    if (op === 'apply') {
      if (!c.keepState) c.state = assessmentState([c.receipt.record]);
      return c.receipt;
    }
    if (op === 'recheck') return c.receipt;
    return c.state;
  };
  h.render();
  return { h, c };
}
async function choose(h: ReturnType<typeof incidentAssessmentsHarness>) {
  await h.flush();
  h.output.show();
  h.output.setChoice('accepted-risk', 'intended-workflow');
  await h.flush();
}
describe('actual incident assessment client lifecycle', () => {
  it('exposes pending snapshots without granting callers mutation of unknown-write authority', async () => {
    const { h, c } = client();
    await choose(h);
    c.fail = 'apply';
    await h.output.save();
    await h.flush();
    const snapshot = h.pendingSnapshot();
    snapshot.get(assessmentRecord().id).preview.incident.evidenceSha256 = assessmentHash('f');
    snapshot.clear();
    h.output.pending[0].preview.reason = 'incorrect-match';
    await h.output.refresh();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    expect(h.output.pending[0].preview.incident.evidenceSha256).toBe(assessmentHash('a'));
    expect(h.output.pending[0].preview.reason).toBe('intended-workflow');
    c.receipt = assessmentReceipt('recheck');
    await h.output.recheck(assessmentRecord().id);
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
  });
  it('retains a dispatched apply across actual unmount and refuses its late success after remount', async () => {
    const { h, c } = client();
    await choose(h);
    let release!: (value: unknown) => void;
    h.handler = async (path) =>
      path.endsWith('/preview')
        ? assessmentPreview()
        : new Promise((resolve) => (release = resolve));
    const attempt = h.output.save();
    await h.flush();
    h.unmount();
    expect(h.calls.at(-1)?.signal?.aborted).toBe(true);
    release(assessmentReceipt());
    await attempt;
    h.handler = async () => c.state;
    h.remount();
    await h.flush();
    expect(h.output.receipt).toBeNull();
    expect(h.output.needsRecheck).toBe(true);
  });
  it('loads one summary without a selection and never rereads per finding or performs automatic POST', async () => {
    const { h } = client(null);
    await h.flush();
    expect(h.calls.map((c) => c.path)).toEqual(['/api/incident-assessments']);
    h.props.incident = incident();
    h.render();
    await h.flush();
    h.props.incident = {
      ...incident(),
      id: `incident-${assessmentHash('c')}`,
      evidenceSha: assessmentHash('c'),
    };
    h.render();
    await h.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.body).toBeUndefined();
  });
  it('one explicit Save prepares then applies an exact annotation without acknowledgements or other mutations', async () => {
    const { h } = client();
    await choose(h);
    expect(h.output.canSave).toBe(true);
    await h.output.save();
    await h.flush();
    expect(h.calls.map((c) => c.path)).toEqual([
      '/api/incident-assessments',
      '/api/incident-assessments/preview',
      '/api/incident-assessments/apply',
      '/api/incident-assessments',
    ]);
    expect(h.calls[1]?.body).toEqual({
      id: incident().id,
      expectedEvidenceSha: assessmentHash('a'),
      expectedAssessmentId: null,
      assessment: 'accepted-risk',
      reason: 'intended-workflow',
    });
    expect(h.calls[2]?.body).toEqual({ previewId: assessmentPreview().id });
    expect(h.output.latest.id).toBe(assessmentRecord().id);
    expect(h.output.needsRecheck).toBe(false);
  });
  it('refuses invalid pairs, an unchanged latest choice, and reopening without a prior assessment', async () => {
    const { h, c } = client();
    await h.flush();
    h.output.show();
    h.output.setChoice('accepted-risk', 'incorrect-match');
    await h.flush();
    await h.output.save();
    expect(h.calls).toHaveLength(1);
    h.output.setChoice('reopened', 'reassess');
    await h.flush();
    await h.output.save();
    expect(h.calls).toHaveLength(1);
    c.state = assessmentState([assessmentRecord()]);
    await h.output.refresh();
    await h.flush();
    h.output.setChoice('accepted-risk', 'intended-workflow');
    await h.flush();
    expect(h.output.canSave).toBe(false);
    await h.output.save();
    expect(h.calls).toHaveLength(2);
  });
  it('rejects wrong preview identity, kind, outcome, prior record, revision and expired plans before apply', async () => {
    for (const change of [
      { incident: { ...assessmentBinding(), kind: 'content-flag' } },
      { incident: { ...assessmentBinding(), sequence: 13 } },
      { assessment: 'false-positive', reason: 'incorrect-match' },
      { previousAssessmentId: assessmentId('8') },
      { storeRevision: assessmentHash('8') },
      { createdAt: '2026-10-24T09:58:00.000Z', expiresAt: assessmentAt },
    ]) {
      const { h, c } = client();
      await choose(h);
      c.preview = { ...assessmentPreview(), ...change };
      await h.output.save();
      await h.flush();
      expect(h.calls.some((call) => call.path.endsWith('/apply'))).toBe(false);
      expect(h.output.pending).toHaveLength(0);
      expect(h.output.error).not.toContain('PRIVATE');
    }
  });
  it('cancelling a held preview makes no write, and changing selection fences the preview-to-apply continuation', async () => {
    for (const cancel of [true, false]) {
      const { h } = client();
      await choose(h);
      let release!: (value: unknown) => void;
      h.handler = async () => new Promise((resolve) => (release = resolve));
      const attempt = h.output.save();
      if (cancel) h.output.close();
      else {
        h.props.incident = { ...incident(), sequence: 13 };
        h.render();
      }
      release(assessmentPreview());
      await attempt;
      await h.flush();
      expect(h.calls.some((call) => call.path.endsWith('/apply'))).toBe(false);
      expect(h.output.pending).toHaveLength(0);
    }
  });
  it('retains uncertain saves across remount, ordinary GET and other findings until exact explicit recheck', async () => {
    const { h, c } = client();
    await choose(h);
    c.fail = 'apply';
    await h.output.save();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    expect(h.output.latest).toBeNull();
    h.remount();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    h.props.incident = {
      ...incident(),
      id: `incident-${assessmentHash('c')}`,
      evidenceSha: assessmentHash('c'),
    };
    h.render();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    expect(h.output.completionUnknown).toBe(false);
    h.output.show();
    h.output.setChoice('accepted-risk', 'intended-workflow');
    await h.flush();
    const before = h.calls.length;
    await h.output.save();
    expect(h.calls).toHaveLength(before);
    c.receipt = assessmentReceipt('recheck');
    await h.output.recheck(assessmentRecord().id);
    await h.flush();
    expect(h.calls.find((call) => call.path.endsWith('/recheck'))?.body).toEqual({
      recordId: assessmentRecord().id,
      expectedEvidenceSha: assessmentHash('a'),
    });
    expect(h.output.needsRecheck).toBe(false);
  });
  it('ordinary history containing the saved record still cannot clear an unknown write latch', async () => {
    const { h, c } = client();
    await choose(h);
    c.fail = 'apply';
    await h.output.save();
    await h.flush();
    c.state = assessmentState([assessmentRecord()]);
    await h.output.refresh();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    expect(h.output.completionUnknown).toBe(true);
  });
  it('rechecks full candidate identity and timing rather than merely accepting its evidence SHA', async () => {
    const { h, c } = client();
    await choose(h);
    c.fail = 'apply';
    await h.output.save();
    await h.flush();
    for (const record of [
      { ...assessmentRecord(), reason: 'controlled-test' },
      { ...assessmentRecord(), incident: { ...assessmentBinding(), kind: 'content-flag' } },
      { ...assessmentRecord(), previousAssessmentId: assessmentId('9') },
    ]) {
      c.receipt = { ...assessmentReceipt('recheck'), record };
      await h.output.recheck(assessmentRecord().id);
      await h.flush();
      expect(h.output.needsRecheck).toBe(true);
    }
    c.receipt = { ...assessmentReceipt('recheck'), checkedAt: '2026-10-24T09:59:59.999Z' };
    await h.output.recheck(assessmentRecord().id);
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    c.receipt = assessmentReceipt('recheck');
    await h.output.recheck(assessmentRecord().id);
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
  });
  it('releases an explicit not-present result as a point-in-time observation without replaying a write', async () => {
    const { h, c } = client();
    await choose(h);
    c.fail = 'apply';
    await h.output.save();
    await h.flush();
    c.receipt = {
      ...assessmentReceipt('recheck'),
      status: 'not-present',
      record: null,
      revision: null,
    };
    await h.output.recheck(assessmentRecord().id);
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
    expect(h.output.receipt.status).toBe('not-present');
    expect(h.calls.filter((call) => call.path.endsWith('/apply'))).toHaveLength(1);
  });
  it('keeps timed-out and malformed apply outcomes unknown, ignoring late responses after cleanup', async () => {
    const { h } = client();
    await choose(h);
    let release!: (value: unknown) => void;
    h.handler = async (path) =>
      path.endsWith('/preview')
        ? assessmentPreview()
        : new Promise((resolve) => (release = resolve));
    const attempt = h.output.save();
    await h.flush();
    await h.advance(60_001);
    expect(h.output.needsRecheck).toBe(true);
    expect(h.output.busy).toBeNull();
    release(assessmentReceipt());
    await attempt;
    await h.flush();
    expect(h.output.receipt).toBeNull();
    expect(h.output.needsRecheck).toBe(true);
  });
  it('refuses retained callbacks after a connection change and after actual unmount', async () => {
    const { h } = client();
    await choose(h);
    const old = h.output;
    h.platform.localContext = {
      workspace: { id: h.platform.localContext.workspace.id, label: 'Reconnected' },
    };
    h.render();
    await h.flush();
    const before = h.calls.length;
    await old.save();
    await old.refresh();
    await old.recheck(assessmentId('2'));
    old.show();
    expect(h.calls).toHaveLength(before);
    const retained = h.output;
    h.unmount();
    await retained.save();
    await retained.refresh();
    await retained.recheck(assessmentId('2'));
    expect(h.calls).toHaveLength(before);
  });
  it('shows unavailable/full history as a write limitation without fabricating an empty assessment', async () => {
    const { h, c } = client();
    await h.flush();
    c.state = {
      ...assessmentState(),
      history: 'unavailable',
      canRecord: false,
      error: 'history-unavailable',
    };
    await h.output.refresh();
    await h.flush();
    expect(h.output.available).toBe(false);
    await choose(h);
    await h.output.save();
    expect(h.calls.some((call) => call.path.endsWith('/preview'))).toBe(false);
    c.state = { ...assessmentState([assessmentRecord()]), canRecord: false, error: 'store-full' };
    await h.output.refresh();
    await h.flush();
    expect(h.output.available).toBe(true);
    expect(h.output.latest.id).toBe(assessmentRecord().id);
    expect(h.output.canSave).toBe(false);
  });
});
