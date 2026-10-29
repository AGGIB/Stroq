import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)),
  require = createRequire(resolve(root, 'package.json')),
  ts = require('typescript');
export const workspace = 'workspace-' + 'a'.repeat(24),
  foreignWorkspace = 'workspace-' + 'b'.repeat(24),
  runtime = 'c'.repeat(64),
  revision = 'd'.repeat(64),
  uuid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

/** Runs the actual hook and boundary validators with controlled async IO and time. */
export function monitorHarness(fixtures) {
  let cursor = 0,
    dirty = false,
    output,
    clock = Date.parse('2026-10-24T01:00:00.000Z'),
    serial = 0;
  const slots = [],
    effects = [],
    modules = new Map(),
    timers = new Map(),
    held = [],
    calls = [];
  const same = (a, b) =>
    a?.length === b.length && b.every((value, index) => Object.is(a[index], value));
  class FakeDate extends Date {
    constructor(value) {
      super(value ?? clock);
    }
    static now() {
      return clock;
    }
  }
  const react = {
    useRef(value) {
      return (slots[cursor++] ??= { current: value });
    },
    useState(initial) {
      const at = cursor++;
      if (!(at in slots))
        slots[at] = { value: typeof initial === 'function' ? initial() : initial };
      return [
        slots[at].value,
        (value) => {
          slots[at].value = typeof value === 'function' ? value(slots[at].value) : value;
          dirty = true;
        },
      ];
    },
    useCallback(fn, deps) {
      const at = cursor++;
      if (!slots[at] || !same(slots[at].deps, deps)) slots[at] = { fn, deps };
      return slots[at].fn;
    },
    useEffect(fn, deps) {
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
  const props = { enabled: true },
    platform = {
      localAccess: true,
      localContext: { workspace: { id: workspace, label: 'Fixture' } },
    },
    control = { hold: '', bad: '', fail: '', state: fixtures.state(), receipt: null };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  async function request(path, body, signal) {
    const operation = path.endsWith('/preview')
      ? 'preview'
      : path.endsWith('/apply')
        ? 'apply'
        : 'load';
    calls.push({ path, body: body === undefined ? undefined : clone(body), signal, operation });
    let value =
      operation === 'load'
        ? clone(fixtures.queue ? (control.state[path] ?? {}) : control.state)
        : operation === 'preview'
          ? fixtures.preview(body, ++serial, clock, control.state)
          : (control.receipt ?? fixtures.receipt(body, clock, control.state));
    if (control.bad === operation || control.bad === path)
      value = { ...value, private: 'UNEXPECTED_FIELD' };
    const done = () =>
      control.fail === operation || control.fail === path
        ? Promise.reject(new Error('PRIVATE_FIXTURE'))
        : clone(value);
    if (control.hold === operation || control.hold === path)
      return new Promise((resolve, reject) =>
        held.push(() => {
          Promise.resolve().then(done).then(resolve, reject);
        }),
      );
    return done();
  }
  platform.requestLocal = request;
  function load(file) {
    if (!file.endsWith('.ts')) file += '.ts';
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
        setTimeout(fn, delay) {
          const id = ++serial;
          timers.set(id, { fn, at: clock + delay });
          return id;
        },
        clearTimeout(id) {
          timers.delete(id);
        },
        require(name) {
          if (name === 'react') return react;
          if (name === '@/components/platform-provider') return { usePlatform: () => platform };
          return load(
            name.startsWith('@/') ? resolve(root, name.slice(2)) : resolve(dirname(file), name),
          );
        },
      },
      { filename: file },
    );
    return exports;
  }
  const hook = load(
    resolve(
      root,
      `components/platform/${fixtures.queue ? 'use-protection-queue' : 'use-workspace-monitor'}`,
    ),
  );
  function render(commit = true) {
    cursor = 0;
    dirty = false;
    output = fixtures.queue
      ? hook.useProtectionQueue(props.refreshKey)
      : hook.useWorkspaceMonitor(props);
    if (commit) effects.splice(0).forEach((effect) => effect());
    return output;
  }
  async function flush() {
    for (let i = 0; i < 60; i++) {
      await Promise.resolve();
      if (dirty) render();
    }
    return output;
  }
  function unmount() {
    slots.forEach((slot) => slot?.cleanup?.());
  }
  return {
    props,
    platform,
    control,
    calls,
    timers,
    render,
    flush,
    unmount,
    get output() {
      return output;
    },
    get callControlWrites() {
      return load(resolve(root, 'lib/mcp-call-control-binding.ts')).callControlPending(
        platform.requestLocal,
      );
    },
    get codexSkillWrites() {
      return load(
        resolve(root, 'lib/codex-skill-controls-client.ts'),
      ).codexSkillControlPendingWrites(platform.requestLocal);
    },
    get networkGuardWrites() {
      return load(resolve(root, 'lib/codex-network-client.ts')).codexNetworkGuardPending(
        platform.requestLocal,
      );
    },
    get networkCheckWrites() {
      return load(resolve(root, 'lib/codex-network-client.ts')).codexNetworkCheckPending(
        platform.requestLocal,
      );
    },
    notifyNetworkWrites() {
      load(resolve(root, 'lib/codex-network-client.ts')).notifyCodexNetworkPending(
        platform.requestLocal,
      );
    },
    get pathGuardWrites() {
      return load(resolve(root, 'lib/codex-path-guard-client.ts')).codexPathGuardPending(
        platform.requestLocal,
      );
    },
    notifyPathGuardWrites() {
      load(resolve(root, 'lib/codex-path-guard-client.ts')).notifyCodexPathGuardPending(
        platform.requestLocal,
      );
    },
    get governanceWrites() {
      return load(resolve(root, 'lib/mcp-governance-client.ts')).mcpGovernancePending(
        platform.requestLocal,
      );
    },
    notifyGovernanceWrites() {
      load(resolve(root, 'lib/mcp-governance-client.ts')).notifyMcpGovernancePending(
        platform.requestLocal,
      );
    },
    update(values = {}, commit = true) {
      Object.assign(props, values);
      return render(commit);
    },
    reenterEffects() {
      slots.forEach((slot) => {
        if (slot?.effect) slot.cleanup = slot.effect();
      });
    },
    remount() {
      unmount();
      slots.length = 0;
      effects.length = 0;
      render();
    },
    release() {
      held.splice(0).forEach((release) => release());
    },
    async advance(ms) {
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
  };
}
