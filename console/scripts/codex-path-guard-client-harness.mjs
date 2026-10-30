import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as fixtures from './codex-path-guard-client-fixtures.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  require = createRequire(resolve(root, 'package.json')),
  ts = require('typescript');
export function pathGuardHarness(open = false) {
  let cursor = 0,
    dirty = false,
    output,
    clock = Date.now(),
    serial = 0;
  const slots = [],
    effects = [],
    modules = new Map(),
    calls = [],
    timers = new Map(),
    held = [];
  const same = (a, b) => a?.length === b.length && b.every((v, i) => Object.is(a[i], v));
  const react = {
    useRef(v) {
      return (slots[cursor++] ??= { current: v });
    },
    useState(v) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = { value: typeof v === 'function' ? v() : v };
      return [
        slots[at].value,
        (next) => {
          slots[at].value = typeof next === 'function' ? next(slots[at].value) : next;
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
        const before = slots[at];
        slots[at] = { deps, effect: fn, cleanup: before?.cleanup };
        effects.push(() => {
          before?.cleanup?.();
          slots[at].cleanup = fn();
        });
      }
    },
  };
  const platform = { localAccess: true, localContext: { workspace: { id: fixtures.workspace } } };
  const control = {
    open,
    hold: false,
    fail: false,
    failPath: null,
    state: fixtures.state(),
    capture: fixtures.capture(),
    preview: fixtures.preview(),
    receipt: fixtures.receipt(),
    changed: 0,
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  async function request(path, body, signal) {
    calls.push({ path, body: body === undefined ? undefined : clone(body), signal });
    let value =
      path === '/api/codex-path-guard'
        ? control.state
        : path.endsWith('/capture')
          ? control.capture
          : path === '/api/codex-path-guard/preview'
            ? control.preview
            : path.endsWith('/apply') || path.endsWith('/recheck')
              ? control.receipt
              : null;
    value = clone(value);
    const fail = control.fail || path === control.failPath;
    const failure = control.error;
    const done = () =>
      fail ? Promise.reject(failure ?? Error('PRIVATE_NETWORK_CONFIG_SENTINEL')) : value;
    if (control.hold)
      return new Promise((resolve, reject) =>
        held.push(() => Promise.resolve().then(done).then(resolve, reject)),
      );
    return done();
  }
  platform.requestLocal = request;
  class FixtureDate extends Date {
    constructor(...a) {
      super(...(a.length ? a : [clock]));
    }
    static now() {
      return clock;
    }
  }
  function load(file) {
    if (!file.endsWith('.ts')) file += '.ts';
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    modules.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInThisContext(`(function(exports,require,setTimeout,clearTimeout,Date){${code}\n})`, {
      filename: file,
    })(
      exports,
      (name) =>
        name === 'react'
          ? react
          : name === '@/components/platform-provider'
            ? { usePlatform: () => platform }
            : load(
                name.startsWith('@/') ? resolve(root, name.slice(2)) : resolve(dirname(file), name),
              ),
      (fn, delay) => {
        const id = ++serial;
        timers.set(id, { fn, at: clock + delay });
        return id;
      },
      (id) => timers.delete(id),
      FixtureDate,
    );
    return exports;
  }
  const hook = load(resolve(root, 'components/platform/use-codex-path-guard')),
    client = load(resolve(root, 'lib/codex-path-guard-client'));
  function render(commit = true) {
    cursor = 0;
    dirty = false;
    output = hook.useCodexPathGuard(control.open);
    if (commit) effects.splice(0).forEach((fn) => fn());
    return output;
  }
  async function flush() {
    for (let i = 0; i < 75; i++) {
      await Promise.resolve();
      if (dirty) render();
    }
    return output;
  }
  return {
    platform,
    control,
    calls,
    timers,
    client,
    render,
    flush,
    get output() {
      return output;
    },
    release() {
      held.splice(0).forEach((fn) => fn());
    },
    unmount() {
      slots.forEach((s) => s?.cleanup?.());
    },
    async advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= clock) {
          timers.delete(id);
          timer.fn();
        }
      await flush();
    },
  };
}
