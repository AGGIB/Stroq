import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { workspace } from './codex-skill-sources-fixtures.mjs';
import {
  controlState,
  controlPreview,
  controlReceipt,
} from './codex-skill-controls-client-fixtures.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(resolve(root, 'package.json')),
  ts = require('typescript');
export function controlsHarness(enabled = true) {
  let cursor = 0,
    dirty = false,
    output,
    clock = Date.now(),
    serial = 0;
  const slots = [],
    effects = [],
    modules = new Map(),
    timers = new Map(),
    held = [],
    calls = [];
  const same = (a, b) => a?.length === b.length && b.every((v, i) => Object.is(a[i], v));
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
  const platform = { localAccess: true, localContext: { workspace: { id: workspace } } };
  const control = {
    enabled,
    hold: false,
    fail: false,
    state: controlState(),
    preview: controlPreview(),
    receipt: controlReceipt(),
    changed: 0,
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  async function request(path, body, signal) {
    calls.push({ path, body: body === undefined ? undefined : clone(body), signal });
    const value = clone(
        path.endsWith('-preview')
          ? control.preview
          : path.endsWith('-apply') || path.endsWith('-recheck')
            ? control.receipt
            : control.state,
      ),
      fail = control.fail;
    const done = () => (fail ? Promise.reject(Error('PRIVATE_CONFIG_CONTENT_SENTINEL')) : value);
    if (control.hold)
      return new Promise((resolve, reject) =>
        held.push(() => Promise.resolve().then(done).then(resolve, reject)),
      );
    return done();
  }
  platform.requestLocal = request;
  class FixtureDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
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
      (name) => {
        if (name === 'react') return react;
        if (name === '@/components/platform-provider') return { usePlatform: () => platform };
        return load(
          name.startsWith('@/') ? resolve(root, name.slice(2)) : resolve(dirname(file), name),
        );
      },
      (fn, delay) => {
        const id = ++serial;
        timers.set(id, { fn, at: clock + delay });
        return id;
      },
      (id) => {
        timers.delete(id);
      },
      FixtureDate,
    );
    return exports;
  }
  const client = load(resolve(root, 'lib/codex-skill-controls-client'));
  const hook = load(resolve(root, 'components/platform/use-codex-skill-controls'));
  const changed = () => control.changed++;
  function render(commit = true) {
    cursor = 0;
    dirty = false;
    output = hook.useCodexSkillControls(control.enabled, changed);
    if (commit) effects.splice(0).forEach((fn) => fn());
    return output;
  }
  async function flush() {
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
      if (dirty) render();
    }
    return output;
  }
  return {
    platform,
    control,
    calls,
    client,
    timers,
    render,
    flush,
    get output() {
      return output;
    },
    release() {
      held.splice(0).forEach((fn) => fn());
    },
    unmount() {
      slots.forEach((slot) => slot?.cleanup?.());
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
