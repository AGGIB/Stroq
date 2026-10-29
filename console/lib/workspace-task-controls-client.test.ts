import { describe, expect, it } from 'vitest';
import { taskControlsHarness } from './workspace-task-controls-client-harness';
import {
  taskPreview,
  taskReceipt,
  taskRecord,
  taskRun,
  taskState,
  taskWs,
} from './workspace-task-controls-fixtures';

function client() {
  const h = taskControlsHarness();
  h.props.run = taskRun();
  const control: any = { fail: '', receipt: null, preview: null, state: taskState() };
  h.handler = async (path) => {
    const operation = path.split('/').at(-1)!;
    if (control.fail === operation) throw Error('PRIVATE_DIAGNOSTIC');
    if (operation === 'preview') return control.preview ?? taskPreview();
    if (operation === 'restore-preview') return control.preview ?? taskPreview('restore');
    if (operation === 'apply') return control.receipt ?? taskReceipt();
    if (operation === 'restore') return control.receipt ?? taskReceipt('restore');
    if (operation === 'recheck') return control.receipt ?? taskReceipt('recheck');
    return control.state;
  };
  h.render();
  return { h, control };
}
async function prepared(h: ReturnType<typeof taskControlsHarness>) {
  await h.flush();
  await h.output.prepare(h.props.run.result.capture.sources[0]);
  await h.flush();
  expect(h.output.preview).not.toBeNull();
}
async function consent(h: ReturnType<typeof taskControlsHarness>) {
  h.output.acknowledge('effects', true);
  h.output.acknowledge('retention', true);
  await h.flush();
}
describe('actual workspace task controls client lifecycle', () => {
  it('shows only a recognized finite source-change reason when preview is refused', async () => {
    const { h } = client();
    await h.flush();
    const message = 'The task file changed. Capture the workspace and preview again.';
    h.handler = async () => {
      throw Error(message);
    };
    await h.output.prepare(h.props.run.result.capture.sources[0]);
    await h.flush();
    expect(h.output.error).toBe(message);
    expect(h.output.preview).toBeNull();
  });
  it('surfaces durable unfinished intents after reload and requires their explicit recheck before another preview', async () => {
    const { h, control } = client();
    control.state = taskState([
      { ...taskRecord(), status: 'prepared', canRestore: false, fileState: 'original-version' },
    ]);
    await h.flush();
    await h.output.refresh();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    expect(h.output.canPrepare).toBe(false);
    const before = h.calls.length;
    await h.output.prepare(h.props.run.result.capture.sources[0]);
    expect(h.calls).toHaveLength(before);
    await h.output.recheck(taskRecord().id);
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
  });
  it('loads history without a write and needs an exact preview plus both fresh consents', async () => {
    const { h } = client();
    await h.flush();
    expect(h.calls.every((call) => call.body === undefined)).toBe(true);
    await h.output.apply();
    expect(h.calls).toHaveLength(1);
    await prepared(h);
    h.output.acknowledge('effects', true);
    await h.flush();
    await h.output.apply();
    expect(h.calls).toHaveLength(2);
    h.output.acknowledge('retention', true);
    await h.flush();
    await h.output.apply();
    await h.flush();
    expect(h.calls[2]?.path).toBe('/api/workspace-task-controls/apply');
    expect(h.calls[2]?.body).toEqual({
      previewId: taskPreview().id,
      acknowledgeWorkspaceChange: true,
      acknowledgeRecoveryRetention: true,
    });
    expect(h.output.receipt.writeConfirmed).toBe(true);
  });
  it('restore has a separate preview, revision binding and automatic-execution consent', async () => {
    const { h, control } = client();
    control.state = taskState([taskRecord()]);
    await h.flush();
    await h.output.refresh();
    await h.flush();
    await h.output.prepareRestore(taskRecord());
    await h.flush();
    expect(h.output.preview.operation).toBe('restore');
    expect(h.output.ack.effects).toBe(false);
    expect(h.output.ack.retention).toBe(false);
    expect(h.calls.at(-1)?.body).toEqual({
      recordId: taskRecord().id,
      expectedRevision: taskRecord().revision,
    });
    await consent(h);
    await h.output.apply();
    await h.flush();
    expect(h.calls.at(-1)?.path).toBe('/api/workspace-task-controls/restore');
    expect(h.calls.at(-1)?.body).toEqual({
      previewId: taskPreview('restore').id,
      acknowledgeAutomaticExecution: true,
      acknowledgeRecoveryRetention: true,
    });
  });
  it('retains uncertain writes across real remount and automatic history until an exact explicit recheck', async () => {
    const { h, control } = client();
    await prepared(h);
    await consent(h);
    const retainedPrepare = h.output.prepare;
    control.fail = 'apply';
    await h.output.apply();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    expect(h.output.error).not.toContain('PRIVATE_DIAGNOSTIC');
    const failed = h.calls.length;
    await retainedPrepare(h.props.run.result.capture.sources[0]);
    expect(h.calls).toHaveLength(failed);
    h.remount();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    const before = h.calls.length;
    await h.output.prepare(h.props.run.result.capture.sources[0]);
    expect(h.calls).toHaveLength(before);
    control.receipt = { ...taskReceipt('recheck'), workspaceId: `workspace-${'f'.repeat(24)}` };
    await h.output.recheck(taskRecord().id);
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    control.receipt = taskReceipt('recheck');
    await h.output.recheck(taskRecord().id);
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
    expect(h.output.state.records[0].id).toBe(taskRecord().id);
  });
  it('keeps an explicitly rechecked uncertain intent blocked until its original file identity is confirmed unchanged', async () => {
    const { h, control } = client();
    await prepared(h);
    await consent(h);
    control.fail = 'apply';
    await h.output.apply();
    await h.flush();
    control.receipt = taskReceipt('recheck');
    control.receipt.writeConfirmed = false;
    control.receipt.record.status = 'uncertain';
    control.receipt.record.fileState = 'changed';
    control.receipt.record.canRestore = false;
    await h.output.recheck(taskRecord().id);
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    control.receipt.record.status = 'unchanged';
    control.receipt.record.fileState = 'original-version';
    await h.output.recheck(taskRecord().id);
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
  });
  it('does not prepare a source from another workspace or restore a stale record whose current permission was revoked', async () => {
    const { h, control } = client();
    await h.flush();
    const foreign = `workspace-${'f'.repeat(24)}`;
    h.props.run.workspaceId = foreign;
    h.props.run.result.capture.workspaceId = foreign;
    h.render();
    await h.flush();
    let before = h.calls.length;
    await h.output.prepare(h.props.run.result.capture.sources[0]);
    expect(h.calls).toHaveLength(before);
    control.state = taskState([{ ...taskRecord(), canRestore: false, fileState: 'changed' }]);
    await h.output.refresh();
    await h.flush();
    before = h.calls.length;
    await h.output.prepareRestore(taskRecord());
    expect(h.calls).toHaveLength(before);
  });
  it('refuses expired, changed-selection and retained unmounted callbacks before sending requests', async () => {
    const { h } = client();
    await prepared(h);
    await consent(h);
    await h.advance(120001);
    const before = h.calls.length;
    await h.output.apply();
    expect(h.calls).toHaveLength(before);
    expect(h.output.preview).toBeNull();
    const old = {
      refresh: h.output.refresh,
      prepare: h.output.prepare,
      apply: h.output.apply,
      recheck: h.output.recheck,
    };
    h.platform.localContext = { workspace: { id: taskWs, label: 'Reconnected' } };
    h.render();
    await h.flush();
    const reconnected = h.calls.length;
    await old.refresh();
    await old.prepare(h.props.run.result.capture.sources[0]);
    await old.apply();
    await old.recheck(taskRecord().id);
    expect(h.calls).toHaveLength(reconnected);
    const retained = h.output;
    h.unmount();
    await retained.refresh();
    await retained.prepare(h.props.run.result.capture.sources[0]);
    await retained.prepareRestore(taskRecord());
    await retained.recheck(taskRecord().id);
    expect(h.calls).toHaveLength(reconnected);
  });
  it('accepts confirmed file change separately from a failed static capture', async () => {
    const { h, control } = client();
    await prepared(h);
    await consent(h);
    control.receipt = taskReceipt();
    control.receipt.record.verification = {
      status: 'unavailable',
      runId: null,
      error: 'capture-unavailable',
    };
    await h.output.apply();
    await h.flush();
    expect(h.output.receipt.writeConfirmed).toBe(true);
    expect(h.output.receipt.record.verification.status).toBe('unavailable');
    expect(h.output.needsRecheck).toBe(false);
  });
  it('never accepts a late write after cleanup and keeps its pending recovery obligation', async () => {
    const { h } = client();
    await prepared(h);
    await consent(h);
    let release!: (value: unknown) => void;
    h.handler = async () => new Promise((resolve) => (release = resolve));
    const pending = h.output.apply();
    const signal = h.calls.at(-1)?.signal;
    h.unmount();
    expect(signal?.aborted).toBe(true);
    release(taskReceipt());
    await pending;
    h.handler = async () => taskState();
    h.remount();
    await h.flush();
    expect(h.output.receipt).toBeNull();
    expect(h.output.needsRecheck).toBe(true);
  });
});
