import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { tsImport } from 'tsx/esm/api';
import * as network from './codex-network-client-fixtures.mjs';
import * as paths from './codex-path-guard-client-fixtures.mjs';
const { callPreview, callOverview } = await tsImport('../lib/mcp-call-control-fixtures.ts', {
  parentURL: import.meta.url,
});
const root = fileURLToPath(new URL('../', import.meta.url)),
  require = createRequire(resolve(root, 'package.json'));
const ts = require('typescript'),
  React = require('react'),
  jsx = require('react/jsx-runtime'),
  { renderToStaticMarkup } = require('react-dom/server');
const workspace = `workspace-${'a'.repeat(24)}`,
  sha = 'b'.repeat(64),
  stamp = '2026-10-24T00:00:00.000Z';
function fixture() {
  return {
    inventoryFreshness: 'current',
    codexPathGuard: { ...paths.state(), history: 'missing' },
    unconfirmedCodexPaths: [],
    unconfirmedMcpCallControls: [],
    inventory: {
      schema: 'stroq-inventory/1',
      source: 'local',
      generatedAt: stamp,
      workspace: { id: workspace, label: 'Fixture' },
      baseline: { status: 'ready', reviewedAt: stamp },
      items: [
        {
          id: `item-${'1'.repeat(24)}`,
          kind: 'skill',
          name: 'release-notes',
          agent: 'shared',
          skillSource: 'agents-skills',
          scope: 'project',
          fileType: 'skill-tree',
          sha256: sha,
          reviewedSha256: sha,
          state: 'unchanged',
          scan: { status: 'suspect', findings: 2 },
          capabilities: [],
          quarantineSupported: false,
        },
      ],
      gaps: [],
      limitations: [],
    },
    loading: false,
    error: null,
    refreshedAt: '2027-01-01T00:00:00.000Z',
    refresh() {},
  };
}
function render(state) {
  const modules = new Map();
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
    vm.runInNewContext(
      code,
      {
        exports,
        Object,
        Array,
        JSON,
        Reflect,
        Number,
        Date,
        URLSearchParams,
        require(name) {
          if (name === 'react') return React;
          if (name === 'react/jsx-runtime') return jsx;
          if (name === 'next/link')
            return {
              __esModule: true,
              default: ({ children, ...props }) => React.createElement('a', props, children),
            };
          if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
          if (name === '@/components/platform-provider')
            return { usePlatform: () => ({ localContext: { workspace: { id: workspace } } }) };
          if (name === '@/components/control-provider')
            return { useControl: () => ({ runs: [], control: null }) };
          if (name === '@/lib/control') return { latestContextRun: () => null };
          if (name === './use-protection-queue') return { useProtectionQueue: () => state };
          if (name === './inventory-monitor') return { InventoryMonitor: () => null };
          if (name === '@/components/platform-ui')
            return {
              Badge: ({ children }) => React.createElement('span', null, children),
              Panel: ({ children, title, actions, ...props }) =>
                React.createElement(
                  'section',
                  props,
                  React.createElement('h2', null, title),
                  actions,
                  children,
                ),
            };
          return load(
            name.startsWith('@/') ? resolve(root, name.slice(2)) : resolve(dirname(file), name),
          );
        },
      },
      { filename: file },
    );
    return exports;
  }
  const { ProtectionQueue } = load(resolve(root, 'components/platform/protection-queue.tsx'));
  return renderToStaticMarkup(React.createElement(ProtectionQueue)).replaceAll('&amp;', '&');
}
test('actual Protection renders a reviewed suspect source visibly and links its exact revision', () => {
  const html = render(fixture());
  assert.match(
    html,
    /<strong>Matched signals: release-notes<\/strong><small class="queue-source">\.agents\/skills · Workspace<\/small>/,
  );
  assert(
    html.includes(
      `href="/skills/?kind=skill&view=signals&workspace=${workspace}&item=item-${'1'.repeat(24)}&sha=${sha}"`,
    ),
  );
  assert.match(html, /Inspect signals/);
  assert.doesNotMatch(html, /artifacts awaiting first review|artifacts changed since review/);
});
test('actual queue header preserves the inventory capture time instead of an unrelated refresh timestamp', () => {
  const state = fixture();
  state.inventoryFreshness = 'historical';
  const html = render(state);
  assert.match(html, /Earlier inventory/);
  assert.match(html, /24\/10\/2026/);
  assert.doesNotMatch(html, /Reports refreshed|2027/);
  assert.match(html, /Historical capture 2026-10-24T00:00:00.000Z/);
  assert.match(html, /Inventory needs a fresh read/);
});
test('routine summaries and coverage use matching views without losing current source evidence', () => {
  const state = fixture();
  state.inventory.items[0].state = 'changed';
  state.inventory.items[0].sha256 = 'c'.repeat(64);
  state.inventory.gaps = [
    { code: 'limit', kind: 'skill', agent: 'shared', scope: 'user', skillSource: 'agents-skills' },
  ];
  const html = render(state);
  assert.match(html, /href="\/skills\/\?view=changes"/);
  assert.match(html, /href="\/skills\/\?view=incomplete#inventory-coverage"/);
  assert.match(html, /Inventory coverage incomplete/);
  assert.match(html, /~\/\.agents\/skills · User/);
  assert.match(html, /Matched signals: release-notes/);
});
test('an unrelated endpoint failure never labels a successful inventory capture as earlier evidence', () => {
  const state = fixture();
  state.error = 'Quarantine folders could not be rechecked.';
  const html = render(state);
  assert.match(html, /Quarantine folders could not be rechecked/);
  assert.match(html, /Inventory captured/);
  assert.doesNotMatch(html, /Earlier inventory remains visible/);
  state.inventoryFreshness = 'historical';
  assert.match(render(state), /Earlier inventory remains visible/);
});

