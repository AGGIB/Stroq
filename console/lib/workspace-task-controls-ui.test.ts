import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as review from './workspace-review';
import * as labels from './workspace-review-labels';
import * as taskControls from './workspace-task-controls';

const sha = (digit: string) => digit.repeat(64);
function result(): review.WorkspaceReviewResult {
  const source: review.WorkspaceReviewSource = {
    id: taskControls.WORKSPACE_TASK_SOURCE_ID,
    label: '.vscode/tasks.json',
    labelHidden: false,
    kind: 'file',
    role: 'workspace',
    sha256: sha('b'),
    mode: 420,
  };
  const capture: review.WorkspaceReviewCapture = {
    schema: 'stroq-workspace-capture/1',
    workspaceId: `workspace-${'a'.repeat(24)}`,
    captureSha256: sha('c'),
    capturedAt: '2026-10-24T10:00:00.000Z',
    profile: {
      id: 'stroq-workspace-surface/1',
      engineVersion: '0.28.0',
      runtimeSha256: sha('d'),
      scopeSha256: sha('e'),
    },
    complete: true,
    coverage: { omittedSources: 0, omittedEntries: 0, exclusions: [], gaps: [] },
    sources: [source],
    entries: ['f', '1'].map((digit) => ({
      id: `entry-${sha(digit)}`,
      sourceId: source.id,
      kind: 'editor-autorun-task',
      stage: 'on-open',
      severity: 'error',
      line: 4,
      count: 1,
      semanticSha256: sha(digit),
    })),
  };
  const before: review.WorkspaceReviewCapture = {
    ...capture,
    captureSha256: sha('2'),
    capturedAt: '2026-10-24T09:00:00.000Z',
    entries: [{ ...capture.entries[0]!, id: `entry-${sha('3')}`, semanticSha256: sha('3') }],
  };
  const baseline: review.WorkspaceReviewBaseline = {
    status: 'available',
    revision: sha('4'),
    reviewedAt: '2026-10-24T09:01:00.000Z',
    capture: before,
  };
  return {
    capture,
    baseline,
    comparison: review.deriveWorkspaceReviewComparison(capture, baseline),
    canReview: true,
  };
}
function render(value = result(), disabled = false) {
  const elements: any[] = [],
    selected: unknown[] = [],
    exports: any = {};
  const code = ts.transpileModule(
    readFileSync(resolve(process.cwd(), 'components/platform/workspace-review-report.tsx'), 'utf8'),
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
    require(name: string) {
      if (name === 'react/jsx-runtime')
        return {
          ...jsx,
          jsx(type: any, props: any, key: any) {
            elements.push({ type, props });
            return jsx.jsx(type, props, key);
          },
          jsxs(type: any, props: any, key: any) {
            elements.push({ type, props });
            return jsx.jsxs(type, props, key);
          },
        };
      if (name === '@/components/platform-ui')
        return { Badge: ({ children }: any) => React.createElement('span', {}, children) };
      if (name === '@/lib/workspace-review') return review;
      if (name === '@/lib/workspace-review-labels') return labels;
      if (name === '@/lib/workspace-task-controls') return taskControls;
      throw Error(name);
    },
  });
  const html = renderToStaticMarkup(
    React.createElement(exports.WorkspaceReviewReport, {
      result: value,
      onMakeTasksManual: (source: unknown) => selected.push(source),
      taskControlsDisabled: disabled,
    }),
  );
  const actions = elements.filter(
    (element) => element.type === 'button' && element.props.children === 'Make tasks manual…',
  );
  return { html, actions, selected };
}
describe('source-bound task action in the actual workspace report', () => {
  it('offers one explicit action for the fixed task file, never repeated in Added or Removed signals', () => {
    const value = result();
    const page = render(value);
    expect(page.actions).toHaveLength(1);
    expect(page.selected).toEqual([]);
    page.actions[0].props.onClick({ currentTarget: null });
    expect(page.selected).toEqual([value.capture.sources[0]]);
    expect(page.html).toContain('Added signals');
    expect(page.html).toContain('Removed signals');
  });
  it('does not offer a write for settings, workspace files, nested task files, links or hidden labels', () => {
    for (const change of [
      { label: '.vscode/settings.json' },
      { label: 'team.code-workspace' },
      { label: 'nested/.vscode/tasks.json' },
      { kind: 'link' as const },
      { role: 'git-metadata' as const },
      { labelHidden: true },
    ]) {
      const value = result();
      value.capture.sources[0] = { ...value.capture.sources[0]!, ...change };
      expect(render(value).actions).toHaveLength(0);
    }
  });
  it('keeps an action disabled while source controls are unavailable or another operation is pending', () => {
    const page = render(result(), true);
    expect(page.actions).toHaveLength(1);
    expect(page.actions[0].props.disabled).toBe(true);
  });
});
describe('coverage gaps in the actual workspace report', () => {
  it('names every gap the capture can record in words, with its own block open', () => {
    const value = result();
    value.capture = {
      ...value.capture,
      complete: false,
      coverage: {
        ...value.capture.coverage,
        gaps: review.WORKSPACE_REVIEW_GAPS.map((code) => ({
          code,
          sourceId: null,
          label: null,
          labelHidden: false,
        })),
      },
    };
    value.comparison = review.deriveWorkspaceReviewComparison(value.capture, value.baseline);
    const { html } = render(value);
    expect(html).toContain('Partial capture');
    expect(html).toContain(
      '<details class="live-details" open=""><summary>Coverage gaps</summary>',
    );
    const block = html.split('<summary>Coverage gaps</summary><ul>')[1]!.split('</ul>')[0]!;
    const items = [...block.matchAll(/<li>([^<]*)<\/li>/g)].map((match) => match[1] ?? '');
    expect(items).toHaveLength(review.WORKSPACE_REVIEW_GAPS.length);
    expect(items.every((text) => text.length > 0)).toBe(true);
    expect(items).toContain(
      'Workspace is inside a Git repository whose configuration and hooks were not read',
    );
    expect(items).toContain('Nested Git repository whose configuration and hooks were not read');
  });
});
