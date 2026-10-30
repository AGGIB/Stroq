import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
export const HOOK_WORKSPACE = 'workspace-' + 'a'.repeat(24);
export const HOOK_FOREIGN = 'workspace-' + 'b'.repeat(24);
export const HOOK_SOURCE = 'c'.repeat(64);
const clone = (value: any) => JSON.parse(JSON.stringify(value));
export const hookUuid = (id: number) =>
  `${String(id).padStart(8, '0')}-1111-4111-8111-111111111111`;

/** Actual transpiled hooks with isolated React/provider/transport/timers; no browser or host IO. */
export function hookCheckHarness(
  kind: 'dialog' | 'history' = 'dialog',
  initial: Record<string, unknown> = {},
) {
  let cursor = 0,
    dirty = false,
    output: any,
    clock = Date.parse('2026-10-24T01:00:00.000Z'),
    timerId = 0,
    serial = 0;
  const slots: any[] = [],
    effects: (() => void)[] = [],
    modules = new Map<string, any>();
  const timers = new Map<number, { fn: () => void; at: number }>();
  const calls: any[] = [],
    held: (() => void)[] = [],
    jobs: any[] = [];
  const same = (a: any[], b: any[]) =>
    a?.length === b.length && b.every((item, index) => Object.is(a[index], item));
  class FakeDate extends Date {
    constructor(value?: string | number) {
      super(value ?? clock);
    }
    static now() {
      return clock;
    }
  }
  const react = {
    useRef(value: any) {
      const at = cursor++;
      return (slots[at] ??= { current: value });
    },
    useState(initialValue: any) {
      const at = cursor++;
      if (!(at in slots))
        slots[at] = { value: typeof initialValue === 'function' ? initialValue() : initialValue };
      return [
        slots[at].value,
        (value: any) => {
          slots[at].value = typeof value === 'function' ? value(slots[at].value) : value;
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
        const previous = slots[at];
        slots[at] = { deps, effect: fn, cleanup: previous?.cleanup };
        effects.push(() => {
          previous?.cleanup?.();
          slots[at].cleanup = fn();
        });
      }
    },
  };
  const props: any = {
    open: true,
    agent: 'claude-code',
    scope: 'project',
    generation: 0,
    ...initial,
  };
  const platform: any = { localAccess: true, localContext: { workspace: { id: HOOK_WORKSPACE } } };
  const control = { hold: '', bad: '', history: 'ready', source: HOOK_SOURCE };
  function load(file: string): any {
    file = file.endsWith('.ts') ? file : file + '.ts';
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    modules.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(
      code,
      {
        exports,
        Object,
        Array,
        JSON,
        Reflect,
        Error,
        Number,
        AbortController,
        Date: FakeDate,
        setTimeout(fn: () => void, delay: number) {
          const id = ++timerId;
          timers.set(id, { fn, at: clock + delay });
          return id;
        },
        clearTimeout(id: number) {
          timers.delete(id);
        },
        require(name: string) {
          if (name === 'react') return react;
          if (name === '@/components/platform-provider') return { usePlatform: () => platform };
          return load(
            name.startsWith('@/')
              ? resolve(process.cwd(), name.slice(2))
              : resolve(dirname(file), name),
          );
        },
      },
      { filename: file },
    );
    return exports;
  }
  const schema = load(resolve(process.cwd(), 'lib/hook-checks'));
  const binding = () => ({
    workspaceId: platform.localContext.workspace.id,
    agent: props.agent,
    scope: props.scope,
    sourceSha256: control.source,
    policySha256: null,
    policySemanticSha256: 'd'.repeat(64),
    runtimeSha256: 'e'.repeat(64),
  });
  const previews = new Map<string, any>();
  async function request(path: string, body?: any, signal?: AbortSignal) {
    const operation = path.endsWith('/preview')
      ? 'preview'
      : path.endsWith('/start')
        ? 'start'
        : path.endsWith('/cancel')
          ? 'cancel'
          : path.includes('/jobs/')
            ? 'poll'
            : 'history';
    calls.push({ path, body, signal, operation });
    let value: any;
    if (operation === 'history')
      value = {
        schema: 'stroq-hook-checks/1',
        workspaceId: platform.localContext.workspace.id,
        engine: { available: true, version: '0.28.0' },
        agents: ['claude-code', 'cursor', 'codex'].map((id) => ({
          id,
          supported: true,
          reason: null,
        })),
        history:
          control.history === 'error'
            ? { status: 'error', error: 'read-failed' }
            : { status: control.history },
        jobs: clone(
          jobs.filter((job) => job.binding.workspaceId === platform.localContext.workspace.id),
        ),
      };
    else if (operation === 'preview') {
      value = {
        schema: 'stroq-hook-check-preview/1',
        id: hookUuid(++serial),
        agent: props.agent,
        scope: props.scope,
        createdAt: new FakeDate().toISOString(),
        expiresAt: new FakeDate(clock + 120_000).toISOString(),
        engineVersion: '0.28.0',
        canStart: true,
        reason: null,
        binding: binding(),
      };
      previews.set(value.id, clone(value));
    } else if (operation === 'start') {
      const preview = previews.get(body.previewId);
      assert.ok(preview);
      value = {
        schema: 'stroq-hook-check-job/1',
        id: hookUuid(++serial),
        previewId: preview.id,
        binding: clone(preview.binding),
        status: 'running',
        startedAt: new FakeDate().toISOString(),
      };
      jobs.push(clone(value));
    } else {
      value = clone(jobs.find((job) => job.id === (body?.jobId ?? path.split('/').at(-1))));
      if (operation === 'cancel') {
        value = {
          ...value,
          status: 'cancelled',
          finishedAt: new FakeDate().toISOString(),
          error: 'cancelled',
        };
        jobs.splice(
          jobs.findIndex((job) => job.id === value.id),
          1,
          clone(value),
        );
      }
    }
    assert.equal(
      operation === 'preview'
        ? schema.validateHookCheckPreview(value)
        : operation === 'history'
          ? schema.validateHookCheckState(value)
          : schema.validateHookCheckJob(value),
      true,
      `fixture ${operation}`,
    );
    if (control.bad === operation)
      value =
        operation === 'history'
          ? { ...value, workspaceId: HOOK_FOREIGN, jobs: [] }
          : { ...value, private: 'PRIVATE_FIXTURE' };
    if (control.hold === operation)
      return new Promise((done) => held.push(() => done(clone(value))));
    return clone(value);
  }
  platform.requestLocal = request;
  const hook = load(
    resolve(
      process.cwd(),
      `components/platform/${kind === 'dialog' ? 'use-hook-checks' : 'use-hook-check-history'}`,
    ),
  );
  function render(commit = true) {
    cursor = 0;
    dirty = false;
    output = kind === 'dialog' ? hook.useHookChecks(props) : hook.useHookCheckHistory(props);
    if (commit) effects.splice(0).forEach((fn) => fn());
    return output;
  }
  async function flush() {
    for (let i = 0; i < 60; i++) {
      await Promise.resolve();
      if (dirty) render();
    }
    return output;
  }
  return {
    props,
    platform,
    control,
    calls,
    jobs,
    timers,
    render,
    flush,
    get output() {
      return output;
    },
    fixtureJob(id = 90, changes: Record<string, unknown> = {}): any {
      return {
        schema: 'stroq-hook-check-job/1',
        id: hookUuid(id),
        previewId: hookUuid(id + 1),
        binding: binding(),
        status: 'failed',
        startedAt: new FakeDate(clock - 2000).toISOString(),
        finishedAt: new FakeDate(clock - 1000).toISOString(),
        error: 'hook-check-failed',
        ...changes,
      };
    },
    update(values: any = {}, commit = true) {
      Object.assign(props, values);
      return render(commit);
    },
    release() {
      held.splice(0).forEach((fn) => fn());
    },
    async advance(ms: number) {
      const end = clock + ms;
      for (let i = 0; i < 100; i++) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        const [id, timer] = next;
        timers.delete(id);
        clock = timer.at;
        timer.fn();
        await flush();
      }
      clock = end;
      await flush();
    },
    async prepare() {
      await output.prepare();
      await flush();
    },
    async start() {
      await output.start();
      await flush();
    },
    unmount() {
      slots.forEach((slot) => slot?.cleanup?.());
    },
    reenterEffects() {
      slots.forEach((slot) => {
        if (slot?.effect) slot.cleanup = slot.effect();
      });
    },
  };
}
