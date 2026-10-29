import { describe, expect, it } from 'vitest';
import {
  HOOK_FOREIGN,
  HOOK_SOURCE,
  HOOK_WORKSPACE,
  hookCheckHarness,
  hookUuid,
} from './hook-check-test-harness';
describe('exact hook journey lifecycle', () => {
  it('unmount revokes retained prepare/start/cancel/select/refresh handlers without a close render', async () => {
    for (const running of [false, true]) {
      const h = hookCheckHarness();
      h.render();
      await h.flush();
      await h.prepare();
      if (running) await h.start();
      const old = h.output;
      h.unmount();
      const count = h.calls.length;
      await old.start();
      await old.prepare();
      await old.cancel();
      old.refresh();
      expect(h.calls.length).toBe(count);
      h.unmount();
    }
  });
  it('StrictMode cleanup and effect re-entry read again and reject the earlier ignored-abort reply', async () => {
    const h = hookCheckHarness();
    h.control.hold = 'history';
    h.render();
    await h.flush();
    const old = h.output,
      signal = h.calls[0].signal;
    h.unmount();
    expect(signal.aborted).toBe(true);
    const count = h.calls.length;
    old.refresh();
    expect(h.calls.length).toBe(count);
    h.control.hold = '';
    h.reenterEffects();
    await h.flush();
    expect(h.calls.length).toBe(count + 1);
    const fresh = h.output.state;
    expect(fresh).not.toBeNull();
    h.release();
    await h.flush();
    expect(h.output.state).toBe(fresh);
    expect(h.calls.every((call) => call.body === undefined)).toBe(true);
    h.unmount();
  });
  it('pending start and cancel remain unknown across cleanup/re-entry and late acknowledgements', async () => {
    for (const operation of ['start', 'cancel'] as const) {
      const h = hookCheckHarness();
      h.render();
      await h.flush();
      await h.prepare();
      if (operation === 'cancel') await h.start();
      h.control.hold = operation;
      const pending = h.output[operation]();
      await h.flush();
      h.unmount();
      h.control.hold = '';
      h.reenterEffects();
      await h.flush();
      expect(h.output.needsRecheck).toBe(true);
      h.release();
      await pending;
      await h.flush();
      expect(h.output.needsRecheck).toBe(true);
      expect(h.output.job).toBeNull();
      h.output.refresh();
      await h.flush();
      expect(h.output.needsRecheck).toBe(false);
      h.unmount();
    }
  });
  it('opens with GET only and blocks source-changed setup handoffs before Start', async () => {
    const h = hookCheckHarness('dialog', {
      expectedWorkspaceId: HOOK_WORKSPACE,
      expectedSourceSha256: 'f'.repeat(64),
    });
    h.render();
    await h.flush();
    expect(h.calls.map((call) => call.operation)).toEqual(['history']);
    await h.prepare();
    expect(h.output.sourceMismatch).toBe(true);
    expect(h.output.preview).toBeNull();
    const count = h.calls.length;
    await h.start();
    expect(h.calls.length).toBe(count);
    h.unmount();
  });
  it('starts an explicitly prepared exact setup-source preview using only previewId', async () => {
    const h = hookCheckHarness('dialog', {
      expectedWorkspaceId: HOOK_WORKSPACE,
      expectedSourceSha256: HOOK_SOURCE,
    });
    h.render();
    await h.flush();
    await h.prepare();
    const previewId = h.output.preview.id;
    await h.start();
    expect(h.calls.at(-1).body).toEqual({ previewId });
    expect(h.output.job.status).toBe('running');
    h.unmount();
  });
  it('rejects foreign workspace constraints without any request', async () => {
    const h = hookCheckHarness('dialog', { expectedWorkspaceId: HOOK_FOREIGN });
    h.render();
    await h.flush();
    expect(h.output.contextMismatch).toBe(true);
    await h.prepare();
    await h.start();
    expect(h.calls).toHaveLength(0);
    h.unmount();
  });
  it('keeps an exact missing run as a gap rather than selecting another attempt', async () => {
    const h = hookCheckHarness('dialog', { selectedJobId: hookUuid(99) });
    h.jobs.push(h.fixtureJob());
    h.render();
    await h.flush();
    expect(h.output.gap).toBe(true);
    expect(h.output.job).toBeNull();
    h.unmount();
  });
  it('opens exactly the retained attempt and refuses its disappearance or a scope-substituted run', async () => {
    for (const wrongScope of [false, true]) {
      const h = hookCheckHarness('dialog', { selectedJobId: hookUuid(90) });
      const selected = h.fixtureJob();
      h.jobs.push(
        wrongScope ? { ...selected, binding: { ...selected.binding, scope: 'user' } } : selected,
      );
      h.render();
      await h.flush();
      expect(h.output.job?.id ?? null).toBe(wrongScope ? null : hookUuid(90));
      expect(h.output.gap).toBe(wrongScope);
      h.jobs.splice(0, 1, h.fixtureJob(95));
      h.output.refresh();
      await h.flush();
      expect(h.output.job).toBeNull();
      expect(h.output.gap).toBe(true);
      expect(h.calls.every((call) => call.body === undefined)).toBe(true);
      h.unmount();
    }
  });
  it('rejects late responses across immediate A→B→A selection/context/connection changes', async () => {
    for (const change of ['selection', 'context', 'connection']) {
      const h = hookCheckHarness();
      h.render();
      await h.flush();
      h.control.hold = 'preview';
      const pending = h.output.prepare();
      await h.flush();
      if (change === 'selection') {
        h.update({ scope: 'user' }, false);
        h.update({ scope: 'project' }, false);
      } else if (change === 'context') {
        const before = h.platform.localContext;
        h.platform.localContext = { workspace: { id: HOOK_FOREIGN } };
        h.render(false);
        h.platform.localContext = before;
        h.render(false);
      } else {
        const before = h.platform.requestLocal;
        h.platform.requestLocal = (...args: any[]) => before(...args);
        h.render(false);
        h.platform.requestLocal = before;
        h.render(false);
      }
      h.control.hold = '';
      h.release();
      await pending;
      h.render(false);
      expect(h.output.preview).toBeNull();
      await h.flush();
      h.unmount();
    }
  });
  it('keeps an unacknowledged start unknown after timeout and ignores late completion', async () => {
    const h = hookCheckHarness();
    h.render();
    await h.flush();
    await h.prepare();
    h.control.hold = 'start';
    const pending = h.output.start();
    await h.flush();
    await h.advance(25_000);
    expect(h.output.needsRecheck).toBe(true);
    expect(h.output.busy).toBeNull();
    h.control.hold = '';
    h.output.refresh();
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
    h.release();
    await pending;
    await h.flush();
    expect(h.output.job).toBeNull();
    expect(h.calls.filter((call) => call.operation === 'start')).toHaveLength(1);
    h.unmount();
  });
  it('cannot clear unknown completion from foreign or unavailable history and never auto starts on reopen', async () => {
    const h = hookCheckHarness();
    h.render();
    await h.flush();
    await h.prepare();
    h.control.bad = 'start';
    await h.start();
    expect(h.output.needsRecheck).toBe(true);
    h.update({ open: false });
    await h.flush();
    h.control.bad = '';
    h.update({ open: true });
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    h.control.history = 'error';
    h.output.refresh();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    h.control.history = 'ready';
    h.control.bad = 'history';
    h.output.refresh();
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    h.control.bad = '';
    h.output.refresh();
    await h.flush();
    expect(h.output.needsRecheck).toBe(false);
    expect(h.calls.filter((call) => call.operation === 'start')).toHaveLength(1);
    h.unmount();
  });
  it('an ignored preview abort cannot cross source selection, context identity or access loss', async () => {
    for (const change of ['source', 'same-workspace-context', 'access']) {
      const h = hookCheckHarness();
      h.render();
      await h.flush();
      h.control.hold = 'preview';
      const pending = h.output.prepare();
      await h.flush();
      const signal = h.calls.at(-1).signal;
      h.control.hold = '';
      if (change === 'source') h.update({ expectedSourceSha256: 'f'.repeat(64) });
      else if (change === 'same-workspace-context') {
        h.platform.localContext = { workspace: { id: HOOK_WORKSPACE } };
        h.render();
      } else {
        h.platform.localAccess = false;
        h.render();
      }
      await h.flush();
      expect(signal.aborted).toBe(true);
      h.release();
      await pending;
      await h.flush();
      expect(h.output.preview).toBeNull();
      h.unmount();
    }
  });
  it('poll and cancel bind an exact run and late polling cannot undo cancellation', async () => {
    const h = hookCheckHarness();
    h.render();
    await h.flush();
    await h.prepare();
    await h.start();
    const selected = h.output.job.id;
    h.control.hold = 'poll';
    await h.advance(1000);
    const signal = h.calls.at(-1).signal;
    h.control.hold = '';
    await h.output.cancel();
    await h.flush();
    expect(signal.aborted).toBe(true);
    expect(h.calls.at(-1).body).toEqual({ jobId: selected });
    expect(h.output.job.status).toBe('cancelled');
    h.release();
    await h.flush();
    expect(h.output.job.status).toBe('cancelled');
    h.unmount();
  });
  it('synchronous close invalidates retained actions before render and preserves unknown start completion', async () => {
    const h = hookCheckHarness();
    h.render();
    await h.flush();
    await h.prepare();
    const old = h.output;
    old.invalidate();
    const count = h.calls.length;
    await old.start();
    await old.prepare();
    old.refresh();
    expect(h.calls.length).toBe(count);
    h.update({ open: false });
    await h.flush();
    h.update({ open: true });
    await h.flush();
    await h.prepare();
    h.control.hold = 'start';
    const pending = h.output.start();
    await h.flush();
    const start = h.output;
    start.invalidate();
    expect(h.calls.at(-1).signal.aborted).toBe(true);
    h.update({ open: false });
    await h.flush();
    h.control.hold = '';
    h.release();
    await pending;
    h.update({ open: true });
    await h.flush();
    expect(h.output.needsRecheck).toBe(true);
    expect(h.output.job).toBeNull();
    h.unmount();
  });
});

