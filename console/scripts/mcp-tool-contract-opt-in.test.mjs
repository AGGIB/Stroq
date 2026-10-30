import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const jsx = require('react/jsx-runtime');
const workspaceId = `workspace-${'a'.repeat(24)}`;
const artifact = {
  id: `item-${'b'.repeat(24)}`,
  name: 'Notes server',
  agent: 'cursor',
  scope: 'project',
  sha256: 'c'.repeat(64),
  configSource: 'cursor-project',
};

function harness() {
  const modules = new Map(),
    elements = [],
    requests = [];
  function load(file) {
    if (!/\.tsx?$/.test(file)) file += existsSync(`${file}.tsx`) ? '.tsx' : '.ts';
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
      if (name === 'next/link')
        return {
          default: ({ children, href, ...props }) =>
            React.createElement('a', { href, ...props }, children),
        };
      if (name === 'lucide-react')
        return new Proxy({}, { get: () => () => React.createElement('svg') });
      if (name === '@/components/platform-provider')
        return {
          usePlatform: () => ({
            localContext: { workspace: { id: workspaceId, label: 'Current workspace' } },
            requestLocal: async (...args) => {
              requests.push(args);
              throw new Error('Fixture unavailable');
            },
          }),
        };
      if (name === '@/components/platform-ui')
        return { Badge: ({ children }) => React.createElement('span', null, children) };
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
  return {
    load: (file) => load(resolve(root, file)),
    elements,
    requests,
    render: (Component, props) => renderToStaticMarkup(React.createElement(Component, props)),
  };
}

test('Tool-review opt-in is explicit and its read-only preview request includes the flag', async () => {
  const h = harness(),
    { McpContainmentAction } = h.load('components/platform/mcp-containment-action');
  const html = h.render(McpContainmentAction, {
    action: 'protect-registration',
    artifact,
    workspaceId,
    toolApproval: true,
    onCompleted() {},
  });
  assert.match(html, /Protect &amp; review tools/);
  assert.equal(h.requests.length, 0, 'Opening must not preview, apply or start a server');
  const button = h.elements.find(
    ({ type, props }) => type === 'button' && props.children?.includes?.('Preview tool review'),
  );
  assert(button);
  button.props.onClick();
  await Promise.resolve();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][0], '/api/mcp-containment/preview');
  assert.equal(h.requests[0][1].toolApproval, true);
  assert.equal(h.requests[0][1].expectedSha256, artifact.sha256);
});

test('Ordinary proxy protection retains its existing wording and omits the opt-in flag', () => {
  const h = harness(),
    { McpContainmentAction } = h.load('components/platform/mcp-containment-action');
  const html = h.render(McpContainmentAction, {
    action: 'protect-registration',
    artifact,
    workspaceId,
    onCompleted() {},
  });
  assert.match(html, /Route through Stroq/);
  assert.match(html, /Preview proxy/);
  assert.doesNotMatch(html, /Protect &amp; review tools/);
  assert.equal(h.requests.length, 0);
});

test('Opt-in preview discloses complete pagination, capture limits and separate private metadata consent', () => {
  const h = harness(),
    { McpContainmentPreviewDetails } = h.load('components/platform/mcp-containment-preview'),
    { MCP_TOOL_CONTRACT_LIMITATIONS } = h.load('lib/mcp-tool-contracts');
  const preview = {
    action: 'protect-registration',
    artifact,
    proxy: { mode: 'strict', policyWorkspaceId: workspaceId, toolApproval: true },
    siblings: 2,
    reformatted: false,
    retention: { maxRecords: 32 },
    limitations: [...MCP_TOOL_CONTRACT_LIMITATIONS],
    expiresAt: '2026-10-24T01:02:00.000Z',
  };
  const html = h.render(McpContainmentPreviewDetails, {
    preview,
    acknowledgements: {
      session: false,
      retention: false,
      proxy: false,
      sharedPolicy: false,
      toolContracts: false,
    },
    onAcknowledge() {},
    disabled: false,
    policyWorkspaceLabel: 'Current workspace',
  });
  assert.match(html, /exact version/i);
  assert.match(html, /Complete captures can include multiple pages/);
  assert.doesNotMatch(html, /single-page|Paginated or incomplete/);
  const limits = html.match(
    /<details class="artifact-section"><summary>Recovery &amp; limits<\/summary>([\s\S]*?)<\/details>/,
  )?.[1];
  assert.ok(limits);
  assert.match(limits, /16 pages/);
  assert.match(limits, /256 tools/);
  assert.match(limits, /200,000 serialized JSON characters/);
  assert.match(limits, /1 MiB of aggregate JSON bytes/);
  assert.match(limits, /4,096 bytes/);
  assert.match(limits, /client explicitly requests tools\/list without a cursor/);
  assert.match(limits, /never starts or probes a server/);
  assert.match(html, /descriptions and schemas/i);
  assert.match(html, /unencrypted/i);
  assert.match(html, /not.*automatically|no.*automati/i);
  const inputs = h.elements.filter(({ type }) => type === 'input');
  assert.equal(
    inputs.length,
    4,
    'Session, proxy, configuration retention and metadata retention remain separate',
  );
  assert.equal(h.requests.length, 0);
});
