import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as schema from './control';

const running = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'content-scan',
  status: 'running',
  startedAt: '2026-10-24T10:00:00.000Z',
};
function render(configure: (state: any) => void) {
  const calls: unknown[] = [],
    elements: any[] = [],
    exports: any = {};
  const state: any = {
    ready: true,
    loading: false,
    error: null,
    control: {
      engine: { available: true, version: '0.28.0' },
      activeRunId: null,
      history: { status: 'ready' },
    },
    runs: [],
    busy: false,
    start: async (input: unknown) => {
      calls.push(input);
      return null;
    },
    refresh: async () => {},
  };
  configure(state);
  let slot = 0;
  const code = ts.transpileModule(
    readFileSync(resolve(process.cwd(), 'components/platform/skills.tsx'), 'utf8'),
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
        return {
          ...React,
          useState: (value: any) => [slot++ === 0 ? 'Review this file.' : value, () => {}],
          useRef: (value: any) => ({ current: value }),
          useEffect: () => {},
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
      if (name === 'next/link')
        return {
          default: ({ children, ...props }: any) => React.createElement('a', props, children),
        };
      if (name === 'lucide-react')
        return new Proxy({}, { get: () => (props: any) => React.createElement('svg', props) });
      if (name === '@/components/control-provider') return { useControl: () => state };
      if (name === './inventory') return { SkillsTabs: () => null };
      if (name === '@/components/platform-ui')
        return {
          PageHeading: ({ title, actions }: any) =>
            React.createElement('header', {}, title, actions),
          Panel: ({ children, title, actions }: any) =>
            React.createElement('section', {}, title, actions, children),
          Badge: ({ children }: any) => React.createElement('span', {}, children),
          ExportButton: () => null,
        };
      if (name === '@/lib/control') return schema;
      throw Error(name);
    },
  });
  const html = renderToStaticMarkup(React.createElement(exports.SkillsPage));
  const scanButton = elements.find(
    (element) => element.type === 'button' && element.props.className === 'button primary',
  );
  return { html, calls, scanButton };
}
describe('actual Skill review ownership and saved history', () => {
  it('labels an unowned recorded scan as unverified and allows only an explicit new scan', async () => {
    const page = render((state) => {
      state.runs = [running];
    });
    expect(page.html).toContain('State unverified');
    expect(page.html).toContain('Unfinished recorded attempt · active owner unverified.');
    expect(page.html).not.toContain('Scanning');
    expect(page.html).not.toContain('aria-busy="true"');
    expect(page.html).not.toContain('class="spin"');
    expect(page.scanButton.props.disabled).toBe(false);
    expect(page.calls).toEqual([]);
    await page.scanButton.props.onClick();
    expect(page.calls).toEqual([
      { kind: 'content-scan', content: 'Review this file.', target: 'skill' },
    ]);
  });
  it('keeps the running presentation for a locally owned scan and legacy missing-field server', () => {
    for (const legacy of [false, true]) {
      const page = render((state) => {
        state.runs = [running];
        state.busy = true;
        state.control.activeRunId = running.id;
        if (legacy) delete state.control.activeRunId;
      });
      expect(page.html).toContain('Scanning content');
      expect(page.html).toContain('aria-busy="true"');
      expect(page.html).toContain('class="spin"');
      expect(page.html).not.toContain('State unverified');
      expect(page.scanButton.props.disabled).toBe(true);
    }
  });
  it('shows unavailable saved history and disables submission without a scanning spinner', () => {
    const page = render((state) => {
      state.busy = true;
      state.control.history = { status: 'error', error: 'write-failed' };
    });
    expect(page.html).toContain(
      'Saved check history is unavailable. Check local storage, then restart the server.',
    );
    expect(page.html).not.toContain('class="spin"');
    expect(page.html).not.toContain('aria-busy="true"');
    expect(page.scanButton.props.disabled).toBe(true);
    expect(page.calls).toEqual([]);
  });
});
