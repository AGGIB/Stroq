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
export function inventoryMonitorHarness(fixtures) {
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
    calls = [],
    captures = [];
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
  const props = { enabled: true, canRefresh: true, onCheck: (id) => captures.push(id) },
    platform = {
      localAccess: true,
      localContext: { workspace: { id: workspace, label: 'Fixture' } },
    },
    control = { hold: '', bad: '', fail: '', state: fixtures.state(), receipt: null };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  async function request(path, body, signal) {
    if (!operations.isLocalOperation(path)) throw new Error('Unsupported local operation.');
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
        TextEncoder,
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
  const operations = load(resolve(root, 'lib/local-operations'));
  const hook = load(resolve(root, 'components/platform/use-inventory-monitor'));
  function render(commit = true) {
    cursor = 0;
    dirty = false;
    output = hook.useInventoryMonitor(props);
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
    captures,
    timers,
    render,
    flush,
    unmount,
    get output() {
      return output;
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
