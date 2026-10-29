import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { ACTION_LABELS } from './incident-comparison';
import { recordedEvidence, recordedFinding } from './incident-recorded-evidence-fixtures';

function render(configure: (action: any) => void = () => {}) {
  const action: any = {
    available: true,
    report: recordedEvidence(),
    loading: false,
    error: null,
    refresh: () => {},
    getReport: () => null,
  };
  configure(action);
  const exports: any = {};
  const code = ts.transpileModule(
    readFileSync(
      resolve(process.cwd(), 'components/platform/incident-recorded-evidence.tsx'),
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
    require(name: string) {
      if (name === 'react/jsx-runtime') return jsx;
      if (name === 'lucide-react')
        return new Proxy({}, { get: () => () => React.createElement('svg') });
      if (name === '@/lib/incident-comparison') return { ACTION_LABELS };
      if (name === '@/components/platform-ui')
        return { Badge: ({ children }: any) => React.createElement('span', null, children) };
      throw Error(name);
    },
  });
  return renderToStaticMarkup(
    React.createElement(exports.IncidentRecordedEvidencePanel, { action, disabled: false }),
  );
}

describe('compact recorded evidence panel', () => {
  it('shows recorded classes and origin counts separately from current policy or host outcome', () => {
    const html = render();
    expect(html).toContain('Recorded evidence');
    expect(html).toContain('Outbound shell command');
    expect(html).toContain('Untrusted source');
    expect(html).toContain('2 recorded');
    expect(html).toContain('1 marked suspect');
    expect(html).toContain('Policy refusal retained');
    expect(html).toContain('Evidence details');
    expect(html).not.toContain('Blocked successfully');
    expect(html).not.toContain('Current policy would');
  });
  it('keeps missing, unavailable and partial collection states distinct from a valid empty list', () => {
    const empty = render((a) => {
      a.report.classes.values = [];
      a.report.provenance.values = [];
    });
    expect(empty).toContain('Recorded classes: none');
    const missing = render((a) => {
      a.report.classes = { status: 'not-recorded', values: [], omitted: 0 };
      a.report.provenance = { status: 'not-recorded', values: [], omitted: 0 };
    });
    expect(missing).toContain('Action classes not recorded');
    expect(missing).toContain('Origin matches not recorded');
    expect(missing).not.toContain('0 recorded origin matches');
    const partial = render((a) => {
      a.report.classes.status = 'partial';
      a.report.classes.omitted = 3;
      a.report.window.truncated = true;
    });
    expect(partial).toContain('Partial journal window');
    expect(partial).toContain('3 omitted');
    const unavailable = render((a) => {
      a.report.classes = { status: 'unavailable', values: [], omitted: 0 };
    });
    expect(unavailable).toContain('Action classes unavailable');
  });
  it('describes content scan score and recorded trust exemption without inferring session taint', () => {
    for (const trusted of [null, false, true]) {
      const html = render((a) => {
        const finding = recordedFinding();
        finding.kind = 'content-flag';
        a.report = recordedEvidence(finding);
        a.report.scan.trusted = trusted;
      });
      expect(html).toContain('Scanner score');
      expect(html).toContain(
        trusted === true
          ? 'Trust exemption recorded'
          : trusted === false
            ? 'No trust exemption recorded'
            : 'Trust exemption not recorded',
      );
      expect(html).not.toContain('Session tainted');
      expect(html).not.toContain('80% attack');
    }
  });
  it('makes pending and failed reads visible and offers an explicit refresh', () => {
    const pending = render((a) => {
      a.report = null;
      a.loading = true;
    });
    expect(pending).toContain('Reading recorded evidence');
    expect(pending).toContain('aria-busy="true"');
    const failed = render((a) => {
      a.report = null;
      a.error = 'Recorded evidence unavailable. Refresh to retry.';
    });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Refresh recorded evidence');
  });
});
