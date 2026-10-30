import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolCall } from './data';
import * as navigation from './activity-navigation';
import * as platform from './platform';

const sha = 'a'.repeat(64);
const call = (changes: Partial<ToolCall> = {}): ToolCall => ({
  id: 'audit-17',
  evidenceSha: sha,
  decision: 'block',
  label: 'Policy denied a tool call',
  raw: 'Command and content withheld',
  agent: 'Unknown host',
  date: '2026-10-26',
  time: '09:00:00',
  reason: 'Recorded policy denial; host enforcement was not checked.',
  ...changes,
});

function page({
  source = 'local',
  row = call(),
  query = `id=audit-17&evidence=${sha}`,
  table = false,
}: {
  source?: 'local' | 'demo';
  row?: ToolCall;
  query?: string;
  table?: boolean;
} = {}) {
  const output: any = {},
    elements: any[] = [],
    effects: (() => void)[] = [],
    storage: any[] = [],
    links: string[] = [],
    downloads: any[] = [],
    states: any[] = [];
  let cursor = 0;
  const wrapper =
    (tag: string) =>
    ({ children, ...props }: any) =>
      React.createElement(
        tag,
        Object.fromEntries(
          Object.entries(props).filter(
            ([key, value]) => !key.startsWith('on') && typeof value !== 'function',
          ),
        ),
        children,
      );
  const ExportButton = ({ data, label = 'Export' }: any) => {
    downloads.push(typeof data === 'function' ? data() : data);
    return React.createElement('button', {}, label);
  };
  const code = ts.transpileModule(
    readFileSync(
      resolve(process.cwd(), `components/${table ? 'platform-overview' : 'platform-activity'}.tsx`),
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
    exports: output,
    URLSearchParams,
    localStorage: {
      getItem: (key: string) => {
        storage.push(['get', key]);
        return 'yes';
      },
      setItem: (key: string, value: string) => storage.push(['set', key, value]),
    },
    require(name: string) {
      if (name === 'react')
        return {
          ...React,
          useState: (initial: any) => {
            const index = cursor++;
            if (!(index in states)) states[index] = initial;
            return [
              states[index],
              (value: any) => {
                states[index] = value;
              },
            ];
          },
          useEffect: (effect: () => void) => effects.push(effect),
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
      if (name === 'next/link')
        return {
          default: ({ href, children, ...props }: any) => {
            links.push(href);
            return React.createElement('a', { ...props, href }, children);
          },
        };
      if (name === 'next/navigation') return { useSearchParams: () => new URLSearchParams(query) };
      if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
      if (name === './platform-provider')
        return {
          usePlatform: () => ({
            calls: [row],
            source,
            generatedAt: '2026-10-26T09:00:00.000Z',
            loading: false,
          }),
        };
      if (name === './platform-ui')
        return {
          Badge: wrapper('span'),
          AgentGlyph: () => null,
          Command: ({ command }: any) => React.createElement('code', {}, command),
          Panel: ({ title, children, actions }: any) =>
            React.createElement('section', {}, title, actions, children),
          EmptyState: ({ title, description }: any) =>
            React.createElement('section', {}, title, description),
          ExportButton,
        };
      if (name === './platform-overview') return { EventTable: () => null };
      if (name === '@/lib/platform') return platform;
      if (name === '@/lib/activity-navigation') return navigation;
      throw Error(name);
    },
  });
  const render = () => {
    cursor = 0;
    elements.length = links.length = downloads.length = effects.length = 0;
    return renderToStaticMarkup(
      React.createElement(
        table ? output.EventTable : output.InvestigationPage,
        table ? { calls: [row] } : {},
      ),
    );
  };
  let html = render();
  for (const effect of [...effects]) effect();
  html = render();
  return { html, links, downloads, elements, storage };
}

describe('Activity joins the authoritative investigation', () => {
  it('opens the exact local finding and neither reads nor exports legacy browser review', () => {
    const value = page();
    expect(value.links).toContain(`/incidents/?status=all&id=incident-${sha}`);
    expect(value.html).not.toContain('Your review');
    expect(value.html).not.toContain('Mark as reviewed');
    expect(value.storage).toEqual([]);
    expect(value.downloads).toHaveLength(1);
    expect(value.downloads[0]).not.toHaveProperty('reviewed');
    expect(value.downloads[0].binding).toBe('exact');
  });

  it('puts the one primary investigation action in the heading and omits a speculative local trace', () => {
    const value = page();
    const headingActions = value.elements.find(
      (item) => item.type === 'div' && item.props.className === 'event-actions',
    );
    const primary = headingActions.props.children.find(
      (item: any) => item?.props?.href === `/incidents/?status=all&id=incident-${sha}`,
    );
    expect(primary).toBeDefined();
    expect(primary.props.className).toContain('primary');
    expect(
      value.links.filter((href) => href === `/incidents/?status=all&id=incident-${sha}`),
    ).toHaveLength(1);
    expect(value.html.indexOf('Open investigation')).toBeLessThan(value.html.indexOf('<section'));
    expect(value.html).not.toContain('Event trace');
    expect(value.html).not.toContain('Next steps');
    expect(value.html).not.toContain('Source unavailable');
    expect(value.html).not.toContain('01 · SOURCE');
    expect(value.html).toContain('Decision reason');
    expect(value.html).toContain('Recorded policy denial; host enforcement was not checked.');
    expect(value.html).toContain('Command and content withheld');
    expect(value.html).toContain('Local journal');
  });

  it('preserves browser-only demo review without offering a local finding', () => {
    const value = page({
      source: 'demo',
      row: call({ id: '18204', evidenceSha: undefined }),
      query: 'id=18204',
    });
    expect(value.html).toContain('Reviewed · undo');
    expect(value.html).toContain('Event trace');
    expect(value.html).toContain('01 · SOURCE');
    expect(value.html).toContain('Untrusted README');
    expect(value.html).toContain('Next steps');
    expect(value.storage).toContainEqual(['get', 'stroq-reviewed-v1:demo:18204']);
    expect(value.downloads[0].reviewed).toBe(true);
    expect(value.links.some((href) => href.startsWith('/incidents/'))).toBe(false);
    const button = value.elements.find(
      (item) =>
        item.type === 'button' &&
        Array.isArray(item.props.children) &&
        item.props.children.includes('Reviewed · undo'),
    );
    expect(button).toBeDefined();
    button.props.onClick();
    expect(value.storage).toContainEqual(['set', 'stroq-reviewed-v1:demo:18204', 'no']);
  });

  it('labels old sequence-only links as current-window evidence and does not adopt browser review', () => {
    const value = page({ query: 'id=audit-17' });
    expect(value.html).toContain('Legacy link · current journal window');
    expect(value.downloads[0].binding).toBe('current-window');
    expect(value.storage).toEqual([]);
  });

  it('refuses a changed or malformed digest before rendering another event or export', () => {
    for (const evidence of ['b'.repeat(64), 'bad', '']) {
      const value = page({ query: `id=audit-17&evidence=${evidence}` });
      expect(value.html).not.toContain('Policy denied a tool call');
      expect(value.downloads).toEqual([]);
      expect(value.links.some((href) => href.startsWith('/incidents/'))).toBe(false);
      expect(value.storage).toEqual([]);
    }
  });

  it('keeps old snapshots usable without manufacturing an exact finding', () => {
    const value = page({ row: call({ evidenceSha: undefined }), query: 'id=audit-17' });
    expect(value.html).toContain('Exact finding link unavailable');
    expect(value.links).not.toContain(`/incidents/?status=all&id=incident-${sha}`);
    expect(value.downloads[0]).not.toHaveProperty('reviewed');
  });

  it('does not turn a policy allow into an incident', () => {
    const value = page({ row: call({ decision: 'allow', label: 'Policy allowed a tool call' }) });
    expect(value.links.some((href) => href.startsWith('/incidents/'))).toBe(false);
    expect(value.storage).toEqual([]);
  });

  it('uses digest-bound links in both actual EventTable entry points', () => {
    const value = page({ table: true });
    expect(value.links.filter((href) => href.startsWith('/activity/event/'))).toEqual([
      `/activity/event/?id=audit-17&evidence=${sha}`,
      `/activity/event/?id=audit-17&evidence=${sha}`,
    ]);
  });
});
