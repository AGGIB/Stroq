import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { codexSourcesFixture, workspace } from './codex-skill-sources-fixtures.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(resolve(root, 'package.json')),
  ts = require('typescript');
export function codexSourcesHarness() {
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
  const platform = {
    localAccess: true,
    localContext: { workspace: { id: workspace, label: 'Fixture' } },
  };
  const control = { hold: false, fail: false, report: codexSourcesFixture() };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  async function request(path, body, signal) {
    if (!operations.isLocalOperation(path)) throw Error('Unsupported operation');
    calls.push({ path, body: body === undefined ? undefined : clone(body), signal });
    const captured = clone(control.report),
      fail = control.fail;
    const done = () => (fail ? Promise.reject(Error('PRIVATE_SOURCE_PATH_SENTINEL')) : captured);
    if (control.hold)
      return new Promise((resolve, reject) =>
        held.push(() => Promise.resolve().then(done).then(resolve, reject)),
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
        Date,
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
  const hook = load(resolve(root, 'components/platform/use-codex-skill-sources'));
  function render(commit = true) {
    cursor = 0;
    dirty = false;
    output = hook.useCodexSkillSources();
    if (commit) effects.splice(0).forEach((fn) => fn());
    return output;
  }
  async function flush() {
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
      if (dirty) render();
    }
    return output;
  }
  function unmount() {
    slots.forEach((slot) => slot?.cleanup?.());
  }
  return {
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
    release() {
      held.splice(0).forEach((fn) => fn());
    },
    reenterEffects() {
      slots.forEach((slot) => {
        if (slot?.effect) slot.cleanup = slot.effect();
      });
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
