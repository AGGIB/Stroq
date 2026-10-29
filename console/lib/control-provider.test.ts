import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as schema from './control';
const workspace = `workspace-${'a'.repeat(24)}`;
const context = {
  workspaceId: 'b'.repeat(64),
  policySha256: 'c'.repeat(64),
  runtimeSha256: 'd'.repeat(64),
};
const state = () => ({
  schema: 'stroq-control/1',
  workspaceId: workspace,
  engine: { available: true, version: '0.28.0' },
  context,
  history: { status: 'ready' },
  runs: [],
});
const running = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'doctor',
  status: 'running',
  startedAt: '2026-10-24T10:00:00.000Z',
  provenance: context,
};
/** Exercises the actual provider with isolated React state and held transport replies. */
function harness() {
  let cursor = 0,
    dirty = false,
    unmounted = false,
    value: any;
  const slots: any[] = [],
    effects: (() => void)[] = [],
    timers = new Map();
  const calls: { path: string; body: any; signal?: AbortSignal }[] = [];
  const platform: any = { localAccess: true, localContext: { workspace: { id: workspace } } };
  let handler = async (_path: string, _body: any): Promise<any> => state();
  platform.requestLocal = (path: string, body: any, signal?: AbortSignal) => {
    calls.push({ path, body, signal });
    return handler(path, body);
  };
  const same = (a: any[], b: any[]) =>
    a?.length === b.length && b.every((v, i) => Object.is(v, a[i]));
  const react = {
    createContext: () => ({ Provider: 'provider' }),
    useContext: () => null,
    useRef(v: any) {
      return (slots[cursor++] ??= { current: v });
    },
    useState(v: any) {
      const at = cursor++;
      if (!slots[at]) slots[at] = { value: typeof v === 'function' ? v() : v };
      return [
        slots[at].value,
        (next: any) => {
          slots[at].value = typeof next === 'function' ? next(slots[at].value) : next;
          dirty = true;
        },
      ];
    },
    useCallback(fn: any, deps: any[]) {
      const at = cursor++;
      if (!slots[at] || !same(slots[at].deps, deps)) slots[at] = { fn, deps };
      return slots[at].fn;
    },
    useEffect(fn: any, deps: any[]) {
      const at = cursor++;
      if (!slots[at] || !same(slots[at].deps, deps)) {
        const old = slots[at];
        slots[at] = { deps, cleanup: old?.cleanup };
        effects.push(() => {
          old?.cleanup?.();
          slots[at].cleanup = fn();
        });
      }
    },
  };
  const exports: any = {};
  const code = ts.transpileModule(
    readFileSync(resolve(process.cwd(), 'components/control-provider.tsx'), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  vm.runInNewContext(code, {
    exports,
    AbortController,
    setTimeout(fn: any, delay: number) {
      const id = Symbol();
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id: any) {
      timers.delete(id);
    },
    require(name: string) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: (_t: any, p: any) => p };
      if (name === './platform-provider') return { usePlatform: () => platform };
      if (name === '@/lib/control') return schema;
      throw Error(name);
    },
  });
  function render() {
    cursor = 0;
    dirty = false;
    value = exports.ControlProvider({ children: null }).value;
    while (effects.length) effects.shift()!();
  }
  async function flush() {
    for (let i = 0; i < 16; i++) {
      await Promise.resolve();
      if (dirty && !unmounted) render();
    }
  }
  render();
  return {
    platform,
    calls,
    get value() {
      return value;
    },
    render,
    flush,
    unmount() {
      unmounted = true;
      for (const slot of slots) slot?.cleanup?.();
    },
    set handler(v: typeof handler) {
      handler = v;
    },
  };
}
describe('control connection and explicit action lifecycle', () => {
  it('retained start and refresh callbacks send no request after actual provider cleanup', async () => {
    const h = harness();
    await h.flush();
    const { start, refresh } = h.value;
    h.unmount();
    const before = h.calls.length;
    expect(await start({ kind: 'doctor' })).toBeNull();
    await refresh();
    expect(h.calls).toHaveLength(before);
  });
  it('a retained cancellation callback cannot contact the service after actual provider cleanup', async () => {
    const h = harness();
    await h.flush();
    const parent = {
      ...running,
      kind: 'protection-check',
      progress: {
        steps: [
          'doctor',
          'policy-check',
          'guard-test',
          'saved-policy-checks',
          'workspace-review',
        ].map((id) => ({
          id,
          status: 'queued',
          startedAt: null,
          finishedAt: null,
          error: null,
          result: null,
        })),
      },
    };
    h.handler = async () => ({ ...state(), activeProtectionCheckId: parent.id, runs: [parent] });
    await h.value.refresh();
    await h.flush();
    const cancel = h.value.cancel;
    h.unmount();
    const before = h.calls.length;
    expect(await cancel(parent.id)).toBeNull();
    expect(h.calls).toHaveLength(before);
  });
  it('unmount still aborts an admitted request and ignores its late response without another request', async () => {
    const h = harness();
    await h.flush();
    let release!: (v: any) => void;
    h.handler = async () => new Promise((resolve) => (release = resolve));
    const pending = h.value.start({ kind: 'doctor' });
    const signal = h.calls.at(-1)?.signal;
    expect(signal?.aborted).toBe(false);
    h.unmount();
    expect(signal?.aborted).toBe(true);
    const before = h.calls.length;
    release(running);
    expect(await pending).toBeNull();
    await h.flush();
    expect(h.calls).toHaveLength(before);
    expect(h.value.runs).toEqual([]);
  });
  it('does not accept late start responses after reconnecting to the same workspace', async () => {
    const h = harness();
    await h.flush();
    let release!: (v: any) => void;
    h.handler = async (_path, body) =>
      body ? new Promise((resolve) => (release = resolve)) : state();
    const pending = h.value.start({ kind: 'doctor' });
    h.platform.localContext = { workspace: { id: workspace } };
    h.render();
    await h.flush();
    release(running);
    expect(await pending).toBeNull();
    await h.flush();
    expect(h.value.runs).toEqual([]);
  });
  it('a retained old-connection refresh sends no request and cannot invalidate the current held read', async () => {
    const h = harness();
    await h.flush();
    const oldRefresh = h.value.refresh;
    const replies: ((value: any) => void)[] = [];
    h.handler = async () => new Promise((resolve) => replies.push(resolve));
    h.platform.localContext = { workspace: { id: workspace } };
    h.render();
    await h.flush();
    const before = h.calls.length;
    const stale = oldRefresh();
    await h.flush();
    expect(h.calls).toHaveLength(before);
    replies[0]!(state());
    await h.flush();
    await stale;
    expect(h.value.control).toMatchObject({ workspaceId: workspace });
    expect(h.value.loading).toBe(false);
  });
  it('requires an explicit successful recheck before retrying an unacknowledged start', async () => {
    const h = harness();
    await h.flush();
    h.handler = async (_path, body) => {
      if (body) throw Error('No response');
      return state();
    };
    expect(await h.value.start({ kind: 'protection-check' })).toBeNull();
    await h.flush();
    expect(h.value.needsRecheck).toBe(true);
    expect(await h.value.start({ kind: 'protection-check' })).toBeNull();
    expect(h.calls.filter((c) => c.body).length).toBe(1);
    await h.value.refresh();
    await h.flush();
    expect(h.value.needsRecheck).toBe(false);
  });
  it('automatic page-entry reads retain uncertainty until an explicit accepted ready-history read', async () => {
    const h = harness();
    await h.flush();
    h.handler = async (_path, body) => {
      if (body) throw Error('No response');
      return state();
    };
    await h.value.start({ kind: 'doctor' });
    await h.flush();
    expect(h.value.needsRecheck).toBe(true);
    await h.value.refresh(false);
    await h.flush();
    expect(h.value.needsRecheck).toBe(true);
    h.handler = async () => ({
      ...state(),
      history: { status: 'error', error: 'write-failed' },
    });
    await h.value.refresh();
    await h.flush();
    expect(h.value.needsRecheck).toBe(true);
    h.handler = async () => state();
    await h.value.refresh();
    await h.flush();
    expect(h.value.needsRecheck).toBe(false);
    expect(h.calls.filter((call) => call.body)).toHaveLength(1);
  });
  it('only exposes cancellation for an exact running protection parent and never starts on mount', async () => {
    const h = harness();
    await h.flush();
    expect(h.calls.every((c) => c.body === undefined)).toBe(true);
    expect(typeof h.value.cancel).toBe('function');
    expect(await h.value.cancel(running.id)).toBeNull();
    expect(h.calls.filter((c) => c.body).length).toBe(0);
  });
  it('keeps an unattached earlier parent unverified while allowing an explicit server-gated new attempt', async () => {
    const h = harness();
    await h.flush();
    const previous = {
      ...running,
      kind: 'protection-check',
      progress: {
        steps: [
          'doctor',
          'policy-check',
          'guard-test',
          'saved-policy-checks',
          'workspace-review',
        ].map((id) => ({
          id,
          status: 'queued',
          startedAt: null,
          finishedAt: null,
          error: null,
          result: null,
        })),
      },
    };
    h.handler = async (_path, body) =>
      body
        ? { ...previous, id: '22222222-2222-4222-8222-222222222222' }
        : { ...state(), activeProtectionCheckId: null, runs: [previous] };
    await h.value.refresh();
    await h.flush();
    expect(h.value.runs).toHaveLength(1);
    expect(h.value.busy).toBe(false);
    expect(await h.value.cancel(previous.id)).toBeNull();
    const accepted = await h.value.start({ kind: 'protection-check' });
    await h.flush();
    expect(accepted?.id).toBe('22222222-2222-4222-8222-222222222222');
    expect(h.value.control.activeProtectionCheckId).toBe(accepted?.id);
    expect(h.value.busy).toBe(true);
  });
  it('allows explicit server-gated admission beside a retained leaf whose current owner is unverified', async () => {
    const h = harness();
    await h.flush();
    h.handler = async (_path, body) =>
      body
        ? { ...running, id: '22222222-2222-4222-8222-222222222222' }
        : { ...state(), activeRunId: null, activeProtectionCheckId: null, runs: [running] };
    await h.value.refresh();
    await h.flush();
    expect(h.value.runs).toHaveLength(1);
    expect(h.value.busy).toBe(false);
    const result = await h.value.start({ kind: 'doctor' });
    await h.flush();
    expect(result?.id).toBe('22222222-2222-4222-8222-222222222222');
    expect(h.value.control.activeRunId).toBe(result?.id);
    expect(h.value.busy).toBe(true);
  });
  it('keeps a locally owned leaf busy and preserves missing-field legacy ownership behavior', async () => {
    for (const marker of [{ activeRunId: running.id }, {}]) {
      const h = harness();
      await h.flush();
      h.handler = async () => ({ ...state(), ...marker, runs: [running] });
      await h.value.refresh();
      await h.flush();
      expect(h.value.busy).toBe(true);
      const before = h.calls.length;
      expect(await h.value.start({ kind: 'doctor' })).toBeNull();
      expect(h.calls).toHaveLength(before);
    }
  });
  it('blocks new checks when saved history is unavailable while preserving disabled legacy history', async () => {
    for (const status of ['error', 'disabled']) {
      const h = harness();
      await h.flush();
      h.handler = async (_path, body) =>
        body
          ? running
          : {
              ...state(),
              history: status === 'error' ? { status, error: 'invalid-history' } : { status },
            };
      await h.value.refresh();
      await h.flush();
      expect(h.value.busy).toBe(status === 'error');
      const before = h.calls.length;
      const result = await h.value.start({ kind: 'doctor' });
      expect(result?.id ?? null).toBe(status === 'error' ? null : running.id);
      expect(h.calls).toHaveLength(before + (status === 'error' ? 0 : 1));
    }
  });
  it('still permits cancellation of an owned parent when saved history is unavailable', async () => {
    const h = harness();
    await h.flush();
    const parent = {
      ...running,
      kind: 'protection-check',
      progress: {
        steps: [
          'doctor',
          'policy-check',
          'guard-test',
          'saved-policy-checks',
          'workspace-review',
        ].map((id) => ({
          id,
          status: 'queued',
          startedAt: null,
          finishedAt: null,
          error: null,
          result: null,
        })),
      },
    };
    h.handler = async () => ({
      ...state(),
      history: { status: 'error', error: 'invalid-history' },
      activeRunId: parent.id,
      activeProtectionCheckId: parent.id,
      runs: [parent],
    });
    await h.value.refresh();
    await h.flush();
    h.handler = async () => {
      throw Error('Response unavailable');
    };
    const before = h.calls.length;
    await h.value.cancel(parent.id);
    expect(h.calls).toHaveLength(before + 1);
    expect(h.calls.at(-1)).toMatchObject({ path: '/api/runs/cancel', body: { id: parent.id } });
  });
  it('does not let an overlapping older GET erase an acknowledged start', async () => {
    const h = harness();
    await h.flush();
    let releaseStart!: (v: any) => void, releaseRead!: (v: any) => void;
    h.handler = async (_path, body) =>
      new Promise((resolve) => {
        if (body) releaseStart = resolve;
        else releaseRead = resolve;
      });
    const starting = h.value.start({ kind: 'doctor' });
    const reading = h.value.refresh();
    releaseStart(running);
    await starting;
    await h.flush();
    expect(h.value.runs).toHaveLength(1);
    releaseRead(state());
    await reading;
    await h.flush();
    expect(h.value.runs).toHaveLength(1);
    expect(h.value.busy).toBe(true);
  });
  it('does not let a held ready-history read clear uncertainty after a failed write response', async () => {
    const h = harness();
    await h.flush();
    let rejectWrite!: (error: Error) => void, releaseRead!: (value: any) => void;
    h.handler = async (_path, body) =>
      new Promise((resolve, reject) => {
        if (body) rejectWrite = reject;
        else releaseRead = resolve;
      });
    const starting = h.value.start({ kind: 'doctor' });
    const reading = h.value.refresh();
    rejectWrite(Error('History publication failed'));
    expect(await starting).toBeNull();
    await h.flush();
    releaseRead(state());
    await reading;
    await h.flush();
    expect(h.value.needsRecheck).toBe(true);
    expect(h.value.busy).toBe(true);
    expect(h.value.runs).toEqual([]);
  });
  it('does not let a pre-cancel GET resurrect an acknowledged terminal parent', async () => {
    const h = harness();
    await h.flush();
    const steps = [
      'doctor',
      'policy-check',
      'guard-test',
      'saved-policy-checks',
      'workspace-review',
    ].map((id) => ({
      id,
      status: 'queued',
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
    }));
    const parent = { ...running, kind: 'protection-check', progress: { steps } };
    h.handler = async () => ({ ...state(), activeProtectionCheckId: parent.id, runs: [parent] });
    await h.value.refresh();
    await h.flush();
    let releaseCancel!: (v: any) => void, releaseRead!: (v: any) => void;
    h.handler = async (_path, body) =>
      new Promise((resolve) => {
        if (body) releaseCancel = resolve;
        else releaseRead = resolve;
      });
    const cancelling = h.value.cancel(parent.id),
      reading = h.value.refresh();
    const cancelled = {
      ...parent,
      status: 'cancelled',
      finishedAt: running.startedAt,
      error: 'cancelled',
      progress: {
        steps: steps.map((s) => ({
          ...s,
          status: 'skipped',
          finishedAt: running.startedAt,
          error: 'cancelled',
        })),
      },
      result: {
        source: 'local',
        evidence: 'local-checks',
        outcome: 'incomplete',
        completed: 0,
        total: 5,
        hostEnforcement: false,
      },
    };
    releaseCancel(cancelled);
    await cancelling;
    await h.flush();
    releaseRead({ ...state(), activeProtectionCheckId: parent.id, runs: [parent] });
    await reading;
    await h.flush();
    expect(h.value.runs[0].status).toBe('cancelled');
    expect(h.value.control.activeProtectionCheckId).toBeNull();
    expect(h.value.busy).toBe(false);
  });
  it('refuses a typed POST report whose embedded source belongs to another workspace', async () => {
    const h = harness();
    await h.flush();
    const steps: any[] = [
      'doctor',
      'policy-check',
      'guard-test',
      'saved-policy-checks',
      'workspace-review',
    ].map((id, i) => ({
      id,
      status: i < 3 ? 'skipped' : 'queued',
      startedAt: null,
      finishedAt: i < 3 ? running.startedAt : null,
      error: i < 3 ? 'prerequisite-failed' : null,
      result: null,
    }));
    steps[3] = {
      ...steps[3],
      status: 'completed',
      startedAt: running.startedAt as any,
      finishedAt: running.startedAt,
      error: null,
      result: {
        source: 'local',
        evidence: 'simulation',
        workspaceId: `workspace-${'f'.repeat(24)}`,
        generatedAt: running.startedAt,
        revision: null,
        policy: { source: 'built-in', semanticSha: 'b'.repeat(64), rawSha: null },
        total: 0,
        passed: 0,
        failed: 0,
        cases: [],
        results: [],
        hostEnforcement: false,
      } as any,
    };
    const foreign = { ...running, kind: 'protection-check', progress: { steps } };
    expect(schema.validateRun(foreign)).toBe(true);
    h.handler = async () => foreign;
    expect(await h.value.start({ kind: 'protection-check' })).toBeNull();
    await h.flush();
    expect(h.value.runs).toEqual([]);
    expect(h.value.needsRecheck).toBe(true);
  });
});