describe('read-only shared hook-check history', () => {
  it('retained refresh cannot send after unmount and StrictMode effect re-entry remains usable', async () => {
    const h = hookCheckHarness('history');
    h.control.hold = 'history';
    h.render();
    await h.flush();
    const old = h.output;
    h.unmount();
    const count = h.calls.length;
    old.refresh();
    expect(h.calls.length).toBe(count);
    h.control.hold = '';
    h.reenterEffects();
    await h.flush();
    expect(h.calls.length).toBe(count + 1);
    const fresh = h.output.state;
    expect(fresh).not.toBeNull();
    h.release();
    await h.flush();
    expect(h.output.state).toBe(fresh);
    h.unmount();
    const stopped = h.calls.length;
    h.output.refresh();
    expect(h.calls.length).toBe(stopped);
  });
  it('opening and refreshing use only GET; settled history never polls', async () => {
    const h = hookCheckHarness('history');
    h.jobs.push(h.fixtureJob());
    h.render();
    await h.flush();
    expect(h.output.state.jobs).toHaveLength(1);
    await h.advance(30_000);
    expect(h.calls).toHaveLength(1);
    h.output.refresh();
    await h.flush();
    expect(h.calls).toHaveLength(2);
    expect(
      h.calls.every((call) => call.path === '/api/hook-checks' && call.body === undefined),
    ).toBe(true);
    h.unmount();
  });
  it('explicit refresh hides the previous capture while a new GET is pending', async () => {
    const h = hookCheckHarness('history');
    h.render();
    await h.flush();
    expect(h.output.state).not.toBeNull();
    h.control.hold = 'history';
    h.output.refresh();
    await h.flush();
    expect(h.output.state).toBeNull();
    expect(h.output.busy).toBe(true);
    h.control.hold = '';
    h.release();
    await h.flush();
    expect(h.output.state).not.toBeNull();
    expect(h.calls.every((call) => call.body === undefined)).toBe(true);
    h.unmount();
  });
  it('does not read when disabled or disconnected and clears visible evidence on connection loss', async () => {
    const h = hookCheckHarness('history', { enabled: false });
    h.render();
    await h.flush();
    expect(h.calls).toHaveLength(0);
    h.update({ enabled: true });
    await h.flush();
    expect(h.output.state).not.toBeNull();
    h.platform.localAccess = false;
    h.render();
    await h.flush();
    expect(h.output.state).toBeNull();
    expect(h.output.workspaceId).toBeNull();
    const count = h.calls.length;
    h.output.refresh();
    expect(h.calls.length).toBe(count);
    h.unmount();
  });
  it('polls only a known running attempt, stops after terminal evidence and sends no mutation', async () => {
    const h = hookCheckHarness('history');
    const running = h.fixtureJob();
    delete running.finishedAt;
    delete running.error;
    running.status = 'running';
    h.jobs.push(running);
    h.render();
    await h.flush();
    await h.advance(1000);
    expect(h.calls).toHaveLength(2);
    h.jobs.splice(0, 1, h.fixtureJob());
    await h.advance(1000);
    expect(h.output.state.jobs[0].status).toBe('failed');
    const count = h.calls.length;
    await h.advance(30_000);
    expect(h.calls.length).toBe(count);
    expect(h.calls.every((call) => call.body === undefined)).toBe(true);
    h.unmount();
  });
  it('bounds failing polls and keeps unavailable history explicit instead of empty success', async () => {
    const h = hookCheckHarness('history');
    const running = h.fixtureJob();
    delete running.finishedAt;
    delete running.error;
    running.status = 'running';
    h.jobs.push(running);
    h.render();
    await h.flush();
    h.control.bad = 'history';
    await h.advance(6000);
    expect(h.calls).toHaveLength(4);
    expect(h.output.error).toBeTruthy();
    await h.advance(30_000);
    expect(h.calls).toHaveLength(4);
    h.control.bad = '';
    h.control.history = 'error';
    h.output.refresh();
    await h.flush();
    expect(h.output.state.history.status).toBe('error');
    expect(h.output.error).toBeTruthy();
    h.unmount();
  });
  it('timeouts end visible busy and ignored responses cannot republish after refresh or unmount', async () => {
    const h = hookCheckHarness('history');
    h.control.hold = 'history';
    h.render();
    await h.flush();
    await h.advance(25_000);
    expect(h.output.busy).toBe(false);
    expect(h.output.state).toBeNull();
    expect(h.output.error).toBeTruthy();
    h.control.hold = '';
    h.output.refresh();
    await h.flush();
    const fresh = h.output.state;
    h.release();
    await h.flush();
    expect(h.output.state).toBe(fresh);
    h.unmount();
  });
  it('fences immediate A→B→A and same-workspace context/connection replacement before effects', async () => {
    for (const change of ['workspace', 'context', 'connection']) {
      const h = hookCheckHarness('history');
      h.control.hold = 'history';
      h.render();
      await h.flush();
      const oldContext = h.platform.localContext,
        oldRequest = h.platform.requestLocal;
      if (change === 'connection')
        h.platform.requestLocal = (...args: any[]) => oldRequest(...args);
      else
        h.platform.localContext = {
          workspace: { id: change === 'workspace' ? HOOK_FOREIGN : HOOK_WORKSPACE },
        };
      h.render(false);
      h.platform.localContext = oldContext;
      h.platform.requestLocal = oldRequest;
      h.render(false);
      h.control.hold = '';
      h.release();
      await Promise.resolve();
      await Promise.resolve();
      h.render(false);
      expect(h.output.state).toBeNull();
      await h.flush();
      h.unmount();
    }
  });
});
