import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
const root = fileURLToPath(new URL('../', import.meta.url));
export const workspace = `workspace-${'a'.repeat(24)}`;
export const uuid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
export const selectedSkill = () => ({
  id: `item-${'b'.repeat(24)}`,
  kind: 'skill',
  agent: 'shared',
  skillSource: 'agents-skills',
  scope: 'project',
  fileType: 'skill-tree',
  name: 'Release notes',
  sha256: 'c'.repeat(64),
  reviewedSha256: null,
  state: 'unreviewed',
  scan: { status: 'suspect', findings: 1 },
  capabilities: [],
});
export function signalHarness() {
  let cursor = 0,
    dirty = false,
    output,
    clock = Date.parse('2026-10-24T10:00:00.000Z'),
    serial = 0;
  const slots = [],
    effects = [],
    modules = new Map(),
    timers = new Map(),
    held = [],
    calls = [],
    plans = new Map();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const same = (a, b) =>
    a?.length === b.length && b.every((value, index) => Object.is(a[index], value));
  const react = {
    useRef(value) {
      return (slots[cursor++] ??= { current: value });
    },
    useState(value) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = { value: typeof value === 'function' ? value() : value };
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
        const previous = slots[at];
        slots[at] = { deps, effect: fn, cleanup: previous?.cleanup };
        effects.push(() => {
          previous?.cleanup?.();
          slots[at].cleanup = fn();
        });
      }
    },
  };
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
    }
    static now() {
      return clock;
    }
  }
  const props = { item: selectedSkill(), workspaceId: workspace },
    changed = [];
  const platform = { localAccess: true, localContext: { workspace: { id: workspace } } };
  function load(file) {
    if (!file.endsWith('.ts')) file += '.ts';
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    modules.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const importer = (name) => {
      if (name === 'react') return react;
      if (name === '@/components/platform-provider') return { usePlatform: () => platform };
      return load(
        name.startsWith('@/') ? resolve(root, name.slice(2)) : resolve(dirname(file), name),
      );
    };
    vm.runInThisContext(`(function(exports,require,Date,setTimeout,clearTimeout){${code}\n})`, {
      filename: file,
    })(
      exports,
      importer,
      FakeDate,
      (fn, delay) => {
        const id = ++serial;
        timers.set(id, { fn, at: clock + delay });
        return id;
      },
      (id) => timers.delete(id),
    );
    return exports;
  }
  const schema = load(resolve(root, 'lib/inventory-signal-decision'));
  const { isLocalOperation } = load(resolve(root, 'lib/local-operations'));
  function stateFor(item = props.item) {
    const at = new FakeDate().toISOString();
    return {
      schema: 'stroq-inventory-signal-state/1',
      source: 'local',
      generatedAt: at,
      workspaceId: props.workspaceId,
      artifact: {
        id: item.id,
        name: item.name,
        agent: item.agent,
        skillSource: item.skillSource,
        scope: item.scope,
        sha256: item.sha256,
      },
      binding: {
        workspaceId: props.workspaceId,
        itemId: item.id,
        agent: item.agent,
        skillSource: item.skillSource,
        scope: item.scope,
        artifactSha256: item.sha256,
        sourceSha256: 'd'.repeat(64),
        analysisSha256: 'e'.repeat(64),
      },
      eligible: true,
      reason: 'ready',
      store: { status: 'missing', revision: null },
      standing: 'unresolved',
      decision: null,
      history: { records: [], omitted: 0 },
      findings: 1,
      limitations: [...schema.INVENTORY_SIGNAL_LIMITATIONS],
    };
  }
  const control = { hold: '', bad: '', fail: '', state: stateFor(), preview: null, receipt: null };
  platform.requestLocal = async (path, body, signal) => {
    // Match the real provider boundary before emulating any HTTP response.
    if (!isLocalOperation(path)) throw new Error('Unsupported local operation.');
    const operation = path.endsWith('/state')
      ? 'load'
      : path.endsWith('/preview')
        ? 'preview'
        : 'apply';
    calls.push({ path, body: clone(body), signal, operation });
    let value;
    if (operation === 'load') value = clone(control.state);
    else if (operation === 'preview') {
      value = control.preview ?? {
        schema: 'stroq-inventory-signal-preview/1',
        source: 'local',
        workspaceId: props.workspaceId,
        previewId: uuid(++serial),
        expiresAt: new FakeDate(clock + 120000).toISOString(),
        decision: body.decision,
        reason: body.reason,
        expectedDecisionId: body.expectedDecisionId,
        state: clone(control.state),
        limitations: [...schema.INVENTORY_SIGNAL_LIMITATIONS],
      };
      plans.set(value.previewId, clone(value));
    } else {
      const plan = plans.get(body.previewId),
        at = new FakeDate().toISOString();
      const state = clone(plan.state),
        record = {
          id: uuid(++serial),
          binding: clone(state.binding),
          decision: plan.decision,
          reason: plan.reason,
          recordedAt: at,
        };
      Object.assign(state, {
        generatedAt: at,
        store: { status: 'ready', revision: 'f'.repeat(64) },
        standing: plan.decision === 'reopened' ? 'reopened' : 'applies',
        decision: record,
        history: { records: [record, ...state.history.records], omitted: 0 },
      });
      control.state = clone(state);
      value = control.receipt ?? {
        schema: 'stroq-inventory-signal-receipt/1',
        source: 'local',
        workspaceId: props.workspaceId,
        previewId: plan.previewId,
        recordId: record.id,
        decision: record.decision,
        recordedAt: at,
        state,
        baselineChanged: false,
        permissionsChanged: false,
      };
    }
    const done = () =>
      control.fail === operation
        ? Promise.reject(new Error('PRIVATE_FIXTURE'))
        : clone(control.bad === operation ? { ...value, unexpected: 'PRIVATE_FIXTURE' } : value);
    if (control.hold === operation)
      return new Promise((resolve, reject) =>
        held.push(() => Promise.resolve().then(done).then(resolve, reject)),
      );
    return done();
  };
  const hook = load(resolve(root, 'components/platform/use-inventory-signals'));
  function render(commit = true) {
    cursor = 0;
    dirty = false;
    output = hook.useInventorySignals(props.item, props.workspaceId, {
      onChanged: (state) => changed.push(state),
    });
    if (commit) effects.splice(0).forEach((effect) => effect());
    return output;
  }
  async function flush() {
    for (let index = 0; index < 50; index++) {
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
    changed,
    schema,
    stateFor,
    render,
    flush,
    unmount,
    get output() {
      return output;
    },
    release() {
      held.splice(0).forEach((release) => release());
    },
    remount() {
      unmount();
      slots.length = 0;
      effects.length = 0;
      render();
    },
    reenterEffects() {
      slots.forEach((slot) => {
        if (slot?.effect) slot.cleanup = slot.effect();
      });
    },
    async advance(ms) {
      clock += ms;
      for (const [id, timer] of timers)
        if (timer.at <= clock) {
          timers.delete(id);
          timer.fn();
        }
      await flush();
    },
  };
}
