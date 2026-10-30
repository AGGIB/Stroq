import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
const root = fileURLToPath(new URL('../', import.meta.url));
export const workspace = `workspace-${'a'.repeat(24)}`;
export const uuid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
export function quarantineHarness() {
  let cursor = 0,
    dirty = false,
    output,
    serial = 0,
    mode = 'action',
    clock = Date.parse('2026-10-24T10:00:00.000Z');
  const slots = [],
    effects = [],
    modules = new Map(),
    timers = new Map(),
    held = [],
    calls = [],
    completed = [];
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
        slots[at] = { deps, cleanup: previous?.cleanup };
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
  const props = {
    action: 'quarantine',
    workspaceId: workspace,
    disabled: false,
    artifact: {
      id: `item-${'b'.repeat(24)}`,
      name: 'notes',
      agent: 'codex',
      skillSource: 'codex-skills',
      location: { label: 'release/notes', redacted: false },
      scope: 'project',
      sha256: 'c'.repeat(64),
    },
    onCompleted: (value) => completed.push(value),
  };
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
  const schema = load(resolve(root, 'lib/skill-quarantine'));
  const control = { hold: '', fail: '', bad: '', preview: null, receipt: null, state: null };
  const plans = new Map();
  const stateFor = (records = []) => ({
    schema: 'stroq-skill-quarantine/2',
    source: 'local',
    generatedAt: new FakeDate().toISOString(),
    workspaceId: workspace,
    available: true,
    reason: null,
    records,
    gaps: [],
    limitations: [...schema.SKILL_QUARANTINE_LIMITATIONS],
  });
  platform.requestLocal = async (path, body, signal) => {
    const operation = path.endsWith('/preview')
      ? 'preview'
      : path.endsWith('/apply')
        ? 'apply'
        : 'recheck';
    calls.push({ path, body: body === undefined ? undefined : clone(body), signal, operation });
    let value;
    if (operation === 'preview') {
      value = control.preview ?? {
        schema: 'stroq-skill-quarantine-preview/2',
        source: 'local',
        workspaceId: workspace,
        id: uuid(++serial),
        recordId: props.recordId ?? uuid(++serial),
        action: props.action,
        artifact: clone(props.artifact),
        expiresAt: new FakeDate(clock + 120000).toISOString(),
        files: 1,
        bytes: 44,
        effect: props.action === 'quarantine' ? 'remove-discovery-path' : 'restore-discovery-path',
        requiresNewSession: true,
        affectsAllWorkspaces: props.artifact.scope === 'user',
        limitations: [...schema.SKILL_QUARANTINE_LIMITATIONS],
      };
      plans.set(value.id, clone(value));
    } else if (operation === 'apply') {
      const plan = plans.get(body.previewId);
      value = control.receipt ?? {
        schema: 'stroq-skill-quarantine-receipt/2',
        source: 'local',
        workspaceId: workspace,
        id: plan.id,
        recordId: plan.recordId,
        action: plan.action,
        artifact: clone(plan.artifact),
        completedAt: new FakeDate().toISOString(),
        status: plan.action === 'quarantine' ? 'quarantined' : 'restored',
        effect: plan.effect,
        evidence: 'discovery-path',
        requiresNewSession: true,
        reviewBaselineChanged: false,
        hostEnforcement: false,
      };
    } else value = control.state ?? stateFor();
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
  const { useQuarantineAction } = load(resolve(root, 'components/platform/use-quarantine-action'));
  const { useSkillQuarantine } = load(resolve(root, 'components/platform/use-skill-quarantine'));
  function render(commit = true) {
    cursor = 0;
    dirty = false;
    output = mode === 'history' ? useSkillQuarantine() : useQuarantineAction(props);
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
  const unmount = () => slots.forEach((slot) => slot?.cleanup?.());
  return {
    props,
    platform,
    control,
    calls,
    completed,
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
    mountHistory() {
      unmount();
      slots.length = 0;
      effects.length = 0;
      mode = 'history';
      render();
    },
    mountAction() {
      unmount();
      slots.length = 0;
      effects.length = 0;
      mode = 'action';
      render();
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
