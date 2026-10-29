import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { controlState } from './codex-skill-controls-client-fixtures.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript'),
  React = require('react'),
  jsx = require('react/jsx-runtime'),
  { renderToStaticMarkup } = require('react-dom/server');
export function harness(props = {}, agent = null, query = '') {
  let cursor = 0;
  const slots = [],
    elements = [],
    calls = [],
    modules = new Map();
  const sameDeps = (a, b) =>
    a?.length === b?.length && b.every((value, index) => Object.is(value, a[index]));
  const memo = (factory, deps) => {
    const at = cursor++;
    if (!slots[at] || !sameDeps(slots[at].deps, deps)) slots[at] = { deps, value: factory() };
    return slots[at].value;
  };
  const platform = {
    localAccess: props.connected !== false,
    localContext:
      props.connected === false ? null : { workspace: { id: 'workspace-' + 'a'.repeat(24) } },
    requestLocal: async (...args) => {
      calls.push(['requestLocal', ...args]);
      throw Error('Unexpected local request in render-only harness');
    },
  };
  const action = {
    available: true,
    report: null,
    busy: false,
    error: null,
    historical: false,
    inspect: () => calls.push('inspect'),
    cancel: () => calls.push('cancel'),
    markHistorical: () => calls.push('historical'),
  };
  const controls = {
    connected: true,
    state: controlState(),
    preview: null,
    ack: { shared: false, retention: false, weakening: false },
    available: true,
    busy: null,
    error: null,
    completion: null,
    canApply: false,
    pending: [],
    foreignPending: [],
    unscopedPending: [],
    refresh: () => calls.push('controls:refresh'),
    prepareDisable: (...args) => calls.push(['controls:disable', ...args]),
    prepareRestore: (record) => calls.push(['controls:restore', record]),
    acknowledge: (...args) => calls.push(['controls:ack', ...args]),
    apply: () => calls.push('controls:apply'),
    recheck: (record) => calls.push(['controls:recheck', record]),
    cancel: () => calls.push('controls:cancel'),
    clearPreview: () => calls.push('controls:clear'),
  };
  const wrapper =
    (tag) =>
    ({ children, ...props }) =>
      React.createElement(
        tag,
        Object.fromEntries(
          Object.entries(props).filter(
            ([k, v]) =>
              !k.startsWith('on') && typeof v !== 'function' && !['open', 'asChild'].includes(k),
          ),
        ),
        children,
      );
  const Dialog = {
    Root: ({ open, children }) =>
      open ? React.createElement(React.Fragment, null, children) : null,
    ...Object.fromEntries(
      ['Portal', 'Overlay', 'Content', 'Title', 'Description', 'Close'].map((k) => [
        k,
        wrapper(k === 'Title' ? 'h2' : k === 'Close' ? 'button' : 'div'),
      ]),
    ),
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
    const extra = '';
    vm.runInThisContext(`(function(exports,require){${code}${extra}\n})`, { filename: file })(
      exports,
      (name) => {
        if (name === 'react')
          return {
            useEffect() {},
            useCallback: (callback, deps) => memo(() => callback, deps),
            useMemo: memo,
            useRef(value) {
              return (slots[cursor++] ??= { current: value });
            },
            useState(value) {
              const at = cursor++;
              if (!(at in slots))
                slots[at] =
                  props.page && at === 0
                    ? { workspaceId: platform.localContext?.workspace.id, report: props.pageReport }
                    : typeof value === 'function'
                      ? value()
                      : value;
              return [
                slots[at],
                (next) => (slots[at] = typeof next === 'function' ? next(slots[at]) : next),
              ];
            },
          };
        if (name === 'react/jsx-runtime')
          return {
            ...jsx,
            jsx(type, props, ...rest) {
              elements.push({ type, props });
              return jsx.jsx(type, props, ...rest);
            },
            jsxs(type, props, ...rest) {
              elements.push({ type, props });
              return jsx.jsxs(type, props, ...rest);
            },
          };
        if (name === 'radix-ui') return { Dialog };
        if (name === 'next/navigation')
          return { useSearchParams: () => new URLSearchParams(query) };
        if (name === 'next/link')
          return { default: ({ children, ...props }) => React.createElement('a', props, children) };
        if (name === '@/components/platform-provider') return { usePlatform: () => platform };
        const stubs = {
          './agent-setup': 'SetupDialog',
          './agent-disconnect': 'AgentDisconnect',
          './live-proof': 'LiveProofDialog',
          './hook-check-dialog': 'HookCheckDialog',
          './credential-filters': 'CredentialFilters',
          './use-hook-check-history': 'useHookCheckHistory',
          './use-credential-filters': 'useCredentialFilters',
        };
        if (name === './use-credential-filters')
          return {
            useCredentialFilters: () => ({
              state: null,
              loading: false,
              error: null,
              refresh() {},
            }),
          };
        if (name === './use-hook-check-history')
          return {
            useHookCheckHistory: () => ({ state: null, busy: false, error: null, refresh() {} }),
          };
        if (stubs[name]) return { [stubs[name]]: () => null };
        if (name === 'lucide-react')
          return new Proxy({}, { get: () => () => React.createElement('svg') });
        if (name === '@/components/platform-ui')
          return {
            Badge: ({ children, tone }) =>
              React.createElement('span', { 'data-tone': tone }, children),
            AgentGlyph: ({ name }) => React.createElement('span', { 'data-brand': name }),
            ExportButton: () => null,
            PageHeading: ({ title }) => React.createElement('h1', null, title),
            Panel: ({ children }) => React.createElement('section', null, children),
            EmptyState: ({ title, description }) =>
              React.createElement('div', null, title, description),
          };
        if (name === './use-codex-skill-sources') return { useCodexSkillSources: () => action };
        if (name === './codex-network-guard')
          return { CodexNetworkGuard: () => React.createElement('div', null, 'Network guard') };
        if (name === './use-codex-skill-controls')
          return {
            useCodexSkillControls: (enabled) => {
              controls.enabled = enabled;
              return controls;
            },
          };
        if (name.startsWith('@/')) return load(resolve(root, name.slice(2)));
        if (name.startsWith('.')) return load(resolve(dirname(file), name));
        return require(name);
      },
    );
    return exports;
  }
  const component = load(
    resolve(
      root,
      props.page
        ? 'components/platform/agents.tsx'
        : agent
          ? 'components/platform/agent-card.tsx'
          : 'components/platform/codex-skill-sources.tsx',
    ),
  );
  function render() {
    cursor = 0;
    elements.length = 0;
    return renderToStaticMarkup(
      props.page
        ? React.createElement(component.AgentsPage)
        : agent
          ? React.createElement(component.AgentCard, {
              agent,
              scope: 'project',
              hookEvidence: { label: 'Not established' },
              filters: {},
              generation: 0,
            })
          : component.CodexSkillSources(props),
    );
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
    controls,
    calls,
    elements,
    Dialog,
    render,
    button,
    open() {
      render();
      button(props.compact ? 'Inspect' : 'Codex sources').props.onClick({
        currentTarget: { isConnected: true, focus() {} },
      });
      return render();
    },
  };
}
