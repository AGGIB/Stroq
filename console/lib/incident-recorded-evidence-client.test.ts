import { describe, expect, it } from 'vitest';
import { recordedEvidenceHarness } from './incident-recorded-evidence-client-harness';
import { recordedEvidence, recordedFinding } from './incident-recorded-evidence-fixtures';

const held = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

describe('selected finding recorded evidence lifecycle', () => {
  it('reads only the selected exact finding once; reads never start without a local connection', async () => {
    const h = recordedEvidenceHarness();
    h.render();
    await h.flush();
    expect(h.calls).toHaveLength(0);
    h.platform.localAccess = false;
    h.props.incident = recordedFinding();
    h.render();
    await h.flush();
    expect(h.calls).toHaveLength(0);
    h.platform.localAccess = true;
    h.platform.localContext = null;
    h.render();
    await h.flush();
    expect(h.calls).toHaveLength(0);
    h.platform.localContext = { workspace: { id: `workspace-${'b'.repeat(24)}` } };
    h.handler = async () => recordedEvidence();
    h.render();
    await h.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      path: '/api/incidents/evidence',
      body: { id: recordedFinding().id, expectedEvidenceSha: 'a'.repeat(64) },
    });
    expect(h.output.report).toEqual(recordedEvidence());
    h.render();
    await h.flush();
    expect(h.calls).toHaveLength(1);
  });
  it('does not accept a late response after selection changed and invalidates export immediately', async () => {
    const h = recordedEvidenceHarness(),
      first = held(),
      second = held();
    h.props.incident = recordedFinding();
    h.handler = () => first.promise;
    h.render();
    await h.flush();
    h.props.incident = recordedFinding('b');
    h.handler = () => second.promise;
    h.render();
    expect(h.output.getReport()).toBeNull();
    await h.flush();
    expect(h.calls[0]!.signal?.aborted).toBe(true);
    first.resolve(recordedEvidence());
    await h.flush();
    expect(h.output.report).toBeNull();
    second.resolve(recordedEvidence(recordedFinding('b')));
    await h.flush();
    expect(h.output.getReport()?.binding.evidenceSha).toBe('b'.repeat(64));
  });
  it('clears current authority on connection change, even for the same finding', async () => {
    const h = recordedEvidenceHarness();
    h.props.incident = recordedFinding();
    h.handler = async () => recordedEvidence();
    h.render();
    await h.flush();
    expect(h.output.getReport()).not.toBeNull();
    const pending = held();
    h.handler = () => pending.promise;
    h.platform.localContext = { workspace: { id: `workspace-${'c'.repeat(24)}` } };
    h.render();
    expect(h.output.getReport()).toBeNull();
    await h.flush();
    expect(h.output.report).toBeNull();
    expect(h.calls).toHaveLength(2);
    pending.resolve(recordedEvidence());
    await h.flush();
    expect(h.output.report).not.toBeNull();
  });
  it('refuses a malformed, private or wrong-binding result rather than showing unrelated evidence', async () => {
    for (const change of [
      (r: any) => {
        r.privateSource = 'PRIVATE';
      },
      (r: any) => {
        r.binding.sequence++;
      },
      (r: any) => {
        r.binding.recordedAt = '2026-10-26T07:00:00.000Z';
      },
      (r: any) => {
        r.binding = recordedEvidence(recordedFinding('b')).binding;
      },
      (r: any) => {
        r.effect = 'allow';
      },
    ]) {
      const h = recordedEvidenceHarness(),
        value: any = recordedEvidence();
      change(value);
      h.handler = async () => value;
      h.props.incident = recordedFinding();
      h.render();
      await h.flush();
      expect(h.output.getReport()).toBeNull();
      expect(h.output.report).toBeNull();
      expect(h.output.error).toContain('unavailable');
      h.unmount();
    }
  });
  it('times out without auto retry, rejects the late result and supports one explicit refresh', async () => {
    const h = recordedEvidenceHarness(),
      pending = held();
    h.props.incident = recordedFinding();
    h.handler = () => pending.promise;
    h.render();
    await h.flush();
    await h.advance(25001);
    expect(h.calls[0]!.signal?.aborted).toBe(true);
    expect(h.output.loading).toBe(false);
    expect(h.output.error).toContain('timed out');
    pending.resolve(recordedEvidence());
    await h.flush();
    expect(h.output.report).toBeNull();
    expect(h.calls).toHaveLength(1);
    h.handler = async () => recordedEvidence();
    await h.output.refresh();
    await h.flush();
    expect(h.calls).toHaveLength(2);
    expect(h.output.getReport()).not.toBeNull();
  });
  it('aborts on unmount and cannot accept later evidence', async () => {
    const h = recordedEvidenceHarness(),
      pending = held();
    h.props.incident = recordedFinding();
    h.handler = () => pending.promise;
    h.render();
    await h.flush();
    const action = h.output;
    h.unmount();
    expect(h.calls[0]!.signal?.aborted).toBe(true);
    pending.resolve(recordedEvidence());
    await h.flush();
    expect(action.getReport()).toBeNull();
    await action.refresh();
    expect(h.calls).toHaveLength(1);
  });
});
