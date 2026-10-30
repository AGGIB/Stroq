import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as schema from './incident-assessments';
import {
  assessmentBinding,
  assessmentRecord,
  assessmentState,
  assessmentPreview,
  assessmentReceipt,
  assessmentId,
} from './incident-assessment-fixtures';

function render(
  part: string,
  configure: (action: any) => void = () => {},
  selection = { requested: false, invalid: false, recordId: null as string | null },
) {
  const calls: unknown[] = [],
    elements: any[] = [],
    refs: { current: any }[] = [],
    exports: any = {};
  const dom: any = { activeElement: null, body: null };
  class FocusElement {
    isConnected = true;
    disabled = false;
    ariaDisabled = false;
    focused = 0;
    focus() {
      this.focused++;
      dom.activeElement = this;
    }
    matches() {
      return this.disabled || this.ariaDisabled;
    }
  }
  dom.body = new FocusElement();
  const controls: any = {
    state: assessmentState([assessmentRecord()]),
    available: true,
    open: true,
    incident: { ...assessmentBinding(), evidenceSha: assessmentBinding().evidenceSha256 },
    binding: assessmentBinding(),
    latest: assessmentRecord(),
    history: [assessmentRecord()],
    pending: [],
    needsRecheck: false,
    completionUnknown: false,
    choice: { assessment: null, reason: null },
    canSave: false,
    busy: null,
    error: null,
    receipt: null,
    show: () => calls.push('show'),
    close: () => calls.push('close'),
    setChoice: (...value: unknown[]) => calls.push(['choice', ...value]),
    save: () => calls.push('save'),
    refresh: () => calls.push('refresh'),
    recheck: (id: string) => calls.push(['recheck', id]),
  };
  configure(controls);
  const code = ts.transpileModule(
    readFileSync(resolve(process.cwd(), 'components/platform/incident-assessments.tsx'), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  const wrapper =
    (tag: string) =>
    ({ children, ...props }: any) =>
      React.createElement(
        tag,
        Object.fromEntries(
          Object.entries(props).filter(
            ([key, value]) =>
              !key.startsWith('on') && typeof value !== 'function' && key !== 'asChild',
          ),
        ),
        children,
      );
  vm.runInNewContext(code, {
    exports,
    document: dom,
    HTMLElement: FocusElement,
    require(name: string) {
      if (name === 'react')
        return {
          ...React,
          useEffect: () => {},
          useRef: (value: unknown) => {
            const ref = { current: value };
            refs.push(ref);
            return ref;
          },
        };
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
      if (name === 'next/link') return { default: wrapper('a') };
      if (name === 'lucide-react')
        return new Proxy({}, { get: () => () => React.createElement('svg') });
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
          ExportButton: wrapper('button'),
          Panel: wrapper('section'),
        };
      if (name === '@/lib/incident-assessments') return schema;
      throw Error(name);
    },
  });
  const html = renderToStaticMarkup(
    React.createElement(exports[part], {
      action: controls,
      onReturnFocus: () => calls.push('fallback-focus'),
    }),
  );
  return { html, calls, elements, refs, dom, FocusElement };
}
describe('compact incident assessment presentation', () => {
  it('keeps the current Reopened choice in the select without allowing another reopen', () => {
    const value = render('IncidentAssessmentDialog', (action) => {
      action.latest = { ...assessmentRecord(), assessment: 'reopened', reason: 'reassess' };
      action.choice = { assessment: 'reopened', reason: 'reassess' };
    });
    expect(value.html).toMatch(
      /<option[^>]*value="reopened"[^>]*selected=""[^>]*>Reopened<\/option>/,
    );
    expect(value.html).toMatch(/<option[^>]*value="reopened"[^>]*disabled=""/);
  });
  it('renders a single operator assessment line, separate from review or remediation claims', () => {
    const page = render('IncidentAssessmentLine');
    expect(page.html).toContain('Assessment');
    expect(page.html).toContain('Risk accepted');
    expect(page.html).toContain('Change');
    expect(page.html).not.toContain('Reviewed');
    expect(page.html).not.toContain('Resolved');
    expect(page.html).not.toContain('Protected');
    expect(page.calls).toEqual([]);
  });
  it('offers two finite fields and one Save action without a second acknowledgement screen', () => {
    const page = render('IncidentAssessmentDialog');
    expect(page.html).toContain('Assess finding');
    expect(page.html).toContain('Journal #12');
    expect(page.html).toContain('Policy, session taint and recorded evidence stay unchanged');
    expect(page.elements.filter((e) => e.type === 'select')).toHaveLength(2);
    expect(page.elements.filter((e) => e.type === 'input')).toHaveLength(0);
    expect(
      page.elements.find((e) => e.type === 'button' && e.props.children === 'Save assessment').props
        .disabled,
    ).toBe(true);
    const chosen = render('IncidentAssessmentDialog', (a) => {
      a.choice = { assessment: 'accepted-risk', reason: 'intended-workflow' };
      a.canSave = true;
    });
    expect(
      chosen.elements.find((e) => e.type === 'button' && e.props.children === 'Save assessment')
        .props.disabled,
    ).toBe(false);
    expect(chosen.calls).toEqual([]);
  });
  it('filters reasons by selected assessment and does not offer reopening without a prior assessment', () => {
    const page = render('IncidentAssessmentDialog', (a) => {
      a.latest = null;
      a.history = [];
      a.choice = { assessment: 'false-positive', reason: null };
    });
    const selects = page.elements.filter((e) => e.type === 'select'),
      options = page.elements.filter((e) => e.type === 'option');
    expect(selects).toHaveLength(2);
    expect(options.some((e) => e.props.value === 'reopened')).toBe(false);
    expect(options.some((e) => e.props.value === 'incorrect-match')).toBe(true);
    expect(options.some((e) => e.props.value === 'intended-workflow')).toBe(false);
  });
  it('keeps global pending saves visible after selecting another finding and uses point-in-time absence wording', () => {
    const page = render('IncidentAssessmentDialog', (a) => {
      a.pending = [{ preview: assessmentPreview(), startedAt: assessmentPreview().createdAt }];
      a.needsRecheck = true;
      a.receipt = {
        ...assessmentReceipt('recheck'),
        status: 'not-present',
        record: null,
        revision: null,
      };
    });
    expect(page.html).toContain('Save unconfirmed');
    expect(page.html).toContain('Recheck save');
    expect(page.html).toContain('No matching record at this check');
    expect(page.html).not.toContain('never written');
    const line = render('IncidentAssessmentLine', (a) => (a.completionUnknown = true));
    expect(line.html).toContain('Save unconfirmed');
    expect(line.html).not.toContain('Risk accepted');
  });
  it('presents an unconfirmed save once while retaining its explicit recheck actions', () => {
    const page = render('IncidentAssessmentDialog', (a) => {
      a.pending = [{ preview: assessmentPreview(), startedAt: assessmentPreview().createdAt }];
      a.needsRecheck = true;
      a.error = 'Save unconfirmed. Recheck this assessment before saving again.';
    });
    expect(page.html.match(/Save unconfirmed/g)).toHaveLength(1);
    expect(page.html).toContain('Recheck save');
    expect(page.calls).toEqual([]);
  });
  it('keeps distinct read, recheck and storage failures alongside the pending-save notice', () => {
    for (const error of [
      schema.INCIDENT_ASSESSMENT_ERROR_MESSAGES['history-unavailable'],
      'The recheck response could not be verified.',
    ]) {
      const page = render('IncidentAssessmentDialog', (a) => {
        a.needsRecheck = true;
        a.pending = [{ preview: assessmentPreview(), startedAt: assessmentPreview().createdAt }];
        a.error = error;
      });
      expect(page.html).toContain(error);
      expect(page.html).toContain('Save unconfirmed');
      expect(page.html).toContain('Recheck save');
    }
    const full = render('IncidentAssessmentDialog', (a) => {
      a.state = { ...a.state, canRecord: false, error: 'store-full' };
      a.needsRecheck = true;
      a.error = 'Save unconfirmed. Recheck this assessment before saving again.';
    });
    expect(full.html).toContain('Assessment storage is full');
    expect(full.html.match(/Save unconfirmed/g)).toHaveLength(1);
  });
  it('omits an empty history disclosure while keeping the assessment controls available', () => {
    const page = render('IncidentAssessmentDialog', (a) => {
      a.latest = null;
      a.history = [];
    });
    expect(page.html).not.toContain('Assessment history · 0');
    expect(page.html).not.toContain('No retained assessments');
    expect(page.elements.filter((e) => e.type === 'select')).toHaveLength(2);
    expect(page.html).toContain('Save assessment');
  });
  it('shows unavailable history explicitly and retains finite full-store history as read-only evidence', () => {
    const missing = render('IncidentAssessmentDialog', (a) => {
      a.state = null;
      a.available = false;
      a.history = [];
      a.latest = null;
    });
    expect(missing.html).toContain('Assessment unavailable');
    expect(missing.html).not.toContain('No retained assessments');
    const full = render('IncidentAssessmentDialog', (a) => {
      a.state = { ...a.state, canRecord: false, error: 'store-full' };
    });
    expect(full.html).toContain('Assessment storage is full');
    expect(full.html).toContain('Assessment history');
    expect(full.html).toContain('Risk accepted');
  });
  it('keeps history in reverse append order and identifies every retained decision and reason', () => {
    const page = render('IncidentAssessmentDialog', (a) => {
      a.history = [
        {
          ...assessmentRecord(),
          id: assessmentId('4'),
          assessment: 'confirmed-issue',
          reason: 'unintended-action',
          assessedAt: '2026-10-24T09:59:59.000Z',
        },
        assessmentRecord(),
      ];
    });
    expect(page.elements.filter((e) => e.type === 'time').map((e) => e.props.dateTime)).toEqual([
      '2026-10-24T10:00:00.000Z',
      '2026-10-24T09:59:59.000Z',
    ]);
    expect(page.html).toContain('An unintended action was requested');
    expect(page.html).toContain('Needed for this workflow');
  });
  it('returns focus to a connected enabled opener and otherwise uses the inspector fallback', () => {
    for (const property of [null, 'isConnected', 'disabled', 'ariaDisabled'] as const) {
      const page = render('IncidentAssessmentDialog'),
        opener = new page.FocusElement();
      page.dom.activeElement = opener;
      const dialog = page.elements.find(
        (e) => e.props.className === 'dialog-content mcp-containment-dialog',
      );
      dialog.props.onOpenAutoFocus({ preventDefault() {} });
      if (property) opener[property] = property === 'isConnected' ? false : true;
      dialog.props.onCloseAutoFocus({ preventDefault() {} });
      expect(opener.focused).toBe(property ? 0 : 1);
      expect(page.calls).toEqual(property ? ['fallback-focus'] : []);
    }
  });
});
