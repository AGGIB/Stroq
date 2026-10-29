import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { workspace, uuid } from './quarantine-client-harness.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript'),
  React = require('react'),
  jsx = require('react/jsx-runtime'),
  { renderToStaticMarkup } = require('react-dom/server');
const sources = [
  ['claude-skills', 'claude-code', '.claude/skills'],
  ['agents-skills', 'shared', '.agents/skills'],
  ['codex-skills', 'codex', '.codex/skills'],
  ['cursor-skills', 'cursor', '.cursor/skills'],
  ['windsurf-skills', 'windsurf', '.windsurf/skills'],
  ['devin-skills', 'windsurf', '.devin/skills'],
];
function harness() {
  const modules = new Map(),
    elements = [],
    calls = [],
    slots = [];
  let cursor = 0;
  const artifact = {
    id: `item-${'b'.repeat(24)}`,
    name: 'notes',
    agent: 'codex',
    skillSource: 'codex-skills',
    location: { label: 'release/notes', redacted: false },
    scope: 'project',
    sha256: 'c'.repeat(64),
  };
  const control = {
    preview: null,
    busy: null,
    acknowledged: false,
    needsRecheck: false,
    error: null,
    prepare: () => calls.push(['preview']),
    apply: () => calls.push(['apply']),
    recheck: () => calls.push(['recheck']),
    acknowledge: (value) => calls.push(['ack', value]),
    cancel: () => calls.push(['cancel']),
  };
  const record = {
    id: uuid(4),
    artifact,
    createdAt: '2026-10-24T09:00:00.000Z',
    restoredAt: null,
    checkedAt: '2026-10-24T10:00:00.000Z',
    files: 1,
    bytes: 44,
    status: 'quarantined',
    original: 'absent',
    payload: 'match',
  };
  const page = {
    localAccess: true,
    workspaceId: workspace,
    state: {
      workspaceId: workspace,
      generatedAt: record.checkedAt,
      available: true,
      records: [record],
      gaps: [],
      limitations: ['Local retention'],
    },
    loading: false,
    error: null,
    refresh: () => calls.push(['refresh']),
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
              !['open', 'asChild'].includes(key),
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
          useRef: (value) => (slots[cursor++] ??= { current: value }),
          useEffect() {},
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
        return { default: ({ children, ...props }) => React.createElement('a', props, children) };
      if (name === 'next/navigation') return { useSearchParams: () => new URLSearchParams() };
      if (name === 'lucide-react')
        return new Proxy({}, { get: () => () => React.createElement('svg') });
      if (name === 'radix-ui')
        return {
          Dialog: {
            Root: ({ open, children }) =>
              open ? React.createElement(React.Fragment, null, children) : null,
            ...Object.fromEntries(
              ['Portal', 'Overlay', 'Content', 'Title', 'Description', 'Close'].map((key) => [
                key,
                wrapper(key === 'Title' ? 'h2' : key === 'Close' ? 'button' : 'div'),
              ]),
            ),
          },
        };
      if (name === '@/components/platform-ui')
        return {
          Badge: ({ children, tone }) =>
            React.createElement('span', { 'data-tone': tone }, children),
          AgentGlyph: ({ name }) => React.createElement('span', { 'data-brand': name }),
          Panel: ({ children, title, actions }) =>
            React.createElement('section', null, title, actions, children),
          PageHeading: ({ title, actions }) => React.createElement('header', null, title, actions),
          EmptyState: ({ title, description }) =>
            React.createElement('p', null, title, description),
          ExportButton: () => null,
        };
      if (name === '@/components/local-link') return { CopyLocalLink: () => null };
      if (name === './inventory') return { SkillsTabs: () => null };
      if (name === './use-quarantine-action') return { useQuarantineAction: () => control };
      if (name === './use-skill-quarantine') return { useSkillQuarantine: () => page };
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
  const { QuarantineAction } = load(resolve(root, 'components/platform/quarantine-action')),
    { QuarantineDetail } = load(resolve(root, 'components/platform/quarantine-detail')),
    { SkillQuarantinePage } = load(resolve(root, 'components/platform/skill-quarantine'));
  const render = (component, props) => {
    cursor = 0;
    elements.length = 0;
    return renderToStaticMarkup(React.createElement(component, props));
  };
  return {
    artifact,
    control,
    record,
    page,
    elements,
    calls,
    action: () =>
      render(QuarantineAction, {
        action: 'quarantine',
        artifact,
        workspaceId: workspace,
        onCompleted: () => calls.push(['completed']),
      }),
    detail: () =>
      render(QuarantineDetail, {
        record,
        workspaceId: workspace,
        href: '/skills/quarantine/',
        limitations: ['Local retention'],
        disabled: false,
        onClose() {},
        onReturnFocus() {},
        onCompleted() {},
      }),
    history: () => render(SkillQuarantinePage),
    button(label) {
      return elements.find(
        ({ type, props }) =>
          type === 'button' &&
          renderToStaticMarkup(React.createElement(React.Fragment, null, props.children))
            .replace(/<[^>]*>/g, '')
            .trim() === label,
      );
    },
    preview() {
      control.preview = {
        id: uuid(1),
        artifact,
        affectsAllWorkspaces: artifact.scope === 'user',
        files: 1,
        bytes: 44,
        limitations: ['Local retention'],
        expiresAt: '2026-10-24T10:02:00.000Z',
      };
    },
  };
}
test('actual preview renders the exact finite source, nested location and revision for all six roots', () => {
  for (const [skillSource, agent, root] of sources) {
    const h = harness();
    Object.assign(h.artifact, { skillSource, agent });
    h.preview();
    const html = h.action();
    assert.match(html, /aria-label="Selected source folder"/);
    assert.ok(html.includes(root));
    assert.match(html, /release\/notes/);
    assert.ok(html.includes(h.artifact.sha256));
    assert.doesNotMatch(html, /Protected|Activated|data-tone="green"/);
    assert.equal(h.button('Quarantine version').props.disabled, true);
    const checkbox = h.elements.find(
      ({ type, props }) => type === 'input' && props.type === 'checkbox',
    );
    assert.equal(checkbox.props.checked, false);
    checkbox.props.onChange({ target: { checked: true } });
    assert.deepEqual(h.calls, [['ack', true]]);
    h.control.acknowledged = true;
    h.action();
    assert.equal(h.button('Quarantine version').props.disabled, false);
  }
});
test('unknown completion exposes a real explicit recheck and hides physical preview/apply controls', () => {
  const h = harness();
  h.control.needsRecheck = true;
  h.action();
  assert.equal(h.button('Preview quarantine'), undefined);
  assert.equal(h.button('Quarantine version'), undefined);
  h.button('Recheck retained folders').props.onClick();
  assert.deepEqual(h.calls, [['recheck']]);
});
test('retained history and recovery details identify nested source copies without assuming Claude', () => {
  const h = harness();
  let html = h.history();
  assert.match(html, /<th>Source<\/th>/);
  assert.match(html, /\.codex\/skills/);
  assert.match(html, /release\/notes/);
  assert.doesNotMatch(html, /Claude Code/);
  html = h.detail();
  assert.match(html, /aria-label="Retained source folder"/);
  assert.match(html, /Preview restore/);
  const exported = h.elements.find(({ props }) => props.label === 'Export evidence').props.data();
  assert.equal(exported.schema, 'stroq-quarantine-export/2');
  assert.equal(exported.record.artifact.skillSource, 'codex-skills');
  h.record.original = 'different';
  h.record.status = 'reappeared';
  html = h.detail();
  assert.match(html, /Original folder is occupied/);
  assert.doesNotMatch(html, /Preview restore/);
  h.record.original = 'absent';
  h.record.payload = 'changed';
  h.record.status = 'payload-changed';
  html = h.detail();
  assert.match(html, /Retained files changed/);
  assert.doesNotMatch(html, /Preview restore/);
});
test('shared personal source explains its scope once while retaining neutral status', () => {
  const h = harness();
  Object.assign(h.artifact, { skillSource: 'agents-skills', agent: 'shared', scope: 'user' });
  h.preview();
  const html = h.action();
  assert.match(html, /User · all workspaces/);
  assert.match(html, /shared source can be read by more than one agent/);
  assert.doesNotMatch(html, /Claude Code|Codex CLI|data-tone="green"/);
});
test('legacy nested or managed payloads remain readable without offering a multi-skill restore', () => {
  for (const [restoreBlock, message] of [
    ['overlapping-skill', 'Contains nested skills. Multi-skill restore is unavailable.'],
    ['managed-source', 'Managed or plugin content requires separate recovery.'],
  ]) {
    const h = harness();
    h.record.restoreBlock = restoreBlock;
    const html = h.detail();
    assert.ok(html.includes(message));
    assert.match(html, /aria-label="Retained source folder"/);
    assert.match(html, /release\/notes/);
    assert.doesNotMatch(html, /Preview restore|Restore files/);
    const exported = h.elements.find(({ props }) => props.label === 'Export evidence').props.data();
    assert.equal(exported.record.restoreBlock, restoreBlock);
    assert.match(h.history(), /release\/notes/);
    assert.deepEqual(h.calls, []);
  }
});
