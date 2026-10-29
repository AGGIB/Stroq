import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { workspace, runtime, revision, uuid } from './workspace-monitor-client-harness.mjs';
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
  const state = {
    schema: 'stroq-workspace-monitor/1',
    workspaceId: workspace,
    reason: null,
    runtimeSha256: runtime,
    revision,
    status: 'disabled',
    intervalMs: 300000,
    lastAttempt: null,
    nextCheckAt: null,
    configuredAt: '2026-10-24T00:00:00.000Z',
    activeRunId: null,
  };
  const action = {
    state,
    workspaceId: workspace,
    preview: null,
    ack: { localChecks: false, retention: false },
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
        };
      if (name === './use-workspace-monitor') return { useWorkspaceMonitor: () => action };
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
  const { WorkspaceMonitor } = load(resolve(root, 'components/platform/workspace-monitor.tsx'));
  function render() {
    elements.length = 0;
    cursor = 0;
    return renderToStaticMarkup(WorkspaceMonitor());
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
    open(label = 'Watch changes') {
      render();
      button(label).props.onClick({ currentTarget: { isConnected: true, focus() {} } });
      return render();
    },
  };
}
test('watch is a compact explicit control with collapsed limits and no protection claim', () => {
  const h = harness(),
    html = h.render();
  assert.match(html, /Change watch/);
  assert.match(html, /Every 5 minutes/);
  assert.match(html, />Off</);
  assert.match(html, /<details class="workspace-monitor-limits"><summary>Scope &amp; limits/);
  assert.doesNotMatch(html, /data-tone="green"|Protected|Agent secured|<details[^>]*open/);
  assert.deepEqual(h.calls, []);
});
test('enable requires both unchecked acknowledgements; pause has a separate explicit confirmation', () => {
  const h = harness();
  h.open();
  assert.deepEqual(h.calls, [['prepare', 'enable']]);
  h.action.preview = { id: uuid(1), action: 'enable', expiresAt: '2026-10-24T01:02:00.000Z' };
  let html = h.render();
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /checked=""/);
  assert.equal(h.button('Enable watch').props.disabled, true);
  h.action.ack = { localChecks: true, retention: true };
  h.render();
  assert.equal(h.button('Enable watch').props.disabled, false);
  h.action.preview = null;
  h.state.status = 'enabled';
  h.open('Pause watch');
  h.action.preview = { id: uuid(2), action: 'pause', expiresAt: '2026-10-24T01:02:00.000Z' };
  html = h.render();
  assert.match(html, /Saved reports remain\. Accepted checks may finish\./);
  assert.doesNotMatch(html, /Future checks stop/);
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.equal(h.button('Pause watch').props.disabled, false);
});
test('exact last attempt link carries recorded workspace and run; skipped checks fabricate no report', () => {
  const h = harness();
  h.state.lastAttempt = {
    startedAt: '2026-10-24T01:00:00.000Z',
    finishedAt: '2026-10-24T01:00:01.000Z',
    error: null,
    runId: uuid(9),
    status: 'completed',
  };
  let html = h.render();
  assert.match(
    html,
    new RegExp(`/protection/workspace/\\?workspace=${workspace}&amp;run=${uuid(9)}`),
  );
  assert.match(html, /Last attempt/);
  h.state.lastAttempt = { ...h.state.lastAttempt, runId: null, status: 'skipped' };
  html = h.render();
  assert.doesNotMatch(html, /Open recorded check|run=/);
});
test('uncertain writes disable mutations and offer an explicit read without optimistic success', () => {
  const h = harness();
  h.action.needsRecheck = true;
  const html = h.render();
  assert.match(html, /Recheck required|completion is unknown/);
  assert.equal(h.button('Watch changes').props.disabled, true);
  h.button('Recheck saved state').props.onClick();
  assert.deepEqual(h.calls, [['refresh']]);
  assert.doesNotMatch(html, /data-tone="green"/);
});
test('workspace review integrates watch only inside the verified workspace branch', () => {
  const source = readFileSync(resolve(root, 'components/platform/workspace-review.tsx'), 'utf8');
  assert.match(source, /import \{ WorkspaceMonitor \} from '\.\/workspace-monitor'/);
  assert.ok(source.indexOf('<WorkspaceMonitor />') > source.indexOf('!read.allowed ?'));
});
test('persisted unavailable and other-console watches retain an enabled Pause control', () => {
  for (const status of ['needs-review', 'in-use', 'unavailable']) {
    const h = harness();
    Object.assign(h.state, { status, runtimeSha256: null, reason: 'runtime-unavailable' });
    let html = h.render();
    assert.equal(h.button('Pause watch')?.props.disabled, false, status);
    assert.equal(h.button('Watch changes'), undefined);
    h.open('Pause watch');
    h.action.preview = { id: uuid(8), action: 'pause', expiresAt: '2026-10-24T01:02:00.000Z' };
    html = h.render();
    assert.match(html, /Saved reports remain\. Accepted checks may finish\./);
    assert.doesNotMatch(html, /Pause cancels/);
    assert.equal(h.button('Pause watch').props.disabled, false);
  }
});
