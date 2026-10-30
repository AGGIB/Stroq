import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { signalHarness, uuid } from './inventory-signal-client-harness.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript'),
  React = require('react'),
  jsx = require('react/jsx-runtime'),
  { renderToStaticMarkup } = require('react-dom/server');
function harness() {
  const base = signalHarness(),
    calls = [],
    elements = [],
    slots = [],
    modules = new Map();
  let cursor = 0;
  const action = {
    state: base.stateFor(),
    preview: null,
    acknowledged: false,
    busy: null,
    needsRecheck: false,
    error: null,
    prepare: (...args) => calls.push(['prepare', ...args]),
    apply: () => calls.push(['apply']),
    refresh: () => calls.push(['refresh']),
    invalidate: () => calls.push(['invalidate']),
    acknowledge: (value) => calls.push(['ack', value]),
  };
  function load(file) {
    if (!/\.tsx?$/.test(file)) file += existsSync(file + '.tsx') ? '.tsx' : '.ts';
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    modules.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    const importer = (name) => {
      if (name === 'react')
        return {
          useRef(value) {
            return (slots[cursor++] ??= { current: value });
          },
          useState(value) {
            const at = cursor++;
            if (!(at in slots)) slots[at] = typeof value === 'function' ? value() : value;
            return [
              slots[at],
              (next) => {
                slots[at] = typeof next === 'function' ? next(slots[at]) : next;
              },
            ];
          },
          useEffect() {},
        };
      if (name === 'react/jsx-runtime')
        return {
          ...jsx,
          jsx: (type, props, ...rest) => {
            elements.push({ type, props });
            return jsx.jsx(type, props, ...rest);
          },
          jsxs: (type, props, ...rest) => {
            elements.push({ type, props });
            return jsx.jsxs(type, props, ...rest);
          },
        };
      if (name === 'lucide-react')
        return new Proxy({}, { get: () => () => React.createElement('svg') });
      if (name === '@/components/platform-ui')
        return {
          Badge: ({ children, tone }) =>
            React.createElement('span', { 'data-tone': tone }, children),
        };
      if (name.startsWith('@/')) return load(resolve(root, name.slice(2)));
      if (name.startsWith('.')) return load(resolve(dirname(file), name));
      return require(name);
    };
    vm.runInThisContext(`(function(exports,require){${code}\n})`, { filename: file })(
      exports,
      importer,
    );
    return exports;
  }
  const { InventorySignalControls, InventorySignalBadge } = load(
    resolve(root, 'components/platform/inventory-signal-controls.tsx'),
  );
  const text = (children) =>
    renderToStaticMarkup(React.createElement(React.Fragment, null, children))
      .replace(/<[^>]*>/g, '')
      .trim();
  return {
    action,
    calls,
    elements,
    render(disabled = false) {
      cursor = 0;
      elements.length = 0;
      return renderToStaticMarkup(
        React.createElement(InventorySignalControls, { action, disabled }),
      );
    },
    badge(decision) {
      return renderToStaticMarkup(React.createElement(InventorySignalBadge, { decision }));
    },
    button(label) {
      return elements.find(
        ({ type, props }) => type === 'button' && text(props.children) === label,
      );
    },
    select(label, value) {
      elements
        .find(({ type, props }) => type === 'select' && props['aria-label'] === label)
        .props.onChange({ target: { value } });
    },
    preview(decision = 'accepted-risk', reason = 'required-use') {
      action.preview = {
        schema: 'stroq-inventory-signal-preview/1',
        source: 'local',
        workspaceId: action.state.workspaceId,
        previewId: uuid(1),
        expiresAt: '2026-10-24T10:02:00.000Z',
        decision,
        reason,
        expectedDecisionId: action.state.decision?.id ?? null,
        state: action.state,
        limitations: [...action.state.limitations],
      };
    },
    saved(decision = 'accepted-risk') {
      const state = action.state,
        record = {
          id: uuid(2),
          binding: state.binding,
          decision,
          reason: decision === 'accepted-risk' ? 'required-use' : 'test-or-example',
          recordedAt: state.generatedAt,
        };
      Object.assign(state, {
        standing: 'applies',
        decision: record,
        store: { status: 'ready', revision: 'f'.repeat(64) },
        history: { records: [record], omitted: 0 },
      });
    },
  };
}
test('decision editor starts unchecked with fixed choices and no mutation from rendering', () => {
  const h = harness(),
    html = h.render();
  assert.match(html, /Signal decision/);
  assert.match(html, /Accept risk/);
  assert.match(html, /False positive/);
  assert.doesNotMatch(html, /<textarea|type="text"|data-tone="green"|Mark safe/);
  assert.equal(h.button('Preview decision').props.disabled, true);
  assert.deepEqual(h.calls, []);
  h.select('Signal decision', 'accepted-risk');
  h.render();
  h.select('Decision reason', 'required-use');
  h.render();
  assert.equal(h.button('Preview decision').props.disabled, false);
  h.button('Preview decision').props.onClick();
  assert.deepEqual(h.calls.at(-1), ['prepare', 'accepted-risk', 'required-use']);
});
test('preview shows exact root, revision, analysis and scope with independent explicit acknowledgement', () => {
  const h = harness();
  h.preview();
  let html = h.render();
  assert.match(html, /aria-label="Signal decision preview"/);
  assert.match(html, /\.agents\/skills/);
  assert.match(html, new RegExp(h.action.state.artifact.sha256));
  assert.match(html, new RegExp(h.action.state.binding.analysisSha256));
  assert.match(html, /New, changed and incomplete items remain separate/);
  assert.equal(h.button('Save decision').props.disabled, true);
  h.elements
    .find(({ type, props }) => type === 'input' && props.type === 'checkbox')
    .props.onChange({ target: { checked: true } });
  assert.deepEqual(h.calls.at(-1), ['ack', true]);
  h.action.acknowledged = true;
  h.render();
  assert.equal(h.button('Save decision').props.disabled, false);
  h.button('Save decision').props.onClick();
  assert.deepEqual(h.calls.at(-1), ['apply']);
  h.button('Cancel').props.onClick();
  assert.deepEqual(h.calls.at(-1), ['invalidate']);
});
test('a saved local assessment remains neutral, retains original signals and offers explicit reopen preview', () => {
  const h = harness();
  h.saved();
  let html = h.render();
  assert.match(html, /Risk accepted/);
  assert.match(html, /Needed for this workflow/);
  assert.doesNotMatch(html, /data-tone="green"|Protected|Safe|Preview decision/);
  h.button('Reopen signals').props.onClick();
  assert.deepEqual(h.calls.at(-1), ['prepare', 'reopened', 'reconsidered']);
  h.preview('reopened', 'reconsidered');
  html = h.render();
  assert.match(html, /return to Protection/);
  assert.equal(h.button('Reopen signals').props.disabled, true);
});
test('historical, incomplete and unavailable states never masquerade as applicable assessments', () => {
  const h = harness();
  h.saved('false-positive');
  h.action.state.standing = 'stale';
  assert.match(h.render(), /Needs a new decision/);
  assert.ok(h.button('Preview decision'));
  Object.assign(h.action.state, { eligible: false, reason: 'incomplete', binding: null });
  const html = h.render();
  assert.match(html, /Complete inspection required/);
  assert.equal(h.button('Preview decision'), undefined);
  h.action.state = null;
  h.action.error = 'State unavailable.';
  h.action.needsRecheck = true;
  assert.match(h.render(), /Recheck required/);
  h.button('Recheck decision').props.onClick();
  assert.deepEqual(h.calls.at(-1), ['refresh']);
  assert.equal(
    h.calls.some(([kind]) => kind === 'apply'),
    false,
  );
});
test('changing assessment clears the fixed reason and a replaced analysis clears editor input', () => {
  const h = harness();
  h.render();
  h.select('Signal decision', 'accepted-risk');
  h.render();
  h.select('Decision reason', 'required-use');
  h.render();
  h.select('Signal decision', 'false-positive');
  h.render();
  assert.equal(h.button('Preview decision').props.disabled, true);
  h.select('Decision reason', 'test-or-example');
  h.render();
  assert.equal(h.button('Preview decision').props.disabled, false);
  h.action.state = structuredClone(h.action.state);
  h.action.state.binding.analysisSha256 = '1'.repeat(64);
  h.render();
  assert.equal(h.button('Preview decision').props.disabled, true);
});
test('list badges stay neutral for applicable assessments and never label stale decisions as current', () => {
  const h = harness();
  h.saved('false-positive');
  assert.match(
    h.badge({ standing: 'applies', record: h.action.state.decision }),
    /Marked false positive/,
  );
  assert.doesNotMatch(
    h.badge({ standing: 'applies', record: h.action.state.decision }),
    /data-tone="green"/,
  );
  assert.match(
    h.badge({ standing: 'stale', record: h.action.state.decision }),
    /Needs a new decision/,
  );
  assert.equal(h.badge({ standing: 'unresolved', record: null }), '');
  assert.equal(h.badge({ standing: 'unavailable', record: null }), '');
});
