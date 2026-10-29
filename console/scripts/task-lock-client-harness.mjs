import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
export const wa = 'workspace-' + 'a'.repeat(24),
  wb = 'workspace-' + 'b'.repeat(24),
  ta = 'task-' + 'c'.repeat(64),
  tb = 'task-' + 'd'.repeat(64),
  permit = 'e'.repeat(64),
  policy = 'f'.repeat(64);
export const clone = (v) => JSON.parse(JSON.stringify(v));
export const uuid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
export function harness(selected = true) {
  let cursor = 0,
    dirty = false,
    output,
    clock = Date.parse('2026-10-23T01:00:00.000Z'),
    nextTimer = 0,
    mode = 'ok',
    serial = 0,
    standing = 'present';
  const slots = [],
    effects = [],
    timers = new Map(),
    calls = [],
    held = [],
    modules = new Map();
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
    }
    static now() {
      return clock;
    }
  }
  const same = (a, b) => a?.length === b.length && b.every((v, i) => Object.is(a[i], v));
  const react = {
    useRef(value) {
      const at = cursor++;
      return (slots[at] ??= { current: value });
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
        slots[at] = { deps, cleanup: previous?.cleanup, fn };
        effects.push(() => {
          previous?.cleanup?.();
          slots[at].cleanup = fn();
        });
      }
    },
  };
  let selection = selected
    ? { requested: true, invalid: false, taskId: ta, workspaceId: wa }
    : { requested: false, invalid: false, taskId: null, workspaceId: null };
  const platform = { localAccess: true, localContext: { workspace: { id: wa } } };
  function load(file) {
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
        setTimeout(fn, delay) {
          const id = ++nextTimer;
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
  const schema = load(resolve(root, 'lib/task-locks')),
    pageSchema = load(resolve(root, 'lib/task-lock-page'));
  function row(id = ta) {
    return {
      id,
      permitSha256: permit,
      profile: 'repo-edit-and-test',
      policySha256: policy,
      issuedAt: '2026-10-23T00:00:00.000Z',
      expiresAt: '2026-10-23T12:00:00.000Z',
      declaredMode: 'srt',
      eligibility: 'eligible',
      standing: id === ta ? standing : 'present',
      policyRelation: 'matches-current',
      scope: {
        tools: ['Read', 'Write'],
        shell: 'allowed',
        read: { allow: [], deny: [] },
        write: { allow: [], deny: [] },
        net: { mode: 'none' },
        mcp: [],
      },
      evidence: { status: 'missing', journalSha256: null, counts: null, lastGate: null },
    };
  }
  function state() {
    return {
      schema: 'stroq-task-locks/1',
      workspaceId: platform.localContext.workspace.id,
      host: 'claude-code',
      checkedAt: new FakeDate().toISOString(),
      currentPolicySha256: policy,
      available: true,
      reason: null,
      coverage: { complete: true, limited: false, unverified: 0, foreign: 0 },
      tasks: [row(), row(tb)],
      limitations: [...schema.TASK_LOCK_LIMITATIONS],
    };
  }
  const plans = new Map();
  async function request(path, body, signal) {
    calls.push({ path, body, signal });
    let value;
    if (path.endsWith('/preview')) {
      value = {
        schema: 'stroq-task-lock-preview/1',
        id: uuid(++serial),
        workspaceId: platform.localContext.workspace.id,
        createdAt: new FakeDate().toISOString(),
        expiresAt: new FakeDate(clock + 120000).toISOString(),
        task: row(body.id),
        bindingSha256: '1'.repeat(64),
        canApply: standing === 'present',
        reason: standing === 'present' ? null : 'already-revoked',
      };
      plans.set(value.id, clone(value));
      if (mode === 'wrong-preview-workspace') value.workspaceId = wb;
      if (mode === 'wrong-preview-permit') value.task.permitSha256 = '2'.repeat(64);
      if (mode === 'wrong-preview-scope') value.task.scope.shell = 'denied';
      if (mode === 'private-preview') value.raw = 'PRIVATE_FIXTURE';
    } else if (path.endsWith('/apply')) {
      const preview = plans.get(body.previewId);
      assert.ok(preview);
      standing = 'revoked';
      value = {
        schema: 'stroq-task-lock-receipt/1',
        id: uuid(++serial),
        previewId: preview.id,
        workspaceId: preview.workspaceId,
        taskId: preview.task.id,
        permitSha256: preview.task.permitSha256,
        status: 'revoked',
        checkedAt: new FakeDate().toISOString(),
        markerSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        storeReadback: 'revoked',
        gateDecision: 'deny',
        gateRule: 'task-void:revoked',
        evidence: 'isolated-gate-evaluation',
        hostTermination: 'unverified',
        irreversible: true,
      };
      if (mode === 'wrong-receipt-id') value.previewId = uuid(999);
      if (mode === 'wrong-receipt-permit') value.permitSha256 = '2'.repeat(64);
      if (mode === 'foreign-receipt') value.workspaceId = wb;
      if (mode === 'private-receipt') value.raw = 'PRIVATE_FIXTURE';
    } else {
      if (['page-stale', 'page-expired', 'lookup-limit'].includes(mode))
        throw new Error(
          {
            'page-stale': 'task-page-stale',
            'page-expired': 'task-page-expired',
            'lookup-limit': 'task-lookup-limit',
          }[mode],
        );
      if (mode === 'failed-read') throw new Error('PRIVATE_FIXTURE');
      value = state();
      if (mode === 'foreign-read') value.workspaceId = wb;
      if (mode === 'unavailable-read') {
        value.available = false;
        value.reason = 'context-unavailable';
        value.coverage.complete = false;
        value.tasks = [];
      }
      if (mode === 'missing-task') value.tasks = [row(tb)];
      if (mode === 'reappeared-read') value.tasks[0].standing = 'present';
    }
    if (path === '/api/task-locks/page') {
      if (body !== undefined)
        assert(
          pageSchema.validateTaskLockPageRequest(clone(body)),
          'Only closed cursor/exact lookup reads',
        );
      let index = 1,
        nextCursor = null,
        catalogLimited = false;
      if (
        mode === 'pages' ||
        mode === 'hold-page' ||
        mode === 'page-stale' ||
        mode === 'page-expired'
      ) {
        index =
          body?.cursor === uuid(500) || body?.id === ta ? 2 : body?.cursor === uuid(501) ? 3 : 1;
        nextCursor = index === 1 ? uuid(500) : index === 2 ? uuid(501) : null;
        value.tasks = index === 2 ? [row()] : [row(tb)];
        value.coverage = {
          complete: false,
          limited: true,
          unverified: 0,
          foreign: index === 1 ? 64 : 0,
        };
      }
      if (mode === 'hard-catalog') {
        catalogLimited = true;
        value.coverage = { complete: false, limited: true, unverified: 0, foreign: 64 };
        value.tasks = [];
      }
      value = {
        schema: 'stroq-task-lock-page/1',
        state: value,
        page: { index, nextCursor, catalogLimited },
      };
      if (mode === 'private-page') value.listing = { sha256: 'PRIVATE_FIXTURE' };
    }
    if (!mode.startsWith('private'))
      assert.equal(
        path.endsWith('/preview')
          ? schema.validateTaskLockPreview(value)
          : path.endsWith('/apply')
            ? schema.validateTaskLockReceipt(value)
            : pageSchema.validateTaskLockPage(value),
        true,
        `fixture ${mode} ${path}`,
      );
    if (mode === 'hold-read-failure' && path === '/api/task-locks/page')
      return new Promise((_done, reject) => held.push(() => reject(new Error('PRIVATE_FIXTURE'))));
    if (
      ((mode === 'hold-read' || mode === 'hold-page') && path === '/api/task-locks/page') ||
      (mode === 'hold-preview' && path.endsWith('/preview')) ||
      (mode === 'hold-apply' && path.endsWith('/apply'))
    )
      return new Promise((done) => held.push(() => done(clone(value))));
    return clone(value);
  }
  platform.requestLocal = request;
  const hook = load(resolve(root, 'components/platform/use-task-locks'));
  function render() {
    cursor = 0;
    dirty = false;
    effects.length = 0;
    output = hook.useTaskLocks(selection);
    effects.splice(0).forEach((fn) => fn());
    return output;
  }
  async function flush() {
    for (let i = 0; i < 100; i++) {
      await Promise.resolve();
      if (dirty) render();
    }
    return output;
  }
  return {
    calls,
    timers,
    render,
    flush,
    get output() {
      return output;
    },
    mode(value) {
      mode = value;
    },
    async context(values = {}, workspace, access) {
      selection = { ...selection, ...values };
      if (workspace) platform.localContext = { workspace: { id: workspace } };
      if (access !== undefined) platform.localAccess = access;
      const immediate = render();
      await flush();
      return immediate;
    },
    async reconnect() {
      platform.requestLocal = (...args) => request(...args);
      render();
      await flush();
    },
    async reconnectContext() {
      platform.localContext = { workspace: { id: platform.localContext.workspace.id } };
      render();
      await flush();
    },
    async routeImmediate(values) {
      selection = { ...selection, ...values };
      cursor = 0;
      dirty = false;
      output = hook.useTaskLocks(selection);
      return output;
    },
    release() {
      held.splice(0).forEach((fn) => fn());
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
    async prepare() {
      await output.prepare();
      await flush();
    },
    async apply() {
      await output.apply();
      await flush();
    },
    async strictCycle() {
      slots.forEach((slot) => slot?.cleanup?.());
      slots.forEach((slot) => {
        if (slot?.fn) slot.cleanup = slot.fn();
      });
      await flush();
    },
    unmount() {
      slots.forEach((slot) => slot?.cleanup?.());
    },
  };
}
