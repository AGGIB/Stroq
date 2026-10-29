import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import {
  harness as hookHarness,
  ws,
  otherWs,
  bindingId,
  toolId,
  version,
  registrationId,
} from './mcp-tool-contract-client-harness.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  require = createRequire(resolve(root, 'package.json')),
  ts = require('typescript'),
  React = require('react'),
  { renderToStaticMarkup } = require('react-dom/server'),
  jsx = require('react/jsx-runtime');
async function harness() {
  const source = hookHarness();
  source.render();
  await source.flush();
  let action = source.output,
    query = `workspace=${ws}&registration=${registrationId}&binding=${bindingId}`,
    elements = [],
    calls = [];
  const modules = new Map();
  globalThis.window = {
    history: {
      pushState(_a, _b, href) {
        calls.push(['push', href]);
      },
      replaceState(_a, _b, href) {
        calls.push(['replace', href]);
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
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    const importer = (name) => {
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
        return new Proxy({}, { get: () => () => React.createElement('svg') });
      if (name === '@/components/platform-ui')
        return {
          Badge: ({ children, tone = 'muted' }) =>
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
            React.createElement(
              'div',
              null,
              React.createElement('h3', null, title),
              React.createElement('p', null, description),
            ),
          AgentGlyph: ({ name }) => React.createElement('span', { 'data-brand': name }, name),
          ExportButton: () => React.createElement('button', null, 'Export evidence'),
        };
      if (name === './use-mcp-tool-contracts') return { useMcpToolContracts: () => action };
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
  const { McpToolContractsPage } = load(
    resolve(root, 'components/platform/mcp-tool-contracts.tsx'),
  );
  const state = JSON.parse(JSON.stringify(source.output.state)),
    registration = state.registrations[0];
  action = {
    ...action,
    state,
    registration,
    tool: null,
    prepare: () => calls.push(['preview']),
    apply: () => calls.push(['apply']),
    refresh: () => calls.push(['refresh']),
    invalidate: () => calls.push(['invalidate']),
    acknowledge: (...args) => calls.push(['ack', ...args]),
  };
  return {
    action,
    registration,
    calls,
    get elements() {
      return elements;
    },
    query(value) {
      query = value;
    },
    openTool() {
      query += `&tool=${toolId}&version=${version}`;
      action.tool = registration.tools[0];
    },
    render() {
      elements = [];
      const html = renderToStaticMarkup(React.createElement(McpToolContractsPage));
      assert.equal(
        calls.some(([key]) => ['preview', 'apply'].includes(key)),
        false,
        'Rendering performs no POST',
      );
      return html;
    },
    close() {
      source.unmount();
    },
  };
}
test('Awaiting listing never becomes zero pending or an approved empty listing', async () => {
  const h = await harness();
  Object.assign(h.registration, {
    status: 'none',
    revision: null,
    captureSha256: null,
    observedAt: null,
    tools: [],
  });
  const html = h.render();
  assert.match(html, /Awaiting tool listing/);
  assert.match(html, /No complete listing observed/);
  assert.doesNotMatch(html, /No tools advertised in this capture/);
  assert.equal(
    h.elements.some(
      ({ type, props }) => type === 'button' && props.children?.includes?.('Preview approval'),
    ),
    false,
  );
  h.close();
});
test('Invalidated listings remain incomplete and cannot offer approval', async () => {
  const h = await harness();
  h.registration.status = 'incomplete';
  h.registration.reason = 'listing-invalidated';
  const html = h.render();
  assert.match(html, /Tool listing incomplete/);
  assert.match(html, /Incomplete listings cannot be approved/);
  assert.doesNotMatch(html, /paginated listings cannot be approved/);
  assert.doesNotMatch(html, /No tools advertised in this capture/);
  h.close();
});
test('A complete observed empty listing is distinct from an absent observation', async () => {
  const h = await harness();
  h.registration.tools = [];
  const html = h.render();
  assert.match(html, /No tools advertised in this capture/);
  assert.doesNotMatch(html, /No complete listing observed/);
  h.close();
});
test('Complete capture keeps bounded pagination and read-only observation details collapsed', async () => {
  const h = await harness();
  const html = h.render();
  assert.match(html, /Complete capture/);
  assert.doesNotMatch(html, /single-page|paginated listings cannot be approved/);
  const limits = html.match(
    /<details class="artifact-section"><summary>Observation &amp; private retention limits<\/summary>([\s\S]*?)<\/details>/,
  )?.[1];
  assert.ok(limits);
  assert.match(limits, /Opening or refreshing this page never starts or probes a server/);
  assert.match(limits, /already running server/);
  assert.match(limits, /client explicitly requests tools\/list without a cursor/);
  assert.match(limits, /16 pages/);
  assert.match(limits, /256 tools/);
  assert.match(limits, /200,000 serialized JSON characters/);
  assert.match(limits, /1 MiB of aggregate JSON bytes/);
  assert.match(limits, /4,096 bytes/);
  assert.match(limits, /30 seconds/);
  assert.match(limits, /Strict scanning can refuse smaller captures/);
  assert.match(limits, /Every page and the combined listing must pass full strict scanning/);
  assert.match(limits, /no approved empty or complete listing is inferred/);
  assert.match(
    limits,
    /entire advertised tool listing is withheld while any version is pending or revoked/,
  );
  assert.match(limits, /fresh listing after restart/);
  assert.match(limits, /saved captures are historical evidence/);
  h.close();
});
test('Full contract is inert, pretty printed and readable without fetching hostile URLs or instructions', async () => {
  const h = await harness();
  h.openTool();
  h.action.tool.contract = JSON.stringify({
    name: 'notes:read',
    description: '<script>hostile</script> https://example.invalid/private',
    inputSchema: { type: 'object' },
    _meta: { note: '\u202eoperator' },
  });
  const html = h.render();
  assert.match(html, /&lt;script&gt;hostile&lt;\/script&gt;/);
  assert.match(html, /\\u202eoperator/);
  assert.doesNotMatch(html, /<script|<iframe|<img/);
  assert.doesNotMatch(html, /href="https:\/\/example.invalid/);
  assert.match(html, /&quot;inputSchema&quot;:\s*\{/);
  assert.match(html, /First observed version/);
  assert.match(html, /No approved baseline/);
  h.close();
});
test('Changed contract is marked without inventing a retained prior body or safety claim', async () => {
  const h = await harness();
  h.registration.history.push({
    action: 'approve',
    toolId,
    contractSha256: '4'.repeat(64),
    at: '2026-10-23T01:00:00.000Z',
  });
  const html = h.render();
  assert.match(html, /Changed · needs review/);
  assert.doesNotMatch(html, /Safe|Protected|Host verified/);
  h.close();
});
test('Invalid/foreign selection and stale exact version show explicit recovery rather than substitute another tool', async () => {
  const h = await harness();
  for (const query of [
    'registration=raw',
    `workspace=${otherWs}&registration=${registrationId}&binding=${bindingId}`,
  ]) {
    h.query(query);
    const html = h.render();
    assert.match(html, /Invalid tool-contract link|Different workspace/);
    assert.doesNotMatch(html, /Observed tools/);
  }
  h.query(
    `workspace=${ws}&registration=${registrationId}&binding=${bindingId}&tool=${toolId}&version=${version}`,
  );
  h.action.versionMismatch = true;
  const html = h.render();
  assert.match(html, /selected tool version changed/);
  assert.doesNotMatch(html, /Captured contract/);
  h.close();
});
test('Dual decision consent is explicit and confirmation remains disabled until both are checked', async () => {
  const h = await harness();
  h.openTool();
  h.action.preview = {
    id: '11111111-1111-4111-8111-111111111111',
    action: 'approve',
    expiresAt: '2026-10-24T01:02:00.000Z',
  };
  h.action.ack = { contract: false, callLimits: false };
  h.render();
  const button = h.elements.find(
    ({ type, props }) => type === 'button' && props.children?.includes?.('Approve this version'),
  );
  assert.equal(button?.props.disabled, true);
  const inputs = h.elements.filter(({ type }) => type === 'input');
  assert.equal(inputs.length, 2);
  inputs[0].props.onChange({ target: { checked: true } });
  assert.deepEqual(h.calls.at(-1), ['ack', 'contract', true]);
  h.action.ack = { contract: true, callLimits: true };
  h.render();
  assert.equal(
    h.elements.find(
      ({ type, props }) => type === 'button' && props.children?.includes?.('Approve this version'),
    )?.props.disabled,
    false,
  );
  h.close();
});
test('Receipt records a decision without retry, execution or host-enforcement claim', async () => {
  const h = await harness();
  h.openTool();
  h.action.receipt = { action: 'approve' };
  const html = h.render();
  assert.match(html, /Version approval recorded/);
  assert.match(html, /does not retry a call/);
  assert.doesNotMatch(html, /data-tone="green"|Host protected|Call executed/);
  h.close();
});
test('Unknown result links the exact affected version and leaves recheck explicit', async () => {
  const h = await harness();
  h.openTool();
  h.action.needsRecheck = true;
  h.action.affected = { bindingId, toolId, sha256: version };
  const html = h.render();
  assert.match(html, /Decision completion is unknown/);
  assert.match(html, /Recheck this tool/);
  assert.ok(html.includes(`tool=${toolId}&amp;version=${version}`));
  assert.doesNotMatch(html, /Version approval recorded/);
  h.close();
});
test('Unavailable and gap states do not claim an empty or complete registration catalog', async () => {
  const h = await harness();
  h.action.state.available = false;
  h.action.state.reason = 'storage-unavailable';
  h.action.state.registrations = [];
  h.action.registration = null;
  assert.match(h.render(), /Private tool-contract storage could not be read safely/);
  h.action.state.available = true;
  h.action.state.reason = null;
  h.action.state.gaps = ['source-unavailable'];
  const html = h.render();
  assert.match(html, /Registration coverage is incomplete/);
  assert.match(html, /Registration coverage unavailable/);
  assert.doesNotMatch(html, /No opted-in registrations/);
  h.close();
});

const comparison = (status, changes = [], extra = {}) => ({
  status,
  baselineSha256: status === 'first-seen' ? null : '3'.repeat(64),
  baselineApprovedAt: status === 'first-seen' ? null : '2026-10-23T01:00:00.000Z',
  counts: ['changed', 'unchanged'].includes(status)
    ? Object.fromEntries(
        ['added', 'changed', 'removed'].map((kind) => [
          kind,
          changes.filter((row) => row.kind === kind).length,
        ]),
      )
    : null,
  changes,
  ...extra,
});
test('Tool list exposes a compact comparison summary without expanding contract bodies', async () => {
  const h = await harness();
  h.registration.tools[0].comparison = comparison('changed', [
    { path: '/description', kind: 'changed' },
    { path: '/outputSchema', kind: 'added' },
    { path: '/annotations/readOnlyHint', kind: 'removed' },
  ]);
  const html = h.render();
  assert.match(html, /3 fields changed/);
  assert.doesNotMatch(html, /Changes since approval|Captured contract|Earlier approved contract/);
  h.close();
});
test('Review leads with complete field counts and exact added, changed and removed values', async () => {
  const h = await harness();
  h.openTool();
  const tool = h.action.tool;
  tool.previousApprovedContract = JSON.stringify({
    name: tool.name,
    description: 'Read a note',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  });
  tool.contract = JSON.stringify({
    name: tool.name,
    description: 'Read and update a note',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    annotations: {},
  });
  tool.comparison = comparison('changed', [
    { path: '/description', kind: 'changed' },
    { path: '/outputSchema', kind: 'added' },
    { path: '/annotations/readOnlyHint', kind: 'removed' },
  ]);
  const html = h.render();
  assert.match(html, /Changes since approval/);
  for (const text of [
    '1 added',
    '1 changed',
    '1 removed',
    '/description',
    '/outputSchema',
    '/annotations/readOnlyHint',
    'Read a note',
    'Read and update a note',
    'Not present',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(html.indexOf('Changes since approval') < html.indexOf('Captured contract'));
  assert.match(html, /<details[^>]*class="mcp-tool-change"[^>]*><summary>/);
  assert.doesNotMatch(html, /<details[^>]*open|Safe|safer|data-tone="green"/);
  assert.match(html, /Baseline contract SHA/);
  h.close();
});
test('Nested pointer paths and ordered arrays show exact values with missing distinct from JSON null', async () => {
  const h = await harness();
  h.openTool();
  const tool = h.action.tool;
  tool.previousApprovedContract = JSON.stringify({
    name: tool.name,
    inputSchema: {
      type: 'object',
      properties: { 'a/b~c': { default: null } },
      required: ['one', 'two'],
    },
  });
  tool.contract = JSON.stringify({
    name: tool.name,
    inputSchema: { type: 'object', properties: { 'a/b~c': {} }, required: ['two', 'one'] },
  });
  tool.comparison = comparison('changed', [
    { path: '/inputSchema/properties/a~1b~0c/default', kind: 'removed' },
    { path: '/inputSchema/required', kind: 'changed' },
  ]);
  const html = h.render();
  assert.match(html, /a~1b~0c\/default/);
  assert.match(html, /null/);
  assert.match(html, /Not present/);
  assert.match(html, /&quot;one&quot;,\s*&quot;two&quot;/);
  assert.match(html, /&quot;two&quot;,\s*&quot;one&quot;/);
  h.close();
});
test('Unchanged, legacy missing baseline and incomplete comparison remain distinct', async () => {
  const h = await harness();
  h.openTool();
  const tool = h.action.tool;
  tool.previousApprovedContract = tool.contract;
  tool.comparison = comparison('unchanged');
  let html = h.render();
  assert.match(html, /No changes since approval/);
  assert.doesNotMatch(html, /No approved baseline|Comparison incomplete|data-tone="green"/);
  tool.previousApprovedContract = null;
  tool.comparison = comparison('baseline-unavailable');
  html = h.render();
  assert.match(html, /Earlier approval body unavailable/);
  assert.match(html, /Baseline contract SHA/);
  assert.doesNotMatch(html, /No changes since approval|0 fields changed|First observed version/);
  tool.previousApprovedContract = tool.contract;
  tool.comparison = comparison('incomplete');
  html = h.render();
  assert.match(html, /Comparison incomplete/);
  assert.match(html, /Full contract bodies/);
  assert.match(html, /Earlier approved contract/);
  assert.doesNotMatch(html, /No changes since approval|0 fields changed|0 added|0 removed/);
  h.close();
});
test('Prepared decision displays its exact captured comparison instead of substituting another state body', async () => {
  const h = await harness();
  h.openTool();
  h.action.tool.comparison = comparison('first-seen');
  h.action.tool.contract = JSON.stringify({
    name: h.action.tool.name,
    description: 'stale observed body',
    inputSchema: { type: 'object' },
  });
  h.action.preview = {
    id: '11111111-1111-4111-8111-111111111111',
    action: 'approve',
    expiresAt: '2026-10-24T01:02:00.000Z',
    tool: {
      name: h.action.tool.name,
      contract: JSON.stringify({
        name: h.action.tool.name,
        description: 'exact preview body',
        inputSchema: { type: 'object' },
      }),
      previousApprovedContract: JSON.stringify({
        name: h.action.tool.name,
        description: 'exact approved body',
        inputSchema: { type: 'object' },
      }),
      comparison: comparison('changed', [{ path: '/description', kind: 'changed' }]),
    },
  };
  const html = h.render();
  assert.match(html, /exact preview body/);
  assert.match(html, /exact approved body/);
  assert.doesNotMatch(html, /stale observed body|No approved baseline/);
  assert.ok(
    html.indexOf('Changes since approval') < html.indexOf('I reviewed this advertised contract'),
  );
  h.close();
});
test('Both comparison sides and hostile pointer keys remain inert text with visible bidi controls', async () => {
  const h = await harness();
  h.openTool();
  const tool = h.action.tool;
  const key = '<img src=x onerror=alert(1)>\u202e\u0001\n\t';
  tool.previousApprovedContract = JSON.stringify({
    name: tool.name,
    inputSchema: { type: 'object' },
    _meta: { [key]: '<script>before</script> https://before.invalid' },
  });
  tool.contract = JSON.stringify({
    name: tool.name,
    inputSchema: { type: 'object' },
    _meta: { [key]: '<iframe>after</iframe> https://after.invalid' },
  });
  tool.comparison = comparison('changed', [{ path: `/_meta/${key}`, kind: 'changed' }]);
  const html = h.render();
  assert.match(html, /&lt;script&gt;before&lt;\/script&gt;/);
  assert.match(html, /&lt;iframe&gt;after&lt;\/iframe&gt;/);
  assert.match(html, /\\u202e/);
  assert.match(html, /\\u0001\\n\\t/);
  assert.doesNotMatch(html, /\u0001/);
  assert.doesNotMatch(html, /<script|<iframe|<img|href="https:\/\/(before|after)\.invalid/);
  h.close();
});
