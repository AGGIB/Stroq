import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as navigation from './workspace-review-navigation';
import * as bindings from './workspace-task-controls-binding';
import * as errors from './workspace-review-errors';
import { taskRecord, taskRun, taskWs } from './workspace-task-controls-fixtures';

function page(query = '') {
  const run = taskRun(),
    calls: unknown[] = [],
    elements: any[] = [],
    exports: any = {};
  const task: any = { canPrepare: true, prepare: (source: unknown) => calls.push(source) };
  const source = run.result!.capture.sources[0]!;
  const Report = (_props: any) => React.createElement('div', {}, 'Captured signals');
  const Recovery = (_props: any) => React.createElement('div', {}, 'Task change recovery');
  const code = ts.transpileModule(
    readFileSync(resolve(process.cwd(), 'components/platform/workspace-review.tsx'), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  vm.runInNewContext(code, {
    exports,
    URLSearchParams,
    require(name: string) {
      if (name === 'react') return { useRef: (value: unknown) => ({ current: value }) };
      if (name === 'react/jsx-runtime')
        return {
          ...jsx,
          jsx: (type: any, props: any, key: any) => {
            elements.push({ type, props });
            return jsx.jsx(type, props, key);
          },
          jsxs: (type: any, props: any, key: any) => {
            elements.push({ type, props });
            return jsx.jsxs(type, props, key);
          },
        };
      if (name === 'next/navigation')
        return {
          useSearchParams: () => new URLSearchParams(query),
          useRouter: () => ({ push: (href: unknown) => calls.push(href) }),
        };
      if (name === 'next/link')
        return {
          default: ({ children, ...props }: any) => React.createElement('a', props, children),
        };
      if (name === 'lucide-react')
        return new Proxy({}, { get: () => () => React.createElement('svg') });
      if (name === '@/components/platform-ui')
        return {
          Badge: ({ children }: any) => React.createElement('span', {}, children),
          Panel: ({ children, title }: any) => React.createElement('section', {}, title, children),
          PageHeading: ({ title, actions }: any) =>
            React.createElement('header', {}, title, actions),
          EmptyState: () => null,
          ExportButton: () => null,
        };
      if (name === '@/lib/workspace-review-navigation') return navigation;
      if (name === '@/lib/workspace-review-errors') return errors;
      if (name === '@/lib/workspace-task-controls-binding') return bindings;
      if (name === './workspace-review-report') return { WorkspaceReviewReport: Report };
      if (name === './workspace-monitor') return { WorkspaceMonitor: () => null };
      if (name === './use-workspace-review')
        return {
          useWorkspaceReview: () => ({
            state: {
              engine: { available: true },
              history: { status: 'ready' },
              baseline: run.result!.baseline,
              runs: [run],
            },
            run,
            allowed: true,
            localAccess: true,
            workspaceId: taskWs,
            workspaceLabel: 'Fixture',
            busy: null,
            running: null,
            needsRecheck: false,
            canReview: false,
          }),
        };
      if (name === './use-workspace-task-controls')
        return {
          useWorkspaceTaskControls: (props: any) => {
            calls.push({ bind: props });
            return task;
          },
        };
      if (name === './workspace-task-controls')
        return {
          WorkspaceTaskRecovery: Recovery,
          WorkspaceTaskOutcome: () => null,
          WorkspaceTaskControlsDialog: () => null,
        };
      throw Error(name);
    },
  });
  const html = renderToStaticMarkup(React.createElement(exports.WorkspaceReviewPage));
  return {
    html,
    calls,
    source,
    report: elements.find((element) => element.type === Report),
    recovery: elements.find((element) => element.type === Recovery),
  };
}
describe('workspace page task controls integration', () => {
  it('binds the selected captured source and starts only when its action is pressed', () => {
    const value = page();
    expect(value.report.props.onMakeTasksManual).toBeTypeOf('function');
    expect(value.calls).toHaveLength(1);
    value.report.props.onMakeTasksManual(value.source);
    expect(value.calls.at(-1)).toEqual(value.source);
  });
  it('retains exact recovery record URL selection alongside the existing run selection', () => {
    const value = page(`workspace=${taskWs}&run=${taskRun().id}&taskControl=${taskRecord().id}`);
    expect(value.html).toContain('Task change recovery');
    expect(value.recovery.props.selection).toEqual({
      requested: true,
      invalid: false,
      recordId: taskRecord().id,
    });
  });
});
