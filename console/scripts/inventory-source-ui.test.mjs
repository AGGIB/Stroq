import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url)),
  require = createRequire(resolve(root, 'package.json')),
  ts = require('typescript'),
  React = require('react'),
  jsx = require('react/jsx-runtime'),
  { renderToStaticMarkup } = require('react-dom/server');
const workspace = `workspace-${'a'.repeat(24)}`;
const sources = [
  ['claude-skills', 'claude-code', '.claude/skills'],
  ['agents-skills', 'shared', '.agents/skills'],
  ['codex-skills', 'codex', '.codex/skills'],
  ['cursor-skills', 'cursor', '.cursor/skills'],
  ['windsurf-skills', 'windsurf', '.windsurf/skills'],
  ['devin-skills', 'windsurf', '.devin/skills'],
];
const skill = (index = 0, changes = {}) => ({
  id: `item-${String(index + 1).padStart(24, '0')}`,
  name: 'release-notes',
  kind: 'skill',
  agent: sources[index][1],
  skillSource: sources[index][0],
  location: { label: 'release-notes', redacted: false },
  quarantineSupported: true,
  quarantineReason: 'supported',
  scope: 'project',
  fileType: 'skill-tree',
  sha256: 'b'.repeat(64),
  reviewedSha256: null,
  state: 'unreviewed',
  scan: { status: 'clean', findings: 0 },
  capabilities: [],
  ...changes,
});
function harness() {
  const calls = [],
    elements = [],
    modules = new Map(),
    slots = [];
  let cursor = 0,
    query = '';
  const data = {
    schema: 'stroq-inventory/1',
    source: 'local',
    generatedAt: '2026-10-24T00:00:00.000Z',
    workspace: { id: workspace, label: 'Fixture workspace' },
    baseline: { status: 'missing', reviewedAt: null },
    items: sources.map((_, index) => skill(index)),
    gaps: [],
    limitations: [],
    skillSources: sources.flatMap(([id], index) =>
      ['project', 'user'].map((scope) => ({
        id,
        scope,
        status: index === 1 ? 'partial' : scope === 'user' ? 'absent' : 'complete',
        candidates: scope === 'user' ? 0 : 1,
      })),
    ),
  };
  const action = {
    localAccess: true,
    data,
    loading: false,
    reviewing: false,
    error: null,
    needsRecheck: false,
    refresh: () => calls.push(['refresh']),
    review: (item) => calls.push(['review', item.id]),
  };
  const platform = {
    localAccess: true,
    localContext: { workspace: { id: workspace } },
    requestLocal: async (path, body) => {
      calls.push(['governance-request', path, body]);
      return null;
    },
  };
  const evidence = { error: null, loading: false };
  const signalAction = { state: null, busy: null, error: null, needsRecheck: false };
  const signalSelections = [];
  const callControlSelections = [];
  globalThis.window = {
    history: {
      pushState(_state, _unused, href) {
        calls.push(['navigate', href]);
        query = new URL(href, 'http://fixture.local').search.slice(1);
      },
      replaceState(_state, _unused, href) {
        calls.push(['navigate', href]);
        query = new URL(href, 'http://fixture.local').search.slice(1);
      },
    },
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
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    const importer = (name) => {
      if (name === 'react')
        return {
          useEffect() {}, // Static server rendering does not run effects.
          useCallback(callback, deps) {
            const at = cursor++;
            const before = slots[at];
            if (
              !before ||
              before.deps.length !== deps.length ||
              deps.some((v, i) => !Object.is(v, before.deps[i]))
            )
              slots[at] = { deps, callback };
            return slots[at].callback;
          },
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
      if (name === 'next/navigation') return { useSearchParams: () => new URLSearchParams(query) };
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
              ['Portal', 'Overlay', 'Content', 'Title', 'Description', 'Close'].map((key) => [
                key,
                wrapper(key === 'Title' ? 'h2' : key === 'Close' ? 'button' : 'div'),
              ]),
            ),
          },
        };
      if (name === 'lucide-react')
        return new Proxy(
          {},
          { get: (_target, key) => () => React.createElement('svg', { 'data-icon': key }) },
        );
      if (name === '@/components/platform-provider') return { usePlatform: () => platform };
      if (name === '@/components/platform-ui')
        return {
          Badge: ({ children, tone }) =>
            React.createElement('span', { 'data-tone': tone }, children),
          Panel: ({ children, title, actions }) =>
            React.createElement(
              'section',
              null,
              title && React.createElement('h2', null, title),
              actions,
              children,
            ),
          PageHeading: ({ title, actions }) =>
            React.createElement('header', null, React.createElement('h1', null, title), actions),
          EmptyState: ({ title, description }) =>
            React.createElement('div', null, title, description),
          AgentGlyph: ({ name }) => React.createElement('span', { 'data-brand': name }, name),
          ExportButton: () => null,
        };
      if (name === '@/components/local-link') return { CopyLocalLink: () => null };
      if (name === './use-inventory')
        return {
          useInventory: () => action,
          useInventoryEvidence: (item) => ({
            ...evidence,
            comparison: evidence.comparison ?? null,
            report:
              item && !evidence.error
                ? {
                    artifact: { kind: item.kind, digestFormat: 'stroq-tree/1' },
                    scan: { status: 'clean', findings: 0 },
                  }
                : null,
            refresh: () => calls.push(['refresh-details']),
          }),
        };
      if (name === './use-inventory-signals')
        return {
          useInventorySignals: (item, workspaceId) => {
            signalSelections.push({ item, workspaceId });
            return signalAction;
          },
        };
      if (name === './inventory-monitor')
        return {
          InventoryMonitor: () =>
            React.createElement('section', { 'data-inventory-watch': 'enabled-control' }),
        };
      if (name === './codex-skill-sources')
        return { CodexSkillSources: () => React.createElement('button', null, 'Codex sources') };
      if (name === './inventory-signal-controls')
        return {
          InventorySignalControls: () => null,
          InventorySignalBadge: ({ decision }) =>
            decision?.standing === 'applies'
              ? React.createElement('span', null, 'Risk accepted')
              : null,
        };
      if (name === './inventory-evidence')
        return {
          InventoryEvidencePanel: () => React.createElement('div', null, 'Captured evidence'),
        };
      if (name === './inventory-changes')
        return {
          InventoryChangesPanel: () =>
            React.createElement('div', { 'data-comparison': 'captured' }, 'Comparison evidence'),
        };
      if (name === './quarantine-action')
        return {
          QuarantineAction: (props) =>
            React.createElement(
              'section',
              { 'data-quarantine': props.artifact.id },
              'Quarantine action',
            ),
        };
      if (name === './mcp-containment-action')
        return {
          McpContainmentAction: (props) =>
            React.createElement('section', { 'data-mcp-action': props.action }, props.action),
        };
      if (name === './mcp-call-control')
        return {
          McpCallControl: (props) => {
            callControlSelections.push(props);
            return React.createElement(
              'section',
              { 'data-call-control': props.target.id },
              'Call control',
            );
          },
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
  const { InventoryPage } = load(resolve(root, 'components/platform/inventory.tsx'));
  return {
    data,
    action,
    evidence,
    signalAction,
    signalSelections,
    callControlSelections,
    calls,
    elements,
    render() {
      cursor = 0;
      elements.length = 0;
      return renderToStaticMarkup(InventoryPage());
    },
    query(value) {
      query = value;
    },
    select(item, extra = {}) {
      query = new URLSearchParams({
        workspace,
        item: item.id,
        ...extra,
        ...(item.sha256 ? { sha: item.sha256 } : {}),
      }).toString();
    },
    button(label) {
      return elements.find(
        ({ type, props }) =>
          type === 'button' &&
          renderToStaticMarkup(React.createElement(React.Fragment, null, props.children))
            .replace(/<[^>]*>/g, '')
            .trim() === label,
      );
    },
  };
}

test('inventory heading exposes one manual Codex sources entry without starting review or watch', () => {
  const h = harness();
  assert.equal((h.render().match(/Codex sources/g) ?? []).length, 1);
  assert.deepEqual(h.calls, []);
});
test('same skill names retain six distinct fixed roots and a neutral shared source', () => {
  const h = harness(),
    html = h.render();
  assert.match(html, /<th>Source<\/th>/);
  for (const [, , folder] of sources) assert.ok(html.includes(`<code>${folder}</code>`), folder);
  assert.match(html, /Shared source/);
  assert.match(html, /data-brand="Codex CLI"/);
  assert.doesNotMatch(html, /data-brand="Shared|data-brand="undefined"|Protected|Activated/);
  assert.deepEqual(h.calls, []);
});
test('inventory watch defers current-source refresh while an artifact dialog or review is active', () => {
  const h = harness();
  h.render();
  let watch = h.elements.find(({ props }) => typeof props.onCheck === 'function');
  assert.equal(watch.props.canRefresh, true);
  assert.equal(watch.props.onCheck('check'), true);
  assert.deepEqual(h.calls, [['refresh']]);
  h.calls.length = 0;
  h.select(h.data.items[0]);
  h.render();
  watch = h.elements.find(({ props }) => typeof props.onCheck === 'function');
  assert.equal(watch.props.canRefresh, false);
  assert.equal(watch.props.onCheck('check'), false);
  assert.deepEqual(h.calls, []);
  h.query('');
  h.action.reviewing = true;
  h.render();
  watch = h.elements.find(({ props }) => typeof props.onCheck === 'function');
  assert.equal(watch.props.canRefresh, false);
  assert.equal(watch.props.onCheck('check'), false);
  h.action.reviewing = false;
  h.action.needsRecheck = true;
  h.render();
  watch = h.elements.find(({ props }) => typeof props.onCheck === 'function');
  assert.equal(
    watch.props.canRefresh,
    false,
    'An uncertain baseline write still needs an explicit inventory recheck',
  );
  assert.equal(watch.props.onCheck('check'), false);
});
test('inventory search includes the finite source root and does not collapse equal names', () => {
  const h = harness();
  h.render();
  h.elements
    .find(({ type, props }) => type === 'input' && props.name === 'inventory-search')
    .props.onChange({ target: { value: '.agents/skills' } });
  const html = h.render();
  assert.equal((html.match(/class="inventory-name"/g) ?? []).length, 1);
  assert.match(html, /Shared source/);
  assert.doesNotMatch(html, /data-brand="Claude Code"|data-brand="Codex CLI"/);
  assert.deepEqual(h.calls, []);
});
test('equal names have distinct accessible review controls bound to their source and scope', () => {
  const h = harness();
  h.render();
  const labels = h.elements
    .filter(
      ({ type, props }) =>
        type === 'button' && props['aria-label']?.startsWith('Review release-notes'),
    )
    .map(({ props }) => props['aria-label']);
  assert.equal(new Set(labels).size, 6);
  for (const [, , folder] of sources)
    assert.ok(
      labels.some((label) => label.includes(folder)),
      folder,
    );
  assert.ok(labels.every((label) => label.includes('Workspace')));
});
test('coverage lists fixed folder outcomes without claiming host loading and remains collapsed', () => {
  const h = harness(),
    html = h.render();
  assert.match(html, /aria-label="Skill source coverage"/);
  assert.equal((html.match(/class="inventory-source-coverage-row"/g) ?? []).length, 12);
  assert.match(html, /Read/);
  assert.match(html, /Absent/);
  assert.match(html, /Partial/);
  assert.match(html, /does not establish which skills an agent loaded/);
  assert.doesNotMatch(html, /<details class="panel" open/);
  delete h.data.skillSources;
  assert.match(h.render(), /Source coverage unavailable for this capture/);
});
test('artifact dialog allows only positively eligible skills from all six verified fixed roots', () => {
  for (let index = 0; index < sources.length; index++) {
    const h = harness(),
      item = h.data.items[index];
    h.select(item);
    const html = h.render();
    assert.match(html, /aria-label="Artifact source"/);
    assert.equal(html.includes('data-quarantine='), true);
    item.quarantineSupported = false;
    assert.doesNotMatch(h.render(), /data-quarantine=/);
    assert.deepEqual(h.calls, []);
  }
});
test('legacy inventory stays inspectable without guessing a physical action location', () => {
  const h = harness(),
    item = h.data.items[0];
  delete item.skillSource;
  delete item.quarantineSupported;
  delete item.quarantineReason;
  delete item.location;
  h.select(item);
  const html = h.render();
  assert.match(html, /aria-label="Artifact source"/);
  assert.doesNotMatch(html, /data-quarantine=/);
  assert.match(html, /<code>\.claude\/skills<\/code>/);
});
test('nested equal-leaf skills remain distinguishable and searchable by their safe relative location', () => {
  const h = harness(),
    first = h.data.items[2];
  h.data.items = [
    { ...first, location: { label: 'release/notes', redacted: false } },
    {
      ...first,
      id: `item-${'f'.repeat(24)}`,
      location: { label: 'review/notes', redacted: false },
    },
  ];
  const html = h.render();
  assert.match(html, /release\/notes/);
  assert.match(html, /review\/notes/);
  const labels = h.elements
    .filter(
      ({ type, props }) =>
        type === 'button' && props['aria-label']?.startsWith('Review release-notes'),
    )
    .map(({ props }) => props['aria-label']);
  assert.equal(new Set(labels).size, 2);
  h.elements
    .find(({ type, props }) => type === 'input' && props.name === 'inventory-search')
    .props.onChange({ target: { value: 'review/notes' } });
  assert.equal((h.render().match(/class="inventory-name"/g) ?? []).length, 1);
  assert.deepEqual(h.calls, []);
});
test('withheld folder labels keep distinct accessible identities and do not leak a physical path', () => {
  const h = harness(),
    first = h.data.items[2];
  h.data.items = [
    { ...first, location: { label: 'Folder name withheld', redacted: true } },
    {
      ...first,
      id: `item-${'f'.repeat(24)}`,
      location: { label: 'Folder name withheld', redacted: true },
    },
  ];
  const html = h.render();
  assert.match(html, /Folder name withheld · 00000003/);
  assert.match(html, /Folder name withheld · ffffffff/);
  const labels = h.elements
    .filter(
      ({ type, props }) =>
        type === 'button' && props['aria-label']?.startsWith('Review release-notes'),
    )
    .map(({ props }) => props['aria-label']);
  assert.equal(new Set(labels).size, 2);
  assert.doesNotMatch(html, /\/Users\/|\/home\//);
});
test('a Devin source is labelled as Devin rather than displaying another product brand', () => {
  const h = harness();
  h.select(h.data.items[5]);
  const html = h.render();
  assert.match(html, /Devin/);
  const selectedOrigin = h.elements.filter(
    ({ props }) => props.item?.skillSource === 'devin-skills',
  );
  assert.ok(selectedOrigin.length);
  h.data.items = [h.data.items[5]];
  assert.doesNotMatch(h.render(), /data-brand="Windsurf"/);
});
test('managed, overlapping, root and incomplete skills explain unavailable physical containment', () => {
  for (const [quarantineReason, label] of [
    ['source-root', 'source root'],
    ['overlapping-skill', 'overlapping skills'],
    ['managed-source', 'managed'],
    ['unsafe-location', 'location'],
    ['incomplete', 'complete capture'],
  ]) {
    const h = harness(),
      item = h.data.items[2];
    Object.assign(item, { quarantineSupported: false, quarantineReason });
    h.select(item);
    assert.match(h.render(), new RegExp(label, 'i'));
    assert.doesNotMatch(h.render(), /data-quarantine=/);
  }
});
test('a changed source selection cannot reopen a different equal-name artifact', () => {
  const h = harness(),
    old = h.data.items[1];
  h.select(old);
  h.render();
  h.data.items = h.data.items.filter((item) => item.id !== old.id);
  const html = h.render();
  assert.match(html, /This artifact is no longer available in the inventory/);
  assert.doesNotMatch(html, /aria-label="Artifact source"|data-quarantine=/);
  assert.deepEqual(h.calls, []);
});
test('existing MCP registration actions stay scoped to supported agents', () => {
  const h = harness(),
    item = skill(3, {
      kind: 'mcp',
      skillSource: undefined,
      quarantineSupported: undefined,
      fileType: 'mcp-config',
      mcp: { transport: 'stdio', wrapper: 'not-configured', strict: false },
    });
  h.data.items = [item];
  h.select(item);
  assert.equal((h.render().match(/data-mcp-action=/g) ?? []).length, 3);
  assert.deepEqual(h.callControlSelections.at(-1).target, {
    kind: 'source',
    id: item.id,
    expectedSha256: item.sha256,
  });
  assert.equal(h.callControlSelections.at(-1).enabled, true);
  item.agent = 'codex';
  assert.doesNotMatch(h.render(), /data-mcp-action=|data-call-control=/);
  assert.deepEqual(h.calls, []);
});
test('MCP call control precedes captured comparison and inspection while configuration remains a disclosure', () => {
  const h = harness(),
    item = skill(3, {
      kind: 'mcp',
      skillSource: undefined,
      quarantineSupported: undefined,
      fileType: 'mcp-config',
      mcp: { transport: 'stdio', wrapper: 'strict', strict: true },
    });
  h.data.items = [item];
  h.select(item);
  h.evidence.comparison = { baseline: { status: 'available' } };
  const html = h.render(),
    positions = [
      'aria-label="Artifact source"',
      'data-call-control=',
      'Configuration &amp; recovery',
      'data-comparison=',
      'Current inspection',
      'Captured evidence',
    ].map((part) => html.indexOf(part));
  assert.ok(positions.every((position) => position >= 0));
  for (let n = 1; n < positions.length; n++)
    assert.ok(
      positions[n] > positions[n - 1],
      'Call control must stay above the captured evidence panels',
    );
  assert.match(
    html,
    /<details class="artifact-section"><summary>Configuration &amp; recovery<\/summary>/,
  );
  assert.match(html, /Review grants no trust or protection\./);
  assert.doesNotMatch(html, /Review retains derived file/);
  assert.equal(h.callControlSelections.at(-1).enabled, true);
  assert.deepEqual(h.calls, []);
});
test('call control inspection waits for accepted artifact evidence and parent actions lock during its apply', () => {
  const h = harness(),
    item = skill(3, {
      kind: 'mcp',
      skillSource: undefined,
      quarantineSupported: undefined,
      fileType: 'mcp-config',
      mcp: { transport: 'stdio', wrapper: 'not-configured', strict: false },
    });
  h.data.items = [item];
  h.select(item);
  h.evidence.loading = true;
  h.render();
  assert.equal(h.callControlSelections.at(-1).enabled, false);
  h.evidence.loading = false;
  h.evidence.error = 'Comparison unavailable';
  h.render();
  assert.equal(h.callControlSelections.at(-1).enabled, false);
  h.evidence.error = null;
  h.signalAction.busy = 'load';
  h.render();
  assert.equal(h.callControlSelections.at(-1).enabled, false);
  h.signalAction.busy = null;
  h.render();
  const control = h.callControlSelections.at(-1);
  assert.equal(control.enabled, true);
  assert.equal(control.disabled, false);
  control.onBusyChange(true);
  h.render();
  assert.equal(h.button('Mark version reviewed').props.disabled, true);
  assert.equal(h.button('Refresh details').props.disabled, true);
  assert.equal(
    h.elements.find(({ props }) => props['aria-label'] === 'Close artifact review').props.disabled,
    true,
  );
  for (const entry of h.elements.filter(
    ({ props }) =>
      props.action === 'protect-registration' || props.action === 'remove-registration',
  ))
    assert.equal(entry.props.disabled, true);
  h.elements
    .find(({ props }) => typeof props.onOpenChange === 'function')
    .props.onOpenChange(false);
  assert.deepEqual(h.calls, []);
  control.onBusyChange(false);
  h.render();
  assert.equal(h.button('Mark version reviewed').props.disabled, false);
  assert.equal(
    h.elements.find(({ props }) => props['aria-label'] === 'Close artifact review').props.disabled,
    false,
  );
});
test('signals view retains reviewed suspect skills and intersects type and root search', () => {
  const h = harness();
  h.data.items[1].state = 'unchanged';
  h.data.items[1].scan = { status: 'suspect', findings: 2 };
  h.data.items[2].scan = { status: 'clean', findings: 2 };
  h.query('kind=skill&view=signals');
  const html = h.render();
  assert.equal((html.match(/class="inventory-name"/g) ?? []).length, 1);
  assert.match(html, /Shared source/);
  assert.equal(
    h.elements.find(
      ({ type, props }) => type === 'select' && props['aria-label'] === 'Inventory view',
    ).props.value,
    'signals',
  );
  const search = h.elements.find(
    ({ type, props }) => type === 'input' && props.name === 'inventory-search',
  );
  search.props.onChange({ target: { value: '.agents/skills' } });
  assert.match(h.render(), /Shared source/);
  search.props.onChange({ target: { value: '.codex/skills' } });
  assert.match(h.render(), /No matching items/);
  assert.deepEqual(h.calls, []);
});
test('view, type, exact source selection and closing round trip without review writes', () => {
  const h = harness();
  h.data.items[1].scan = { status: 'suspect', findings: 2 };
  h.query('kind=skill&view=signals');
  h.render();
  h.elements
    .find(
      ({ type, props }) =>
        type === 'button' && props['aria-label']?.includes('Review release-notes · .agents/skills'),
    )
    .props.onClick({ currentTarget: {} });
  assert.match(h.calls.at(-1)[1], /kind=skill&view=signals&workspace=/);
  h.render();
  h.elements
    .find(({ props }) => typeof props.onClose === 'function' && 'selected' in props)
    .props.onClose();
  assert.equal(h.calls.at(-1)[1], '/skills/?kind=skill&view=signals');
  h.render();
  h.elements
    .find(({ type, props }) => type === 'select' && props['aria-label'] === 'Inventory view')
    .props.onChange({ target: { value: 'incomplete' } });
  assert.equal(h.calls.at(-1)[1], '/skills/?kind=skill&view=incomplete');
  h.render();
  h.button('MCP servers').props.onClick();
  assert.equal(h.calls.at(-1)[1], '/skills/?kind=mcp&view=incomplete');
  assert.equal(
    h.calls.some(([kind]) => kind === 'review'),
    false,
  );
});
test('comparison drift offers inventory refresh and leaves the newer version closed for explicit selection', () => {
  const h = harness(),
    old = h.data.items[1];
  h.select(old, { view: 'signals' });
  h.evidence.error = 'Refresh inventory if the version changed.';
  h.render();
  const refresh = h.elements.filter(
    ({ type, props }) =>
      type === 'button' &&
      renderToStaticMarkup(React.createElement(React.Fragment, null, props.children))
        .replace(/<[^>]*>/g, '')
        .trim() === 'Refresh inventory',
  );
  assert.equal(refresh.length, 2, 'The open dialog exposes the real inventory reread');
  refresh.at(-1).props.onClick();
  assert.deepEqual(h.calls, [['refresh']]);
  h.data.items[1] = { ...old, sha256: 'c'.repeat(64) };
  const html = h.render();
  assert.match(html, /The linked version is no longer current/);
  assert.doesNotMatch(html, /aria-label="Artifact source"/);
  const currentAction = h.button('Open current version');
  assert.ok(currentAction);
  const focused = [];
  currentAction.props.ref.current = { focus: () => focused.push('current-version') };
  h.elements.find(({ props }) => typeof props.onReturnFocus === 'function').props.onReturnFocus();
  assert.deepEqual(focused, ['current-version']);
  assert.equal(
    h.calls.some(([kind]) => ['review', 'refresh-details', 'navigate'].includes(kind)),
    false,
  );
});
test('missing captured bytes expose an inventory reread while review remains unavailable', () => {
  const h = harness(),
    missing = skill(1, {
      sha256: null,
      state: 'unverifiable',
      scan: { status: 'incomplete', findings: 0 },
    });
  h.data.items = [missing];
  h.select(missing);
  h.render();
  const refreshButtons = h.elements.filter(
    ({ type, props }) =>
      type === 'button' &&
      renderToStaticMarkup(React.createElement(React.Fragment, null, props.children))
        .replace(/<[^>]*>/g, '')
        .trim() === 'Refresh inventory',
  );
  assert.equal(refreshButtons.length, 2);
  refreshButtons.at(-1).props.onClick();
  assert.deepEqual(h.calls, [['refresh']]);
  assert.equal(h.button('Mark version reviewed').props.disabled, true);
});
test('incomplete links reveal coverage and invalid baselines stay explicit without repair', () => {
  const h = harness();
  h.query('view=incomplete');
  h.data.baseline.status = 'invalid';
  const html = h.render();
  assert.match(html, /id="inventory-coverage" open=""/);
  assert.match(html, /role="alert">Reviewed baseline unavailable/);
  assert.match(html, /No items in this view/);
  assert.deepEqual(h.calls, []);
});
test('signal decisions export separately from captured evidence and prevent competing actions while saving', () => {
  const h = harness(),
    selected = h.data.items[1];
  h.select(selected);
  h.signalAction.state = { source: 'local', generatedAt: '2026-10-24T10:00:00.000Z' };
  h.signalAction.needsRecheck = true;
  h.render();
  const exported = h.elements.find(({ props }) => props.label === 'Export evidence').props.data();
  assert.equal(exported.schema, 'stroq-artifact-export/3');
  assert.equal(exported.signalDecision, h.signalAction.state);
  assert.equal(exported.signalDecisionCompletionUnknown, true);
  assert.ok(exported.report);
  assert.equal(exported.comparison, null);
  h.signalAction.busy = 'apply';
  h.render();
  assert.equal(h.button('Mark version reviewed').props.disabled, true);
  assert.equal(
    h.elements.find(({ props }) => props['aria-label'] === 'Close artifact review').props.disabled,
    true,
  );
  h.elements
    .find(({ props }) => typeof props.onOpenChange === 'function')
    .props.onOpenChange(false);
  assert.deepEqual(h.calls, []);
});
test('decided signals remain visible with the raw scan result in the matching inventory view', () => {
  const h = harness();
  h.data.items = [
    skill(1, {
      scan: { status: 'suspect', findings: 2 },
      state: 'unchanged',
      reviewedSha256: 'b'.repeat(64),
      signalDecision: { standing: 'applies', record: {} },
    }),
  ];
  h.query('view=signals');
  const html = h.render();
  assert.match(html, /2 signals/);
  assert.match(html, /Risk accepted/);
  assert.equal((html.match(/class="inventory-name"/g) ?? []).length, 1);
  h.data.signalDecisions = { status: 'unavailable' };
  assert.match(h.render(), /Saved signal decisions could not be read/);
  assert.deepEqual(h.calls, []);
});
test('the actual artifact dialog admits signal reads only after its comparison finishes successfully', () => {
  const h = harness(),
    selected = h.data.items[1];
  h.select(selected);
  h.evidence.loading = true;
  h.render();
  assert.equal(
    h.signalSelections.at(-1).item,
    null,
    'Comparison and signal state cannot share the inventory worker slot',
  );
  h.evidence.loading = false;
  h.evidence.error = 'Comparison is unavailable.';
  h.render();
  assert.equal(
    h.signalSelections.at(-1).item,
    null,
    'An unsuccessful comparison does not admit the second read',
  );
  h.evidence.error = null;
  h.render();
  assert.equal(h.signalSelections.at(-1).item, selected);
  assert.equal(h.signalSelections.at(-1).workspaceId, workspace);
  h.signalAction.busy = 'load';
  h.render();
  assert.equal(
    h.button('Refresh details').props.disabled,
    true,
    'A manual comparison cannot race an accepted signal read',
  );
  assert.equal(
    h.button('Mark version reviewed').props.disabled,
    true,
    'A baseline write cannot race the same occupied worker slot',
  );
  assert.deepEqual(h.calls, []);
});
test('inventory mounts actual MCP governance controls and explicit entry opens the real dialog without render-time requests', () => {
  const h = harness();
  const html = h.render();
  assert.equal((html.match(/Govern MCP calls/g) ?? []).length, 1);
  assert(h.elements.some((e) => e.type?.name === 'McpGovernanceControls'));
  assert.equal(h.button('Govern MCP calls').props.disabled, false);
  h.button('Govern MCP calls').props.onClick();
  const opened = h.render();
  assert.match(opened, /Close MCP governance/);
  assert.match(opened, /Inspect configured servers/);
  assert.match(opened, /Select identities/);
  assert.deepEqual(h.calls, []);
});
