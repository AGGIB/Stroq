import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as control from './control';
import * as checks from './protection-check';
import * as presentation from './protection-check-presentation';
import * as navigation from './protection-check-navigation';
import * as workspaceNavigation from './workspace-review-navigation';
import * as comparison from './incident-comparison';
import * as doctorNavigation from './doctor-navigation';
import * as doctorPresentation from './doctor-presentation';
const workspaceId = `workspace-${'a'.repeat(24)}`;
const at = '2026-10-24T10:00:00.000Z';
const ids = checks.PROTECTION_STEPS;
const results = [
  { total: 1, passed: 1, ok: true, checks: [{ id: 'runtime', label: 'Runtime', ok: true }] },
  { rules: 10, ok: true, faults: 0, findings: [] },
  {
    replayed: { attack: 36, ordinary: 75, cases: 0 },
    ok: true,
    attacksPassing: 0,
    newInterruptions: 0,
    notJudged: 0,
    violations: 0,
  },
  { total: 0, passed: 0, failed: 0, cases: [], results: [] },
  {
    workspaceId,
    runId: '11111111-1111-4111-8111-111111111111',
    complete: true,
    sources: 3,
    entries: 5,
    errors: 1,
    warnings: 0,
    notices: 4,
    coverage: { gaps: 0, omittedSources: 0, omittedEntries: 0 },
  },
];
const run: any = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'protection-check',
  status: 'completed',
  startedAt: at,
  finishedAt: at,
  progress: {
    steps: ids.map((id, i) => ({
      id,
      status: 'completed',
      startedAt: at,
      finishedAt: at,
      result: results[i],
      error: null,
    })),
  },
  result: { completed: 5, total: 5 },
};
function render(overrides: Record<string, unknown> = {}, kind: 'report' | 'history' = 'report') {
  const exports: any = {},
    elements: any[] = [];
  const file = resolve(
    process.cwd(),
    kind === 'history'
      ? 'components/platform/protection-results.tsx'
      : 'components/platform/protection-check-report.tsx',
  );
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    require(name: string) {
      if (name === 'react/jsx-runtime')
        return {
          ...jsx,
          jsx(type: any, props: any) {
            elements.push({ type, props });
            return jsx.jsx(type, props);
          },
          jsxs(type: any, props: any) {
            elements.push({ type, props });
            return jsx.jsxs(type, props);
          },
        };
      if (name === 'next/link')
        return { default: ({ children, ...p }: any) => React.createElement('a', p, children) };
      if (name === 'lucide-react')
        return new Proxy({}, { get: () => () => React.createElement('svg') });
      if (name === '@/components/platform-ui')
        return {
          Panel: ({ title, actions, children }: any) =>
            React.createElement(
              'section',
              {},
              React.createElement('h2', {}, title),
              actions,
              children,
            ),
          Badge: ({ children }: any) => React.createElement('span', {}, children),
        };
      if (name === './protection-results')
        return {
          formatRunTime: () => '24 Oct, 10:00:00',
          InstallationResult: (p: any) =>
            React.createElement(
              'div',
              { 'data-current-navigation': p.matchesCurrentRunContext },
              'Installation details',
            ),
          PolicyResult: () => React.createElement('div', {}, 'Policy details'),
          ScenariosResult: () => React.createElement('div', {}, 'Scenario details'),
        };
      const modules: Record<string, unknown> = {
        '@/lib/control': control,
        '@/lib/protection-check': checks,
        '@/lib/protection-check-presentation': presentation,
        '@/lib/protection-check-navigation': navigation,
        '@/lib/workspace-review-navigation': workspaceNavigation,
        '@/lib/incident-comparison': comparison,
        '@/lib/doctor-navigation': doctorNavigation,
        '@/lib/doctor-presentation': doctorPresentation,
      };
      if (modules[name]) return modules[name];
      throw Error(name);
    },
  });
  const props = {
    run,
    workspaceId,
    matchesContext: true,
    canCancel: false,
    cancelling: false,
    onCancel: () => {},
    ...overrides,
  };
  const html = renderToStaticMarkup(
    React.createElement(
      kind === 'history' ? exports.History : exports.ProtectionCheckReport,
      props,
    ),
  );
  return { html, elements };
}
describe('actual five-stage local check report', () => {
  it('history distinguishes locally owned leaves from retained unverified work while keeping legacy fallback', () => {
    const leaf = { id: run.id, kind: 'doctor', status: 'running', startedAt: at };
    const state = {
      schema: 'stroq-control/1',
      workspaceId,
      engine: { available: true, version: '0.28.0' },
      history: { status: 'ready' },
      context: {
        workspaceId: 'a'.repeat(64),
        policySha256: 'b'.repeat(64),
        runtimeSha256: 'c'.repeat(64),
      },
      runs: [leaf],
      activeRunId: null,
      activeProtectionCheckId: null,
    };
    const observed = render({ runs: [leaf], control: state, onSelect: () => {} }, 'history').html;
    expect(observed).toContain('State unverified');
    expect(observed).not.toContain('Running…');
    const owned = render(
      { runs: [leaf], control: { ...state, activeRunId: leaf.id }, onSelect: () => {} },
      'history',
    ).html;
    expect(owned).toContain('Running…');
    expect(owned).not.toContain('State unverified');
    const { activeRunId, ...legacy } = state;
    expect(render({ runs: [leaf], control: legacy, onSelect: () => {} }, 'history').html).toContain(
      'Running…',
    );
  });
  it('keeps an unowned unfinished parent unverified even when its saved stage was running', () => {
    const parent = {
      ...run,
      status: 'running',
      progress: {
        steps: run.progress.steps.map((s: any, i: number) => ({
          ...s,
          status: i === 0 ? 'running' : 'queued',
          result: null,
          error: null,
        })),
      },
    };
    const { html } = render({ run: parent, owned: false });
    expect(html).toContain('Unfinished recorded attempt · active owner unverified.');
    expect(html).toContain('State unverified');
    expect(html).not.toContain('Checking…');
    expect(html).not.toContain('Earlier unfinished');
    expect(html).not.toContain('Cancel check');
  });
  it('shows cancellation once and leaves inherited unstarted stages as Not run without empty disclosures', () => {
    const cancelled = {
      ...run,
      status: 'cancelled',
      error: 'cancelled',
      progress: {
        steps: run.progress.steps.map((s: any) => ({
          ...s,
          status: 'skipped',
          startedAt: null,
          finishedAt: at,
          error: 'cancelled',
          result: null,
        })),
      },
    };
    const { html } = render({ run: cancelled });
    expect(html.split(control.RUN_ERRORS.cancelled!).length - 1).toBe(1);
    expect(html.match(/Not run/g)).toHaveLength(5);
    expect(html).not.toContain('<summary>Evidence &amp; scope</summary>');
  });
  it('keeps completed evidence and actual stage-specific reasons while avoiding visible duplicate global failures', () => {
    const failed = {
      ...run,
      status: 'failed',
      error: 'engine-failed',
      progress: {
        steps: run.progress.steps.map((s: any, i: number) =>
          i === 0
            ? s
            : {
                ...s,
                status: i === 1 ? 'failed' : 'skipped',
                startedAt: i === 1 ? at : null,
                finishedAt: at,
                error: i === 2 ? 'prerequisite-failed' : 'engine-failed',
                result: null,
              },
        ),
      },
    };
    const { html } = render({ run: failed });
    const visible = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
    expect(visible.split(control.RUN_ERRORS['engine-failed']!).length - 1).toBe(1);
    expect(html).toContain('Installation details');
    expect(html).toContain(control.RUN_ERRORS['prerequisite-failed']);
    expect(html.match(/<summary>Evidence &amp; scope<\/summary>/g)).toHaveLength(3);
    expect(html.split(control.RUN_ERRORS['engine-failed']!).length - 1).toBe(2);
  });
  it('identifies captured saved expectations by their action groups instead of check numbers', () => {
    const captured = structuredClone(run),
      id = `case-${'d'.repeat(64)}`;
    captured.progress.steps[3].result = {
      total: 1,
      passed: 0,
      failed: 1,
      cases: [{ id, classes: ['shell.network'] }],
      results: [
        {
          caseId: id,
          passed: false,
          scenarios: [
            { taint: 'none', expected: 'deny', actual: 'allow' },
            { taint: 'suspect', expected: 'deny', actual: 'deny' },
          ],
        },
      ],
    };
    const { html } = render({ run: captured });
    expect(html).toContain('Outbound shell command');
    expect(html).toContain('Expected');
    expect(html).toContain('Recorded');
    expect(html).not.toContain('Check 1');
  });
  it('renders recorded stage evidence, exact report links and concise local scope', () => {
    const { html } = render();
    for (const id of ids) expect(html).toContain(`id="protection-check-${id}"`);
    expect(html).toContain('No saved checks');
    expect(html).toContain('no provider requests');
    expect(html).toContain('run=22222222-2222-4222-8222-222222222222');
    expect(html).toContain('/protection/workspace/?');
    expect(html).not.toContain('Protected');
    expect(html).not.toContain('Cancel check');
    expect(html.indexOf('1 errors · 0 warnings · complete')).toBeGreaterThan(-1);
  });
  it('keeps historical results readable and withholds current-state navigation and cancel', () => {
    const { html } = render({ matchesContext: false });
    expect(html).toContain('Historical result');
    expect(html).toContain('data-current-navigation="false"');
    expect(html).not.toContain('href="/policies/"');
    expect(html).not.toContain('Cancel check');
  });
  it('only cancels through an explicit enabled button', () => {
    let cancelled = 0;
    const running = {
      ...run,
      status: 'running',
      progress: {
        steps: run.progress.steps.map((s: any, i: number) =>
          i === 0
            ? { ...s, status: 'running', result: null }
            : { ...s, status: 'queued', result: null },
        ),
      },
    };
    const rendered = render({ run: running, canCancel: true, onCancel: () => cancelled++ });
    expect(cancelled).toBe(0);
    const button = rendered.elements.find(
      (e) => e.type === 'button' && e.props.children?.includes?.('Cancel check'),
    );
    expect(button).toBeTruthy();
    button.props.onClick();
    expect(cancelled).toBe(1);
  });
});