function taskHistory() {
  return {
    schema: 'stroq-workspace-task-controls/1',
    workspaceId: workspace,
    generatedAt: stamp,
    available: true,
    history: 'ready',
    error: null,
    records: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        revision: sha,
        workspaceId: workspace,
        createdAt: stamp,
        updatedAt: stamp,
        status: 'uncertain',
        binding: {
          runId: '11111111-1111-4111-8111-111111111111',
          captureSha256: sha,
          sourceId: 'source-8f641aeae255bfea9c88207ea743e9f725240d6b0f87579dec92a5f3780b3079',
          sourceSha256: sha,
          sourceMode: 420,
          captureComplete: true,
        },
        originalSha256: sha,
        manualSha256: 'c'.repeat(64),
        mode: 420,
        changes: { folderOpen: 1, worktreeCreated: 0 },
        fileState: 'manual-version',
        recoveryAvailable: true,
        canRestore: false,
        verification: null,
        hostEnforcement: false,
      },
    ],
  };
}
test('actual Protection exposes unfinished task recovery with an exact existing record destination', () => {
  const state = fixture();
  state.workspaceTasks = taskHistory();
  const html = render(state);
  assert.match(html, /Task change needs recheck/);
  assert(
    html.includes(
      `/protection/workspace/?workspace=${workspace}&run=11111111-1111-4111-8111-111111111111&taskControl=22222222-2222-4222-8222-222222222222`,
    ),
  );
  assert.match(
    html,
    /Matched signals: release-notes/,
    'task recovery never resolves independent source signals',
  );
});
test('initial loading does not invent a task-history failure; accepted missing history stays quiet', () => {
  const state = fixture();
  state.loading = true;
  const pending = render(state);
  assert.doesNotMatch(pending, /Task change history unavailable/);
  state.loading = false;
  state.workspaceTasks = { ...taskHistory(), history: 'missing', records: [] };
  assert.doesNotMatch(render(state), /Task change history unavailable|Task change needs recheck/);
});
test('actual Protection keeps an operator-marked issue visible independently of Reviewed and pending saves', () => {
  const state = fixture(),
    evidenceSha = 'a'.repeat(64),
    at = '2026-10-24T00:00:00.000Z';
  const incident = {
    id: `incident-${evidenceSha}`,
    evidenceSha,
    recordedAt: at,
    sequence: 12,
    kind: 'policy-deny',
    severity: 'high',
    title: 'Policy denied a tool call',
    categories: ['network'],
    relatedIds: [],
    secretReferences: 0,
    status: 'reviewed',
    reviewedAt: at,
  };
  state.incidents = {
    schema: 'stroq-incidents/1',
    source: 'local',
    generatedAt: at,
    window: { kind: 'available', truncated: false, omitted: 0 },
    incidents: [incident],
    limitations: [],
  };
  const record = {
    id: '22222222-2222-4222-8222-222222222222',
    incident: {
      id: incident.id,
      evidenceSha256: evidenceSha,
      sequence: 12,
      recordedAt: at,
      kind: 'policy-deny',
    },
    assessment: 'confirmed-issue',
    reason: 'unintended-action',
    assessedAt: at,
    previousAssessmentId: null,
  };
  state.assessments = {
    schema: 'stroq-incident-assessments/1',
    scope: 'local-journal',
    generatedAt: at,
    history: 'ready',
    revision: 'b'.repeat(64),
    records: [record],
    canRecord: true,
    error: null,
  };
  assert.match(render(state), /1 recorded finding needs attention/);
  record.assessment = 'accepted-risk';
  record.reason = 'intended-workflow';
  assert.doesNotMatch(render(state), /1 recorded finding needs attention/);
  state.unconfirmedAssessments = new Set([incident.id]);
  assert.match(render(state), /1 save unconfirmed/);
  assert.match(render(state), /Matched signals: release-notes/);
});

