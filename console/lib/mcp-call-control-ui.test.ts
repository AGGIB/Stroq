import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as binding from './mcp-call-control-binding';
import { callInspection, callPreview, callRecheck, callReceipt } from './mcp-call-control-fixtures';
function render(configure: (a: any) => void = () => {}) {
  const exports: any = {},
    elements: any[] = [],
    calls: any[] = [];
  const action: any = {
    view: callInspection(),
    inspection: callInspection(),
    preview: null,
    ack: binding.emptyCallControlAck(),
    receipt: null,
    rechecked: null,
    busy: null,
    error: null,
    pending: [],
    needsRecheck: false,
    capacityReached: false,
    refresh: () => calls.push('refresh'),
    prepare: (v: any) => calls.push(v),
    apply: () => calls.push('apply'),
    recheck: (v: any) => calls.push(v),
    acknowledge: () => {},
    cancel: () => {},
  };
  configure(action);
  const code = ts.transpileModule(
    readFileSync(resolve(process.cwd(), 'components/platform/mcp-call-control.tsx'), 'utf8'),
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
      if (name === 'react')
        return { ...React, useEffect: () => {}, useRef: () => ({ current: null }) };
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
      if (name === 'lucide-react')
        return new Proxy({}, { get: () => () => React.createElement('svg') });
      if (name === '@/components/platform-ui')
        return { Badge: ({ children }: any) => React.createElement('span', null, children) };
      if (name === '@/lib/mcp-call-control-binding') return binding;
      if (name === './use-mcp-call-control') return {};
      throw Error(name);
    },
  });
  return {
    html: renderToStaticMarkup(
      React.createElement(exports.McpCallControlPanel, {
        action,
        disabled: false,
        onApply: () => calls.push('apply'),
      }),
    ),
    elements,
    calls,
  };
}
describe('compact call control presentation', () => {
  it('separates desired state from recorded refusal with one primary action', () => {
    const r = render();
    expect(r.html).toContain('Desired: enabled');
    expect(r.html).toContain('No matching refusal recorded');
    expect(r.html).toContain('Pause calls');
    expect(r.html).not.toContain('Protected');
    expect(r.calls).toEqual([]);
  });
  it('shows only scope consent for ordinary pause', () => {
    const r = render((a) => (a.preview = callPreview()));
    expect(r.elements.filter((e) => e.type === 'input')).toHaveLength(1);
    expect(r.html).toContain('Already dispatched calls');
    expect(r.html).not.toContain('unencrypted');
  });
  it('adds weakening, shared and storage consent only when relevant', () => {
    const resume = render((a) => {
      a.preview = callPreview('resume');
      a.preview.sharedUserScope = true;
      a.preview.artifact = { ...a.preview.artifact, scope: 'user' };
    });
    expect(resume.elements.filter((e) => e.type === 'input')).toHaveLength(3);
    expect(resume.html).toContain('Allow new calls again');
    expect(resume.html).not.toContain('unencrypted');
    const setup = render((a) => (a.preview = callPreview('setup')));
    expect(setup.elements.filter((e) => e.type === 'input')).toHaveLength(2);
    expect(setup.html).toContain('unencrypted');
    expect(setup.html).toContain('Reconnect');
  });
  it('never offers another write while completion is unknown', () => {
    const r = render((a) => {
      a.pending = [{ preview: callPreview(), startedAt: callPreview().createdAt }];
      a.needsRecheck = true;
    });
    expect(r.html).toContain('Recheck operation');
    expect(r.elements.filter((e) => e.type === 'button')).toHaveLength(1);
  });
  it('shows foreign pending as read-only retained evidence without blocking current profile actions', () => {
    const r = render((a) => {
      a.foreignPending = [
        {
          preview: { ...callPreview(), contextId: 'context-' + '8'.repeat(64) },
          startedAt: callPreview().createdAt,
        },
      ];
    });
    expect(r.html).toContain('Other local profile');
    expect(r.html).toContain('context-' + '8'.repeat(64));
    expect(r.html).toContain('Reconnect the original local profile');
    expect(r.html).toContain('Pause calls');
    expect(r.html).not.toContain('Recheck operation');
  });
  it('does not offer a write or recheck before a local profile has been verified', () => {
    const r = render((a) => {
      a.view = null;
      a.contextId = null;
      a.unscopedPending = [{ preview: callPreview(), startedAt: callPreview().createdAt }];
    });
    expect(r.html).toContain('Profile not verified');
    expect(r.html).not.toContain('Pause calls');
    expect(r.html).not.toContain('Recheck operation');
  });
  it('labels a historical operation and later desired state separately', () => {
    const r = render((a) => {
      a.rechecked = {
        ...callRecheck(),
        currentEventId: '00000000-0000-4000-8000-000000000099',
        currentMode: 'enabled',
      };
      a.view = null;
    });
    expect(r.html).toContain('Operation recorded');
    expect(r.html).toContain('Latest desired state: Enabled');
    expect(r.html).toContain('Later decision');
    expect(r.html).not.toContain('Calls blocked');
  });
  it('setup receipt asks for reconnect without implying live adoption', () => {
    const r = render((a) => {
      a.receipt = callReceipt(callPreview('setup'));
      a.view = null;
    });
    expect(r.html).toContain('Configured paused');
    expect(r.html).toContain('Reconnect the client');
    expect(r.html).not.toContain('Connection protected');
  });
  it('discloses renewed exact tool review when setup preserves the approval gate', () => {
    const r = render((a) => {
      a.preview = callPreview('setup');
      a.inspection = {
        ...callInspection(),
        modes: { ...callInspection().modes, toolApproval: true },
      };
    });
    expect(r.html).toContain('Tool approval remains required');
    expect(r.html).toContain('review tools for the new launch context');
  });
});
