import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as schema from './session-taint';
import * as binding from './session-taint-binding';

import {
  taintPreview,
  taintReceipt,
  taintRecord,
  taintHistory,
  taintInspection,
  taintWs,
} from './session-taint-fixtures';

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
    state: taintHistory([taintRecord()]),
    open: true,
    inspection: taintInspection(),
    records: [taintRecord()],
    workspaceId: taintWs,
    preview: taintPreview(),
    ack: { effects: false, retention: false },
    busy: null,
    error: null,
    canPrepare: true,
    needsRecheck: false,
    unresolved: [],
    unresolvedRecords: [],
    receipt: taintReceipt(),
    acknowledge: (...args: unknown[]) => calls.push(args),
    apply: () => calls.push('apply'),
    close: () => calls.push('close'),
    refresh: () => calls.push('refresh'),
    recheck: (id: string) => calls.push(['recheck', id]),
    inspect: () => calls.push('inspect'),
    prepare: () => calls.push('preview'),
  };
  configure(controls);
  const code = ts.transpileModule(
    readFileSync(
      resolve(
        process.cwd(),
        part === 'IncidentDetailDialog'
          ? 'components/platform/incident-detail.tsx'
          : 'components/platform/session-taint.tsx',
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
      if (name === './use-session-taint')
        return {
          useSessionTaint: (selected: unknown) => {
            calls.push(['taint-selection', selected]);
            return controls;
          },
        };
      if (name === './session-taint')
        return {
          SessionTaintPanel: wrapper('session-taint-panel'),
          SessionTaintDialog: wrapper('session-taint-dialog'),
        };
      if (name === './use-incident-task')
        return { useIncidentTask: () => ({ getReport: () => null }) };
      if (name === './use-task-access') return { useTaskAccess: () => ({}) };
      if (name === './use-incident-recorded-evidence')
        return { useIncidentRecordedEvidence: () => ({ getReport: () => null }) };
      if (name === './incident-recorded-evidence')
        return { IncidentRecordedEvidencePanel: () => null };
      if (name === './incident-assessments')
        return { IncidentAssessmentDialog: () => null, IncidentAssessmentLine: () => null };
      if (name.startsWith('./')) return new Proxy({}, { get: () => wrapper('div') });
      if (name === '@/lib/session-taint') return schema;
      if (name === '@/lib/session-taint-binding') return binding;
      if (name === '@/lib/incident-assessment-export')
        return { incidentAssessmentExport: () => null };
      throw Error(name);
    },
  });
  const html = renderToStaticMarkup(
    React.createElement(exports[part], {
      action: controls,
      selected: {
        ...taintInspection().incident,
        evidenceSha: taintInspection().incident.evidenceSha256,
        title: 'Recorded finding',
        status: 'open',
        kind: 'content-flag',
        categories: [],
        relatedIds: [],
        secretReferences: 0,
      },
      incidents: [],
      assessments: { busy: null, state: null, pending: [] },
      busy: false,
      reviewing: false,
      error: null,
      comparison: null,
      comparing: false,
      href: '/incidents/',
      onSelect: (value: unknown) => calls.push(['select', value]),
      onReview: () => calls.push('review'),
      onCompare: () => {},
      selection,
      workspaceId: taintWs,
      onReturnFocus: () => calls.push('fallback-focus'),
    }),
  );
  return { html, calls, elements, refs, dom, FocusElement };
}
describe('compact stored session taint controls', () => {
  it('embeds the exact selected finding recovery without changing its review state and prevents dismissal during clear', () => {
    const page = render('IncidentDetailDialog', (a) => (a.busy = 'clear'));
    expect(page.html).toContain('session-taint-panel');
    expect(page.html).toContain('session-taint-dialog');
    expect(page.calls[0]).toEqual([
      'taint-selection',
      expect.objectContaining({
        id: taintInspection().incident.id,
        evidenceSha: taintInspection().incident.evidenceSha256,
      }),
    ]);
    expect(page.calls).not.toContain('review');
    const root = page.elements.find((e) => e.props.open === true && e.props.onOpenChange);
    root.props.onOpenChange(false);
    expect(page.calls.some((c) => Array.isArray(c) && c[0] === 'select')).toBe(false);
  });
  it('has explicit inspection and current measured facts, with no automatic clear or reviewed claim', () => {
    const page = render('SessionTaintPanel');
    expect(page.html).toContain('Inspect session taint');
    expect(page.html).toContain('Stored taint');
    expect(page.html).toContain('Suspect');
    expect(page.html).toContain('Learned-origin records');
    expect(page.html).toContain('Preview clear');
    expect(page.html).not.toContain('Protected');
    expect(page.html).not.toContain('Resolved');
    expect(page.calls).toEqual([]);
  });
  it('presents entire-session weakening and private original-state retention as two unchecked consents', () => {
    const page = render('SessionTaintDialog');
    expect(page.html).toContain('Clear stored session taint');
    expect(page.html).toContain('Clear the stored taint for this entire session');
    expect(page.html).toContain('unencrypted');
    expect(page.html).toContain('Learned origins remain');
    expect(page.html).toContain(taintPreview().inspection.revisionSha256);
    const boxes = page.elements.filter((e) => e.type === 'input');
    expect(boxes).toHaveLength(2);
    expect(boxes.every((e) => e.props.checked === false)).toBe(true);
    expect(
      page.elements.find(
        (e) => e.type === 'button' && e.props.children === 'Clear stored session taint',
      ).props.disabled,
    ).toBe(true);
    const accepted = render(
      'SessionTaintDialog',
      (a) => (a.ack = { effects: true, retention: true }),
    );
    expect(
      accepted.elements.find(
        (e) => e.type === 'button' && e.props.children === 'Clear stored session taint',
      ).props.disabled,
    ).toBe(false);
  });
  it('keeps historical confirmation separate from null or newly suspect current state', () => {
    const missing = render('SessionTaintOutcome', (a) => {
      a.receipt.record.current = null;
      a.receipt.record.error = 'session-unavailable';
    });
    expect(missing.html).toContain('Stored taint clear confirmed');
    expect(missing.html).toContain('Current state unavailable');
    expect(missing.html).not.toContain('No stored taint');
    const changed = render(
      'SessionTaintOutcome',
      (a) => (a.receipt.record.current = taintInspection()),
    );
    expect(changed.html).toContain('Stored taint clear confirmed');
    expect(changed.html).toContain('Session is suspect at last check');
  });
  it('labels a no-publication observation historically while showing the later measured state', () => {
    const page = render('SessionTaintOutcome', (a) => {
      a.receipt.operation = 'recheck';
      a.receipt.writeConfirmed = false;
      a.receipt.record.status = 'unchanged';
      a.receipt.record.afterTaintSha256 = null;
      a.receipt.record.preservedProvenanceSha256 = null;
      a.receipt.record.current = taintInspection();
    });
    expect(page.html).toContain('Original taint observed');
    expect(page.html).toContain('Session is suspect at last check');
    expect(page.html).not.toContain('Original stored taint confirmed');
    expect(page.html).not.toContain('Stored taint clear confirmed');
  });
  it('shows pending recovery and unavailable history without enabling preview', () => {
    const page = render('SessionTaintPanel', (a) => {
      a.needsRecheck = true;
      a.canPrepare = false;
      a.unresolved = [{ preview: taintPreview(), startedAt: taintPreview().createdAt }];
    });
    expect(page.html).toContain('Completion is unknown');
    expect(page.html).toContain('Recheck change');
    const unavailable = render('SessionTaintPanel', (a) => {
      a.state = {
        ...taintHistory(),
        available: false,
        history: 'unavailable',
        error: 'history-unavailable',
      };
      a.canPrepare = false;
    });
    expect(unavailable.html).toContain('Private session recovery history could not be verified');
  });
  it('returns Escape focus to the actual opener and falls back when it disconnects', () => {
    for (const disconnected of [false, true]) {
      const page = render('SessionTaintDialog'),
        opener = new page.FocusElement();
      page.dom.activeElement = opener;
      const dialog = page.elements.find(
        (e) => e.props.className === 'dialog-content mcp-containment-dialog',
      );
      dialog.props.onOpenAutoFocus({ preventDefault() {} });
      opener.isConnected = !disconnected;
      dialog.props.onCloseAutoFocus({ preventDefault() {} });
      expect(opener.focused).toBe(disconnected ? 0 : 1);
      expect(page.calls).toEqual(disconnected ? ['fallback-focus'] : []);
    }
  });
});
