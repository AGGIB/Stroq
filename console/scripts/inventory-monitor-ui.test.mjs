import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { workspace, runtime, revision, uuid } from './inventory-monitor-client-harness.mjs';
import {
  inventoryMonitorFixtures,
  observation,
  observedArtifact,
} from './inventory-monitor-fixtures.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  require = createRequire(resolve(root, 'package.json')),
  ts = require('typescript'),
  React = require('react'),
  jsx = require('react/jsx-runtime'),
  { renderToStaticMarkup } = require('react-dom/server');
function harness() {
  const calls = [],
    elements = [],
    slots = [],
    modules = new Map();
  let cursor = 0;
  const state = inventoryMonitorFixtures.state();
  const action = {
    state,
    workspaceId: workspace,
    preview: null,
    ack: { localChecks: false, userSources: false, retention: false },
    freshness: 'current',
    busy: null,
    needsRecheck: false,
    pollStopped: false,
    error: null,
    prepare: (kind) => calls.push(['prepare', kind]),
    refresh: () => calls.push(['refresh']),
    invalidate: () => calls.push(['invalidate']),
    acknowledge: (...args) => calls.push(['ack', ...args]),
    apply: () => calls.push(['apply']),
  };
  const wrapper =
    (tag) =>
    ({ children, ...props }) =>
      React.createElement(
        tag,
        Object.fromEntries(
          Object.entries(props).filter(
            ([key, value]) =>
              !key.startsWith('on') &&
              typeof value !== 'function' &&
              !['asChild', 'open'].includes(key),
          ),
        ),
        children,
      );
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
            if (!(at in slots)) slots[at] = value;
            return [
              slots[at],
              (next) => {
                slots[at] = typeof next === 'function' ? next(slots[at]) : next;
              },
            ];
          },
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
      if (name === 'next/link')
        return {
          default: ({ children, href, ...props }) =>
            React.createElement('a', { href, ...props }, children),
        };
      if (name === 'radix-ui')
        return {
          Dialog: {
            Root: ({ open, children }) =>
              open ? React.createElement(React.Fragment, null, children) : null,
            ...Object.fromEntries(
              ['Portal', 'Overlay', 'Content', 'Title', 'Description', 'Close'].map((name) => [
                name,
                wrapper(name === 'Title' ? 'h2' : name === 'Close' ? 'button' : 'div'),
              ]),
            ),
          },
        };
      if (name === 'lucide-react')
        return new Proxy({}, { get: () => () => React.createElement('svg') });
      if (name === '@/components/platform-ui')
        return {
          Badge: ({ children, tone }) =>
            React.createElement('span', { 'data-tone': tone }, children),
          AgentGlyph: ({ name }) => React.createElement('span', { 'data-brand': name }),
          ExportButton: () => null,
        };
      if (name === './use-inventory-monitor') return { useInventoryMonitor: () => action };
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
  const { InventoryMonitor } = load(resolve(root, 'components/platform/inventory-monitor.tsx'));
  function render() {
    elements.length = 0;
    cursor = 0;
    return renderToStaticMarkup(InventoryMonitor());
  }
  function button(label) {
    return elements.find(
      ({ type, props }) =>
        type === 'button' &&
        renderToStaticMarkup(React.createElement(React.Fragment, null, props.children)).replace(
          /<[^>]*>/g,
          '',
        ) === label,
    );
  }
  return {
    action,
    state,
    calls,
    elements,
    render,
    button,
    open(label = 'Watch sources') {
      render();
      button(label).props.onClick({ currentTarget: { isConnected: true, focus() {} } });
      return render();
    },
  };
}
test('inventory watch starts off, requires explicit preparation and keeps limits collapsed', () => {
  const h = harness(),
    html = h.render();
  assert.match(html, /Skills &amp; MCP watch/);
  assert.match(html, />Off</);
  assert.doesNotMatch(html, /data-tone="green"|Protected|All agents secured|<details[^>]*open/);
  assert.deepEqual(h.calls, []);
  h.open();
  assert.deepEqual(h.calls, [['prepare', 'enable']]);
});
test('enable requires three separate unchecked local-check, source-scope and retention acknowledgements', () => {
  const h = harness();
  h.open();
  h.action.preview = { id: uuid(1), action: 'enable', expiresAt: '2026-10-24T01:02:00.000Z' };
  const html = h.render();
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /checked=""/);
  assert.equal(h.button('Enable watch').props.disabled, true);
  h.action.ack = { localChecks: true, userSources: false, retention: true };
  h.render();
  assert.equal(h.button('Enable watch').props.disabled, true);
  h.action.ack.userSources = true;
  h.render();
  assert.equal(h.button('Enable watch').props.disabled, false);
});
test('capture health remains separate from saved Watching intent after failed and skipped attempts', () => {
  for (const status of ['failed', 'skipped']) {
    const h = harness(),
      record = observation();
    Object.assign(h.state, {
      status: 'enabled',
      latestCaptureId: record.id,
      latestCheckId: uuid(501),
      history: { status: 'ready', revision: 'f'.repeat(64), records: [record], omitted: 0 },
      lastAttempt: {
        status,
        startedAt: '2026-10-24T01:00:00.000Z',
        finishedAt: '2026-10-24T01:00:01.000Z',
        error: status === 'skipped' ? 'inventory-busy' : 'inventory-unavailable',
        checkId: uuid(502),
        captureId: null,
      },
    });
    const html = h.render();
    assert.match(html, />Watching</);
    assert.match(html, status === 'failed' ? /Last check failed/ : /Check waiting/);
    assert.match(html, /Previous capture remains historical/);
    assert.match(html, /Last captured/);
    assert.doesNotMatch(html, /data-tone="green"|Up to date/);
  }
});
test('history retains first and last observations and links exact source versions without current review claims', () => {
  const h = harness(),
    record = observation({
      id: uuid(503),
      lastObservedAt: '2026-10-24T01:00:00.000Z',
      changes: {
        status: 'comparable',
        fromId: uuid(500),
        total: 2,
        rows: [
          {
            kind: 'changed',
            artifact: observedArtifact,
            beforeSha256: 'a'.repeat(64),
            afterSha256: 'b'.repeat(64),
          },
        ],
        omitted: 1,
      },
    });
  Object.assign(h.state, {
    latestCaptureId: record.id,
    latestCheckId: uuid(504),
    history: { status: 'ready', revision: 'f'.repeat(64), records: [record], omitted: 3 },
  });
  h.render();
  h.button('Observed versions').props.onClick();
  const html = h.render();
  assert.match(html, /Historical capture/);
  assert.match(html, /First observed/);
  assert.match(html, /Last observed/);
  assert.match(html, /~\/\.agents\/skills/);
  assert.match(html, /release\/notes/);
  assert.ok(
    html.includes(
      `workspace=${workspace}&amp;item=${observedArtifact.id}&amp;sha=${'b'.repeat(64)}`,
    ),
  );
  assert.match(html, /1 additional change rows are omitted/);
  assert.match(html, /3 earlier versions are outside this history view/);
  assert.doesNotMatch(
    html,
    /Mark version reviewed|Accept risk|Quarantine version|data-tone="green"/,
  );
  const exported = h.elements
    .find(({ props }) => props.label === 'Export observed version')
    .props.data();
  assert.equal(exported.currentReview, false);
  assert.equal(exported.hostEnforcement, false);
  assert.equal(exported.record.id, record.id);
});
test('first, partial, runtime-changed and missing history outcomes remain explicit', () => {
  for (const [status, message] of [
    ['first', 'First observed version'],
    ['partial', 'Missing items are unconfirmed'],
    [
      'runtime-changed',
      'Source scope or analysis runtime changed. Source differences are unavailable.',
    ],
  ]) {
    const h = harness(),
      record = observation({
        complete: status !== 'partial',
        gaps: status === 'partial' ? 1 : 0,
        changes: {
          status,
          fromId: status === 'first' ? null : uuid(499),
          total: 0,
          rows: [],
          omitted: 0,
        },
      });
    Object.assign(h.state, {
      latestCaptureId: record.id,
      latestCheckId: uuid(501),
      history: { status: 'ready', revision: 'f'.repeat(64), records: [record], omitted: 0 },
    });
    h.render();
    h.button('Observed versions').props.onClick();
    assert.ok(h.render().includes(message));
  }
});
test('closing a completed preview returns focus to a live control when the original enable button disappeared', () => {
  const h = harness(),
    focused = [];
  h.render();
  h.button('Watch sources').props.onClick({
    currentTarget: {
      isConnected: false,
      disabled: false,
      focus: () => focused.push('stale-trigger'),
    },
  });
  h.state.status = 'enabled';
  h.render();
  const refresh = h.elements.find(
    ({ props }) => props['aria-label'] === 'Refresh inventory watch state',
  );
  refresh.props.ref.current = {
    isConnected: true,
    disabled: false,
    focus: () => focused.push('refresh'),
  };
  h.elements
    .find(({ props }) => 'intent' in props && typeof props.onReturnFocus === 'function')
    .props.onReturnFocus();
  assert.deepEqual(focused, ['refresh']);
});
test('unknown write remains visibly unresolved and offers a saved-state read without optimistic success', () => {
  const h = harness();
  h.action.needsRecheck = true;
  const html = h.render();
  assert.match(html, /Recheck required|completion is unknown/);
  assert.equal(h.button('Watch sources').props.disabled, true);
  h.button('Recheck saved state').props.onClick();
  assert.deepEqual(h.calls, [['refresh']]);
  assert.doesNotMatch(html, /data-tone="green"/);
});
