import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as navigation from './incident-navigation';
import * as incidentSchema from './incidents';
import * as assessmentSchema from './incident-assessments';
import * as assessmentQueue from './incident-assessment-queue';
import * as assessmentExport from './incident-assessment-export';
import { recordedEvidence } from './incident-recorded-evidence-fixtures';
import {
  assessmentBinding,
  assessmentPreview,
  assessmentRecord,
  assessmentState,
} from './incident-assessment-fixtures';

function finding() {
  const value = assessmentBinding();
  return {
    id: value.id,
    evidenceSha: value.evidenceSha256,
    sequence: value.sequence,
    recordedAt: value.recordedAt,
    kind: value.kind,
    severity: 'high' as const,
    title: 'Policy denied a tool call' as const,
    categories: ['network'],
    relatedIds: [],
    secretReferences: 0,
    status: 'reviewed' as const,
    reviewedAt: value.recordedAt,
  };
}
function render(part: 'page' | 'detail', configure: (action: any) => void = () => {}) {
  const incident = finding(),
    calls: any[] = [],
    elements: any[] = [],
    exports: any = {};
  const action: any = {
    state: assessmentState([assessmentRecord()]),
    available: true,
    busy: null,
    error: null,
    open: false,
    incident,
    binding: assessmentBinding(),
    latest: assessmentRecord(),
    history: [assessmentRecord()],
    pending: [],
    needsRecheck: false,
    completionUnknown: false,
    choice: { assessment: null, reason: null },
    canSave: false,
    receipt: null,
    show: () => calls.push('show'),
    close: () => calls.push('close'),
    setChoice: () => {},
    save: () => {},
    refresh: () => calls.push('assessment-refresh'),
    recheck: () => {},
  };
  configure(action);
  const source = {
    schema: 'stroq-incidents/1',
    source: 'local',
    generatedAt: assessmentState().generatedAt,
    window: { kind: 'available', truncated: false, omitted: 0 },
    incidents: [incident],
    limitations: [],
  };
  const wrapper =
    (tag: string) =>
    ({ children, ...props }: any) =>
      React.createElement(
        tag,
        Object.fromEntries(
          Object.entries(props).filter(
            ([key, value]) =>
              !key.startsWith('on') &&
              typeof value !== 'function' &&
              key !== 'asChild' &&
              key !== 'data',
          ),
        ),
        children,
      );
  const Detail = () => null;
  const exportButton = ({ label = 'Export' }: any) => React.createElement('button', {}, label);
  const modules: Record<string, any> = {
    '@/lib/incident-navigation': navigation,
    '@/lib/incidents': incidentSchema,
    '@/lib/incident-assessments': assessmentSchema,
    '@/lib/incident-assessment-queue': assessmentQueue,
    '@/lib/incident-assessment-export': assessmentExport,
    './use-incidents': {
      useIncidentEvidence: () => ({
        localAccess: true,
        state: source,
        verification: null,
        comparisons: [],
        busy: null,
        error: null,
        refresh: () => calls.push('evidence-refresh'),
        verify: () => {},
        review: () => calls.push('review'),
        compare: () => {},
      }),
    },
    './use-incident-assessments': {
      useIncidentAssessments: (value: unknown) => {
        calls.push(['assessment-hook', value]);
        return action;
      },
    },
    './incident-detail': { IncidentDetailDialog: Detail, CapturedJournalPanel: () => null },
    './incident-assessments': {
      IncidentAssessmentBadge: ({ record, unavailable, pending }: any) =>
        React.createElement(
          'span',
          {},
          pending
            ? 'Save unconfirmed'
            : unavailable
              ? 'Assessment unavailable'
              : record
                ? assessmentSchema.INCIDENT_ASSESSMENT_LABELS[
                    record.assessment as assessmentSchema.IncidentAssessmentDecision
                  ]
                : 'Not assessed',
        ),
      IncidentAssessmentLine: ({ action: a }: any) =>
        React.createElement(
          'span',
          {},
          a.completionUnknown
            ? 'Save unconfirmed'
            : a.latest
              ? 'Assessment: ' +
                assessmentSchema.INCIDENT_ASSESSMENT_LABELS[
                  a.latest.assessment as assessmentSchema.IncidentAssessmentDecision
                ]
              : 'Not assessed',
        ),
      IncidentAssessmentDialog: () => null,
    },
    './use-incident-task': {
      useIncidentTask: () => ({ getReport: () => ({ status: 'not-related' }) }),
    },
    './use-task-access': { useTaskAccess: () => ({}) },
    './use-session-taint': { useSessionTaint: () => ({ busy: action._taintBusy ?? null }) },
    './use-incident-recorded-evidence': {
      useIncidentRecordedEvidence: (value: unknown) => {
        calls.push(['recorded-evidence-hook', value]);
        return {
          report: action._recordedEvidence ?? null,
          getReport: () => action._recordedExport ?? null,
        };
      },
    },
    './incident-recorded-evidence': { IncidentRecordedEvidencePanel: () => null },
    './task-access': { TaskAccessDialog: () => null, TaskAccessTrigger: () => null },
    './session-taint': { SessionTaintDialog: () => null, SessionTaintPanel: () => null },
    './incident-comparison': { IncidentComparisonPanel: () => null },
    './incident-link': { IncidentLink: () => null },
    './incident-task': { IncidentTask: () => null },
  };
  const code = ts.transpileModule(
    readFileSync(
      resolve(
        process.cwd(),
        `components/platform/${part === 'page' ? 'incidents' : 'incident-detail'}.tsx`,
      ),
      'utf8',
    ),
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
    window: {
      history: {
        pushState: (...values: any[]) => calls.push(['navigate', ...values]),
        replaceState: (...values: any[]) => calls.push(['navigate', ...values]),
      },
    },
    require(name: string) {
      if (name === 'react')
        return { ...React, useEffect: () => {}, useRef: (value: any) => ({ current: value }) };
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
        return { useSearchParams: () => new URLSearchParams({ status: 'all', id: incident.id }) };
      if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
      if (name === 'radix-ui')
        return {
          Dialog: {
            Root: ({ open, children }: any) => (open ? children : null),
            Portal: wrapper('div'),
            Overlay: wrapper('div'),
            Content: wrapper('div'),
            Title: wrapper('h2'),
            Description: wrapper('p'),
            Close: wrapper('button'),
          },
        };
      if (name === '@/components/platform-ui')
        return {
          Badge: wrapper('span'),
          Panel: ({ children, title, actions }: any) =>
            React.createElement('section', {}, title, actions, children),
          PageHeading: ({ title, actions }: any) =>
            React.createElement('header', {}, title, actions),
          EmptyState: () => null,
          ExportButton: exportButton,
        };
      if (name in modules) return modules[name];
      throw Error(name);
    },
  });
  const props =
    part === 'page'
      ? {}
      : {
          selected: incident,
          incidents: [incident],
          busy: false,
          reviewing: false,
          error: null,
          onSelect: (value: unknown) => calls.push(['select', value]),
          onReview: () => calls.push('review'),
          comparison: null,
          comparing: false,
          href: '/incidents/',
          onCompare: () => {},
          onReturnFocus: () => {},
          assessments: action,
        };
  const html = renderToStaticMarkup(
    React.createElement(
      part === 'page' ? exports.IncidentsPage : exports.IncidentDetailDialog,
      props,
    ),
  );
  return {
    html,
    calls,
    elements,
    action,
    incident,
    source,
    exports: elements.filter((item) => item.type === exportButton),
    detail: elements.find((item) => item.type === Detail)?.props,
  };
}
describe('joined operator assessment investigations', () => {
  it('owns one summary hook at the page and keeps operator assessment beside the independent review status', () => {
    const r = render('page');
    expect(
      r.calls.filter((value) => Array.isArray(value) && value[0] === 'assessment-hook'),
    ).toEqual([['assessment-hook', r.incident]]);
    expect(r.detail.assessments).toBe(r.action);
    expect(r.html).toContain('Reviewed');
    expect(r.html).toContain('Risk accepted');
    expect(r.exports[0].props.data().schema).toBe('stroq-investigations-export/2');
  });
  it('pending saves take precedence over a candidate returned by an ordinary summary read', () => {
    const r = render('page', (a) => {
      a.pending = [{ preview: assessmentPreview(), startedAt: assessmentPreview().createdAt }];
      a.needsRecheck = true;
      a.completionUnknown = true;
    });
    expect(r.html).toContain('Save unconfirmed');
    expect(r.html).not.toContain('Risk accepted');
    const report = r.exports[0].props.data();
    expect(report.operatorAssessments.completionUnknown).toBe(true);
    expect(JSON.stringify(report)).not.toContain(assessmentPreview().id);
  });
  it('blocks finding/filter/close changes while an assessment is publishing', () => {
    const r = render('page', (a) => {
      a.busy = 'apply';
    });
    r.detail.onSelect(null);
    r.elements
      .find(
        (item) =>
          item.type === 'button' && item.props['aria-label'] === 'Investigate journal entry 12',
      )
      .props.onClick({ currentTarget: {} });
    r.elements
      .find((item) => item.type === 'button' && item.props.children === 'All')
      .props.onClick();
    expect(r.calls.some((value) => Array.isArray(value) && value[0] === 'navigate')).toBe(false);
    expect(r.detail.busy).toBe(true);
  });
  it('exports exact selected annotation history from the inspector without a save capability', () => {
    const r = render('detail', (a) => {
      a.pending = [{ preview: assessmentPreview(), startedAt: assessmentPreview().createdAt }];
      a.completionUnknown = true;
    });
    expect(r.html).toContain('Save unconfirmed');
    const report = r.exports[0].props.data();
    expect(report.schema).toBe('stroq-investigation-export/4');
    expect(report.operatorAssessments.records).toEqual([assessmentRecord()]);
    expect(report.operatorAssessments.completionUnknown).toBe(true);
    expect(JSON.stringify(report)).not.toContain(assessmentPreview().id);
  });
  it('selects recorded evidence for this exact finding and exports only currently accepted evidence', () => {
    const evidence = recordedEvidence(finding());
    const accepted = render('detail', (a) => {
      a._recordedEvidence = evidence;
      a._recordedExport = evidence;
    });
    expect(accepted.calls).toContainEqual(['recorded-evidence-hook', finding()]);
    expect(accepted.exports[0].props.data().recordedEvidence).toEqual(evidence);
    const stale = render('detail', (a) => {
      a._recordedEvidence = evidence;
    });
    expect(stale.exports[0].props.data().recordedEvidence).toBeNull();
  });
  it('keeps the parent inspector open and review disabled while assessment apply runs', () => {
    const r = render('detail', (a) => {
      a.busy = 'apply';
    });
    const dialog = r.elements.find(
      (item) => item.props.open === true && typeof item.props.onOpenChange === 'function',
    );
    dialog.props.onOpenChange(false);
    expect(r.calls).not.toContainEqual(['select', null]);
    expect(
      r.elements.find((item) => item.props['aria-label'] === 'Close investigation').props.disabled,
    ).toBe(true);
    expect(
      r.elements.find(
        (item) =>
          item.type === 'button' &&
          typeof item.props.onClick === 'function' &&
          JSON.stringify(item.props.children)?.includes('Reopen review'),
      ).props.disabled,
    ).toBe(true);
  });
  it('disables assessment entry and its dialog during an independent taint clear', () => {
    const r = render('detail', (a) => {
      a._taintBusy = 'clear';
    });
    const assessmentParts = r.elements.filter((item) => item.props.action === r.action);
    expect(assessmentParts).toHaveLength(2);
    expect(assessmentParts.every((item) => item.props.disabled === true)).toBe(true);
  });
});
