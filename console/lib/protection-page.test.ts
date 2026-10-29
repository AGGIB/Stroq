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
import * as navigation from './protection-check-navigation';
import * as governanceNavigation from './mcp-governance-navigation';
const workspaceId = `workspace-${'a'.repeat(24)}`;
function harness(query = '', configure?: (state: any) => void) {
  const calls: any[] = [],
    elements: any[] = [],
    effects: (() => void)[] = [],
    exports: any = {};
  const context = {
    workspaceId: 'a'.repeat(64),
    policySha256: 'b'.repeat(64),
    runtimeSha256: 'c'.repeat(64),
  };
  const state: any = {
    ready: true,
    loading: false,
    error: null,
    control: {
      engine: { available: true, version: '0.28.0' },
      workspaceId,
      context,
      history: { status: 'ready' },
    },
    runs: [],
    busy: false,
    needsRecheck: false,
    refresh: async (explicit?: boolean) => {
      calls.push({ read: explicit });
    },
    start: async (input: any) => {
      calls.push(input);
      return null;
    },
    cancel: async () => {},
  };
  configure?.(state);
  const code = ts.transpileModule(
    readFileSync(resolve(process.cwd(), 'components/platform/protection.tsx'), 'utf8'),
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
    requestAnimationFrame: () => {},
    require(name: string) {
      if (name === 'react')
        return {
          ...React,
          useState: (v: any) => [typeof v === 'function' ? v() : v, () => {}],
          useRef: (v: any) => ({ current: v }),
          useEffect: (effect: () => void) => effects.push(effect),
          useCallback: (v: any) => v,
        };
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
      if (name === 'next/navigation')
        return {
          useSearchParams: () => new URLSearchParams(query),
          useRouter: () => ({ push: (href: string) => calls.push(href) }),
        };
      if (name === 'next/link')
        return { default: ({ children, ...p }: any) => React.createElement('a', p, children) };
      if (name === 'lucide-react')
        return new Proxy({}, { get: () => () => React.createElement('svg') });
      if (name === '@/components/control-provider') return { useControl: () => state };
      if (name === '@/components/platform-provider')
        return {
          usePlatform: () => ({
            localAccess: true,
            localContext: { workspace: { id: workspaceId } },
          }),
        };
      if (name === '@/components/platform-ui')
        return {
          PageHeading: ({ title, actions }: any) =>
            React.createElement('header', {}, title, actions),
          Panel: ({ children }: any) => React.createElement('section', {}, children),
          Badge: ({ children }: any) => React.createElement('span', {}, children),
          EmptyState: ({ title }: any) => React.createElement('h2', {}, title),
        };
      if (name === './protection-results')
        return {
          formatRunTime: () => '',
          getRunOutcome: () => ({ label: 'Not checked', tone: 'muted' }),
          History: () => null,
          InstallationResult: () => null,
          PolicyResult: () => null,
          ScenariosResult: () => null,
        };
      if (name === './protection-queue')
        return { ProtectionQueue: () => React.createElement('h2', {}, 'Current attention') };
      if (name === './posture-strip') return { PostureStrip: () => null };
      if (name === './protection-verdict') return { ProtectionVerdict: () => null };
      if (name === './live-proof') return { LiveProofDialog: () => null };
      if (name === './protection-check-report') return { ProtectionCheckReport: () => null };
      const modules: Record<string, unknown> = {
        '@/lib/control': control,
        '@/lib/protection-check': checks,
        '@/lib/protection-check-navigation': navigation,
        '@/lib/mcp-governance-navigation': governanceNavigation,
      };
      if (modules[name]) return modules[name];
      throw Error(name);
    },
  });
  const html = renderToStaticMarkup(React.createElement(exports.ProtectionPage));
  return { html, calls, elements, effects, state };
}
describe('actual Protection page entry action', () => {
  it('re-reads on page entry without treating navigation as explicit uncertain-action confirmation', () => {
    const page = harness('', (state) => {
      state.needsRecheck = true;
      state.busy = true;
    });
    for (const effect of page.effects) effect();
    expect(page.calls).toEqual([{ read: false }]);
  });
  it('labels a retained unowned leaf as unverified without pretending a live worker stopped or is running', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const page = harness(`workspace=${workspaceId}&run=${id}`, (state) => {
      state.runs = [
        {
          id,
          kind: 'doctor',
          status: 'running',
          startedAt: '2026-10-24T10:00:00.000Z',
          provenance: state.control.context,
        },
      ];
      state.control.activeRunId = null;
      state.control.runs = state.runs;
    });
    expect(page.html).toContain('State unverified');
    expect(page.html).toContain('Unfinished recorded attempt · active owner unverified.');
    expect(page.html).not.toContain('Check installation in progress');
    expect(page.html).not.toContain('Installation check running');
    expect(page.html).not.toContain('process stopped');
  });
  it('starts the fixed parent only after pressing the main action', async () => {
    const page = harness();
    expect(page.calls).toEqual([]);
    const primary = page.elements.find(
      (e) =>
        e.type === 'button' &&
        e.props.className === 'button primary' &&
        e.props.children?.includes?.('Run protection check'),
    );
    expect(primary).toBeTruthy();
    await primary.props.onClick();
    expect(page.calls).toEqual([{ kind: 'protection-check' }]);
  });
  it('disables new checks for unavailable history without describing an available engine as unavailable', () => {
    const page = harness('', (state) => {
      state.control.history = { status: 'error', error: 'invalid-history' };
    });
    expect(page.html).toContain(
      'Saved check history is unavailable. Check local storage, then restart the server.',
    );
    expect(page.html).not.toContain('Current results remain available');
    expect(page.html).toContain('Available');
    expect(page.html).not.toContain('Build the local Stroq engine');
    const primary = page.elements.find(
      (e) =>
        e.type === 'button' &&
        e.props.className === 'button primary' &&
        e.props.children?.includes?.('Run protection check'),
    );
    expect(primary.props.disabled).toBe(true);
  });
  it('shows an unavailable exact selection without silently substituting another report', () => {
    const page = harness(`workspace=${workspaceId}&run=11111111-1111-4111-8111-111111111111`);
    expect(page.html).toContain('Selected check unavailable');
    expect(page.calls).toEqual([]);
    expect(harness('run=private').html).toContain('Invalid check link');
  });
  it('offers explicit MCP blocking navigation and places the queue before historical checks', () => {
    const page = harness('', (state) => {
      state.runs = [
        {
          id: '11111111-1111-4111-8111-111111111111',
          kind: 'protection-check',
          status: 'completed',
          startedAt: '2026-10-24T10:00:00.000Z',
          finishedAt: '2026-10-24T10:01:00.000Z',
          provenance: state.control.context,
        },
      ];
    });
    expect(page.html).toContain('Block MCP calls');
    expect(page.html).toContain('governanceDraft=deny-all');
    expect(page.html.indexOf('Current attention')).toBeLessThan(
      page.html.indexOf('Recorded protection check'),
    );
    expect(page.html).not.toContain('class="control-check-details" open=""');
    expect(page.calls).toEqual([]);
  });
  it('keeps an exact selected protection report expanded below the queue', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const page = harness(`workspace=${workspaceId}&run=${id}`, (state) => {
      state.runs = [
        {
          id,
          kind: 'protection-check',
          status: 'completed',
          startedAt: '2026-10-24T10:00:00.000Z',
          provenance: state.control.context,
        },
      ];
    });
    expect(page.html).toContain('class="control-check-details" open=""');
    expect(page.html.indexOf('Current attention')).toBeLessThan(
      page.html.indexOf('Recorded protection check'),
    );
  });
});
