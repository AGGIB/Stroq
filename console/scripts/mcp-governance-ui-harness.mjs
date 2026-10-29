import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { tsImport } from 'tsx/esm/api';
const f = await tsImport('../lib/mcp-governance-fixtures.ts', { parentURL: import.meta.url });
const root = fileURLToPath(new URL('../', import.meta.url)),
  require = createRequire(resolve(root, 'package.json')),
  ts = require('typescript'),
  React = require('react'),
  jsx = require('react/jsx-runtime'),
  { renderToStaticMarkup } = require('react-dom/server');
export function governanceUI(query = '', { effects: runEffects = false } = {}) {
  let cursor = 0;
  const slots = [],
    elements = [],
    calls = [],
    modules = new Map(),
    effectQueue = [],
    domRefs = new Set(),
    focused = [],
    scrolled = [];
  const sameDeps = (a, b) => a?.length === b.length && b.every((v, i) => Object.is(a[i], v));
  const guard = {
    state: f.governanceState(),
    capture: null,
    preview: null,
    receipt: null,
    ack: {
      scope: false,
      retention: false,
      weakening: false,
      interruptions: false,
      recovery: false,
      pendingReview: false,
    },
    selected: [],
    completion: null,
    pending: [],
    foreignPending: [],
    canApply: false,
    refresh: () => calls.push('refresh'),
    inspect: () => calls.push('capture'),
    prepare: () => calls.push('preview'),
    selectChoice: (...a) => calls.push(['select', ...a]),
    prepareRestore: (r) => calls.push(['guard:restore', r]),
    acknowledge: (...a) => calls.push(['guard:ack', ...a]),
    apply: () => calls.push('apply'),
    recheck: (r) => calls.push(['recheck', r]),
    clearPreview: () => calls.push('guard:clear'),
  };
  const action = {
    canPrepare: true,
    ...guard,
    busy: null,
    error: null,
    connected: true,
    workspaceId: f.governanceWorkspace,
    close: () => calls.push('close'),
  };
  const wrap =
    (tag) =>
    ({ children, ...p }) =>
      React.createElement(
        tag,
        Object.fromEntries(
          Object.entries(p).filter(
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
        wrap(k === 'Title' ? 'h2' : k === 'Close' ? 'button' : 'div'),
      ]),
    ),
  };
  function load(file) {
    if (!/\.tsx?$/.test(file)) file += existsSync(file + '.tsx') ? '.tsx' : '.ts';
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    modules.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    vm.runInThisContext(`(function(exports,require){${code}\n})`, { filename: file })(
      exports,
      (name) => {
        if (name === 'react')
          return {
            useRef: (v) => (slots[cursor++] ??= { current: v }),
            useState(v) {
              const at = cursor++;
              if (!(at in slots)) slots[at] = typeof v === 'function' ? v() : v;
              return [
                slots[at],
                (next) => (slots[at] = typeof next === 'function' ? next(slots[at]) : next),
              ];
            },
            useEffect(fn, deps) {
              if (!runEffects) return;
              const at = cursor++;
              if (!slots[at] || !sameDeps(slots[at].deps, deps)) {
                slots[at] = { deps };
                effectQueue.push(fn);
              }
            },
          };
        if (name === 'react/jsx-runtime')
          return {
            ...jsx,
            jsx(t, p, ...a) {
              elements.push({ type: t, props: p });
              return jsx.jsx(t, p, ...a);
            },
            jsxs(t, p, ...a) {
              elements.push({ type: t, props: p });
              return jsx.jsxs(t, p, ...a);
            },
          };
        if (name === 'radix-ui') return { Dialog };
        if (name === 'next/link') return { default: wrap('a') };
        if (name === 'next/navigation')
          return { useSearchParams: () => new URLSearchParams(query) };
        if (name === '@/components/platform-provider')
          return {
            usePlatform: () => ({
              localAccess: true,
              localContext: { workspace: { id: f.governanceWorkspace } },
            }),
          };
        if (name === '@/components/platform-ui')
          return {
            Panel: ({ children, title }) =>
              React.createElement(
                'section',
                null,
                React.createElement('h2', null, title),
                children,
              ),
            Badge: ({ children, tone }) =>
              React.createElement('span', { 'data-tone': tone }, children),
            AgentGlyph: ({ name }) => React.createElement('span', { 'data-brand': name }),
          };
        if (name === 'lucide-react')
          return new Proxy({}, { get: () => () => React.createElement('svg') });
        if (name === './use-mcp-governance')
          return {
            useMcpGovernance: (open) => {
              action.enabled = open;
              return action;
            },
          };
        return name.startsWith('@/')
          ? load(resolve(root, name.slice(2)))
          : name.startsWith('.')
            ? load(resolve(dirname(file), name))
            : require(name);
      },
    );
    return exports;
  }
  const component = load(resolve(root, 'components/platform/mcp-governance'));
  const render = () => {
    cursor = 0;
    elements.length = 0;
    return renderToStaticMarkup(component.McpGovernanceControls());
  };
  const button = (label) =>
    elements.find(
      (e) =>
        e.type === 'button' &&
        renderToStaticMarkup(React.createElement(React.Fragment, null, e.props.children)).replace(
          /<[^>]*>/g,
          '',
        ) === label,
    );
  return {
    action,
    calls,
    elements,
    focused,
    scrolled,
    Dialog,
    render,
    button,
    commit() {
      for (const ref of domRefs) ref.current = null;
      domRefs.clear();
      for (const e of elements) {
        const ref = e.props.ref;
        if (!ref || typeof ref !== 'object') continue;
        const children = e.props.children,
          label = e.props['data-governance-operation']
            ? `record:${e.props['data-governance-operation']}`
            : typeof children === 'string'
              ? children
              : Array.isArray(children)
                ? children.filter((v) => typeof v === 'string').join('')
                : (e.props.className ?? 'node');
        ref.current = {
          focus: (options) => focused.push({ label, options }),
          scrollIntoView: (options) => scrolled.push({ label, options }),
        };
        domRefs.add(ref);
      }
      effectQueue.splice(0).forEach((fn) => fn());
    },
    renderRestore(preview) {
      return renderToStaticMarkup(
        load(resolve(root, 'components/platform/policy-restore-preview')).PolicyRestorePreviewPanel(
          {
            action: {
              preview,
              busy: null,
              ack: {
                sharedScope: false,
                reducedProtection: false,
                backup: false,
                interruptions: false,
              },
              acknowledge() {},
              apply() {},
              canApply: false,
            },
          },
        ),
      );
    },
    open() {
      render();
      button('Govern MCP calls').props.onClick({
        currentTarget: { isConnected: true, focus() {} },
      });
      return render();
    },
  };
}