test('actual Protection retains a pending Pause beside confirmed paused authority and preserves its recorded profile', () => {
  const state = fixture(),
    preview = callPreview();
  state.mcpCallControls = callOverview();
  state.mcpCallControls.controls[0].capability = 'supported';
  state.mcpCallControls.controls[0].current.mode = 'paused';
  state.mcpCallControls.controls[0].setupConfiguration = 'confirmed';
  state.unconfirmedMcpCallControls = [{ preview, startedAt: preview.createdAt }];
  const current = render(state);
  assert.match(current, /Notes: call-control completion unknown/);
  assert.match(current, /Selected local profile/);
  assert.match(current, /Ordinary state reads do not resolve this operation/);
  assert(
    current.includes(
      `href="/skills/mcp/?control=${preview.controlId}&context=${preview.contextId}"`,
    ),
  );
  assert.match(current, /Matched signals: release-notes/);
  state.mcpCallControls.contextId = 'context-' + '8'.repeat(64);
  const foreign = render(state);
  assert.match(foreign, /Different local profile/);
  assert.match(foreign, /Switch to the recorded profile before rechecking this exact operation/);
  assert(
    foreign.includes(
      `href="/skills/mcp/?control=${preview.controlId}&context=${preview.contextId}"`,
    ),
  );
  assert.equal(state.unconfirmedMcpCallControls[0].preview.contextId, preview.contextId);
});
test('actual Protection keeps exact network unknowns actionable beside changed settings and historical copy evidence', () => {
  const state = fixture(),
    pending = network.preview();
  pending.id = pending.operationId = network.id(9);
  state.codexNetworkGuard = network.state([network.record({ standing: 'changed' })]);
  const job = network.job('completed');
  job.binding.workspaceId = workspace;
  state.codexNetworkChecks = { ...network.checkState([job]), workspaceId: workspace };
  state.unconfirmedNetworkGuard = [{ preview: pending, startedAt: pending.createdAt }];
  state.unconfirmedNetworkChecks = [];
  const html = render(state);
  for (const text of [
    'Codex network change is unconfirmed',
    'Codex network setting changed',
    'Latest Codex copy check recorded',
    'Historical isolated permission copy',
    'native client adoption remain unverified',
    'Matched signals: release-notes',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(
    html.includes(
      `/agents/?codexNetwork=history&context=${network.context}&record=${network.id(1)}`,
    ),
  );
  assert.ok(html.includes(`check=${job.id}&networkWorkspace=${workspace}`));
  assert.doesNotMatch(html, /Restore network|Network protected|Current chat protected/);
});
test('loading never invents network history failure while an exact unknown remains visible', () => {
  const state = fixture(),
    pending = network.preview();
  state.loading = true;
  state.unconfirmedNetworkGuard = [{ preview: pending, startedAt: pending.createdAt }];
  const html = render(state);
  assert.match(html, /Codex network change is unconfirmed/);
  assert.doesNotMatch(
    html,
    /Codex network settings unavailable|Codex copied-policy history unavailable/,
  );
});
test('recorded unowned running copy is not presented as a live owned check on home', () => {
  const state = fixture(),
    job = network.job();
  job.binding.workspaceId = workspace;
  state.codexNetworkGuard = network.state();
  state.codexNetworkChecks = { ...network.checkState([job], false), workspaceId: workspace };
  const html = render(state);
  assert.match(html, /recorded running; ownership unverified/);
  assert.match(html, /Liveness is unverified/);
  assert.ok(html.includes(`check=${job.id}&networkWorkspace=${workspace}`));
  assert.doesNotMatch(html, /Cancel check/);
});
test('actual Protection renders exact pending path operation beside independent drift, without Restore or native check authority', () => {
  const state = fixture(),
    p = paths.preview();
  p.operationId = paths.id(9);
  state.codexPathGuard = paths.state([paths.record({ standing: 'changed' })]);
  state.unconfirmedCodexPaths = [{ preview: p, startedAt: p.createdAt }];
  const html = render(state);
  assert.match(html, /Codex AWS credentials change is unconfirmed/);
  assert.match(html, /Codex AWS credentials rule changed/);
  assert(
    html.includes(
      `href="/agents/?codexPaths=history&pathContext=${paths.context}&pathRecord=${paths.id(1)}"`,
    ),
  );
  assert.doesNotMatch(html, /Restore path rule|Apply deny|Preview native path check/);
});
test('actual Protection keeps matching deny a declaration and missing recovery distinct from optional empty history', () => {
  const state = fixture();
  state.codexPathGuard = paths.state([paths.record()]);
  let html = render(state);
  assert.match(html, /Codex AWS credentials deny declaration matches/);
  assert.match(html, /Native adoption remains unverified/);
  state.codexPathGuard = {
    ...paths.state(),
    history: 'missing',
    available: false,
    error: 'codex-path-guard-recovery-required',
  };
  html = render(state);
  assert.match(html, /Codex credential path history unavailable/);
  state.codexPathGuard = { ...paths.state(), history: 'missing' };
  assert.doesNotMatch(render(state), /Codex credential path history unavailable/);
});
