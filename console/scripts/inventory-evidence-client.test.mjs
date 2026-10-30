import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = `workspace-${'a'.repeat(24)}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const item = (agent = 'shared', skillSource = 'agents-skills') => ({
  id: `item-${'b'.repeat(24)}`,
  kind: 'skill',
  agent,
  skillSource,
  scope: 'project',
  fileType: 'skill-tree',
  name: 'Release notes',
  sha256: 'c'.repeat(64),
  reviewedSha256: null,
  state: 'unreviewed',
  scan: { status: 'clean', findings: 0 },
  capabilities: [],
  quarantineSupported: false,
});

/** Executes the actual evidence hook, validators and source binding with controlled async IO. */
function harness(initial = item()) {
  let cursor = 0,
    dirty = false,
    output,
    clock = 0,
    serial = 0;
  const slots = [],
    effects = [],
    modules = new Map(),
    calls = [],
    held = [],
    timers = new Map();
  const props = { item: initial, workspaceId: workspace };
  const platform = { localAccess: true, localContext: { workspace: { id: workspace } } };
  const control = { hold: false, responseSource: null };
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
  function load(file) {
    if (!file.endsWith('.ts')) file += '.ts';
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    modules.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
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
  const schema = load(resolve(root, 'lib/inventory-changes'));
  const evidenceSchema = load(resolve(root, 'lib/inventory-evidence'));
  function comparison(selected) {
    const at = '2026-10-24T01:00:00.000Z';
    const artifact = {
      id: selected.id,
      kind: selected.kind,
      agent: selected.agent,
      scope: selected.scope,
      name: selected.name,
      sha256: selected.sha256,
      digestFormat: 'stroq-tree/1',
      ...(selected.skillSource === undefined ? {} : { skillSource: selected.skillSource }),
    };
    const current = {
      schema: 'stroq-inventory-evidence/1',
      source: 'local',
      generatedAt: at,
      workspaceId: workspace,
      artifact,
      engine: {
        version: '0.28.0',
        rulesSha256: 'd'.repeat(64),
        ruleCount: 100,
        inspectorRulesId: 'stroq-vet-rules/2',
        threshold: 0.6,
        target: 'instruction_file',
      },
      scan: { status: 'clean', score: 0, findings: 0, timedOut: false },
      capabilities: [],
      files: [
        {
          id: `file-${'e'.repeat(24)}`,
          label: 'SKILL.md',
          labelHidden: false,
          sha256: selected.sha256,
          bytes: 120,
          markdown: true,
          scan: { status: 'clean', score: 0, findings: 0 },
        },
      ],
      matches: [],
      coverage: {
        capturedFiles: 1,
        markdownFiles: 1,
        scannedMarkdownFiles: 1,
        omittedFileDetails: 0,
        omittedMatchDetails: 0,
        incomplete: false,
        gaps: [],
      },
      mcp: null,
      capture: { startedAt: at, completedAt: at, atomicSnapshot: false },
      limitations: [...evidenceSchema.INVENTORY_EVIDENCE_LIMITATIONS],
    };
    const result = {
      schema: 'stroq-inventory-comparison/1',
      source: 'local',
      generatedAt: at,
      workspaceId: workspace,
      current,
      baseline: { status: 'missing', reviewedAt: null, sha256: null, evidence: null },
      changes: null,
      limitations: [...schema.INVENTORY_COMPARISON_LIMITATIONS],
    };
    assert.equal(
      schema.validateInventoryComparison(result),
      true,
      'The response fixture is independently valid',
    );
    return result;
  }
  platform.requestLocal = (path, input, signal) => {
    calls.push({ path, input: clone(input), signal });
    const selected = clone(props.item);
    if (control.responseSource) selected.skillSource = control.responseSource;
    const response = comparison(selected);
    return control.hold
      ? new Promise((resolve) => held.push(() => resolve(clone(response))))
      : Promise.resolve(clone(response));
  };
  const hook = load(resolve(root, 'components/platform/use-inventory'));
  function render(commit = true) {
    cursor = 0;
    dirty = false;
    output = hook.useInventoryEvidence(props.item, props.workspaceId);
    if (commit) effects.splice(0).forEach((effect) => effect());
    return output;
  }
  async function flush() {
    for (let index = 0; index < 30; index++) {
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
    render,
    flush,
    get output() {
      return output;
    },
    release() {
      held.splice(0).forEach((release) => release());
    },
    unmount() {
      slots.forEach((slot) => slot?.cleanup?.());
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

test('shared source launches its read-only comparison and reaches a terminal captured report', async () => {
  const h = harness();
  h.render();
  await h.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, '/api/inventory/compare');
  assert.deepEqual(h.calls[0].input, {
    id: h.props.item.id,
    expectedSha256: h.props.item.sha256,
    expectedReviewedSha256: null,
  });
  assert.equal(h.output.loading, false);
  assert.equal(h.output.error, null);
  assert.equal(h.output.report.artifact.skillSource, 'agents-skills');
  h.unmount();
});
test('all fixed skill sources and legacy Claude complete with matching provenance', async () => {
  for (const [agent, source] of [
    ['claude-code', 'claude-skills'],
    ['shared', 'agents-skills'],
    ['codex', 'codex-skills'],
    ['cursor', 'cursor-skills'],
    ['windsurf', 'windsurf-skills'],
    ['windsurf', 'devin-skills'],
    ['claude-code', undefined],
  ]) {
    const selected = item(agent, source);
    if (source === undefined) delete selected.skillSource;
    const h = harness(selected);
    h.render();
    await h.flush();
    assert.equal(h.calls.length, 1, `${agent}:${source}`);
    assert.equal(h.output.loading, false, `${agent}:${source}`);
    assert.equal(h.output.error, null, `${agent}:${source}`);
    assert.equal(h.output.report.artifact.skillSource, source);
    h.unmount();
  }
});
test('missing or foreign shared provenance never dispatches or appears perpetually loading', async () => {
  for (const source of [undefined, 'claude-skills', 'custom-root']) {
    const selected = item();
    selected.skillSource = source;
    const h = harness(selected);
    h.render();
    await h.flush();
    assert.equal(h.calls.length, 0);
    assert.equal(h.output.loading, false);
    assert.equal(h.output.report, null);
    h.unmount();
  }
});
test('source changes hide old evidence synchronously and fence late responses and retained refresh', async () => {
  const h = harness(item('windsurf', 'windsurf-skills'));
  h.control.hold = true;
  h.render();
  await h.flush();
  const oldRefresh = h.output.refresh;
  assert.equal(h.calls.length, 1);
  h.props.item = { ...h.props.item, skillSource: 'devin-skills' };
  h.render();
  assert.equal(h.output.report, null);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].signal.aborted, true);
  oldRefresh();
  await h.flush();
  assert.equal(h.calls.length, 2, 'An old source callback cannot refresh the new source');
  h.release();
  await h.flush();
  assert.equal(h.output.loading, false);
  assert.equal(h.output.error, null);
  assert.equal(h.output.report.artifact.skillSource, 'devin-skills');
  h.unmount();
});
test('a valid comparison from a different source fails closed instead of becoming current evidence', async () => {
  const h = harness(item('windsurf', 'devin-skills'));
  h.control.responseSource = 'windsurf-skills';
  h.render();
  await h.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.output.report, null);
  assert.equal(h.output.loading, false);
  assert.match(h.output.error, /could not be verified/);
  h.unmount();
});
test('a held shared read has a visible deadline and late evidence cannot replace the timeout', async () => {
  const h = harness();
  h.control.hold = true;
  h.render();
  await h.flush();
  assert.equal(h.calls.length, 1);
  await h.advance(35_000);
  assert.equal(h.output.loading, false);
  assert.match(h.output.error, /timed out/);
  h.release();
  await h.flush();
  assert.equal(h.output.report, null);
  assert.match(h.output.error, /timed out/);
  h.unmount();
});
