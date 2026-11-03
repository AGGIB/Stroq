import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** Records every element a render creates, so a test can reach a button's handler. */
const seen = vi.hoisted(() => ({
  elements: [] as Array<{ type: unknown; props: any }>,
  platform: null as any,
  search: '',
  path: '/activity/',
}));
vi.mock('@/components/platform-provider', () => ({ usePlatform: () => seen.platform }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(seen.search),
  usePathname: () => seen.path,
}));
vi.mock('next/link', async () => {
  const { createElement: h } = await import('react');
  return {
    default: ({ href, children, ...rest }: any) => h('a', { href, ...rest }, children),
  };
});
vi.mock('@/components/copy-command', async () => {
  const { createElement: h } = await import('react');
  return { CopyCommand: ({ command }: { command: string }) => h('code', null, command) };
});
vi.mock('react/jsx-runtime', async (importOriginal) => {
  const real = await importOriginal<typeof import('react/jsx-runtime')>();
  const record =
    (make: (...args: any[]) => unknown) =>
    (type: unknown, props: any, ...rest: unknown[]) => {
      seen.elements.push({ type, props });
      return make(type, props, ...rest);
    };
  return { ...real, jsx: record(real.jsx), jsxs: record(real.jsxs) };
});
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const real = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  return {
    ...real,
    jsxDEV: (type: unknown, props: any, ...rest: unknown[]) => {
      seen.elements.push({ type, props });
      return (real.jsxDEV as (...args: unknown[]) => unknown)(type, props, ...rest);
    },
  };
});

import { ActivityPage, InvestigationPage } from '@/components/platform-activity';
import { Overview } from '@/components/platform-overview';
import { ExampleDataBanner } from '@/components/example-data-banner';
import { PlatformShell } from '@/components/platform-shell';
import { SessionsPage } from '@/components/platform/sessions';
import { SettingsPage } from '@/components/platform/settings';
import { EXAMPLE, NOT_CONNECTED, type Snapshot } from '@/lib/connection';

const NOT_CONNECTED_TEXT =
  'Not connected to Stroq on this machine. Run npx @stroq/cli console to open this page with your data.';
const BANNER_TEXT = 'Example data, not yours';

const LOCAL: Snapshot = {
  source: 'local',
  generatedAt: '2026-10-23T09:00:00.000Z',
  calls: [
    {
      id: 'audit-1',
      decision: 'block',
      label: 'Policy denied a tool call',
      raw: 'Command and content withheld',
      agent: 'Unknown host',
      date: '2026-10-23',
      time: '09:00:00',
    },
  ],
  agents: [],
  keys: [],
  limitations: [],
};

function platform(snapshot: Snapshot, extra: Record<string, unknown> = {}) {
  return {
    ...snapshot,
    ready: true,
    loading: false,
    error: null,
    localAccess: snapshot.source === 'local',
    localContext: null,
    connectLocal: vi.fn(),
    showExample: vi.fn(),
    leaveExample: vi.fn(),
    refresh: vi.fn(),
    requestLocal: vi.fn(),
    ...extra,
  };
}

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
function render(component: ComponentType<any>, props: object = {}) {
  seen.elements.length = 0;
  return text(renderToStaticMarkup(createElement(component, props)));
}
function textOf(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}
function button(label: RegExp) {
  return seen.elements.find((e) => e.type === 'button' && label.test(textOf(e.props.children)));
}

beforeEach(() => {
  seen.search = '';
  seen.path = '/activity/';
  seen.platform = platform(NOT_CONNECTED);
});

describe('the default state', () => {
  it('holds no calls, agents or keys', () => {
    expect(NOT_CONNECTED).toMatchObject({ source: 'none', calls: [], agents: [], keys: [] });
  });

  it('keeps the example apart and marked as such', () => {
    expect(EXAMPLE.source).toBe('demo');
    expect(EXAMPLE.calls.length).toBeGreaterThan(0);
    expect(EXAMPLE.limitations.join(' ')).toMatch(/not results from your machine/i);
  });
});

describe('pages that read the snapshot, when not connected', () => {
  const pages = [
    ['Activity', ActivityPage],
    ['an event', InvestigationPage],
    ['Overview', Overview],
    ['Sessions', SessionsPage],
  ] as const;

  it.each(pages)('%s says so plainly and shows no rows', (_name, page) => {
    seen.search = 'id=18204';
    const out = render(page);
    expect(out).toContain(NOT_CONNECTED_TEXT);
    expect(out).not.toMatch(/collector\.example|acme|demo-|Example incident|Untrusted README/);
    expect(out).not.toMatch(
      /Events evaluated|Agents verified|Session groups|Security events table/,
    );
  });

  it.each(pages)(
    '%s does not claim to be disconnected while it is still connecting',
    (_name, page) => {
      seen.platform = platform(NOT_CONNECTED, { ready: false });
      expect(render(page)).not.toContain('Not connected to Stroq');
      seen.platform = platform(NOT_CONNECTED, { loading: true, localAccess: true });
      expect(render(page)).not.toContain('Not connected to Stroq');
    },
  );

  it.each(pages)('%s names the reason when a connection was refused', (_name, page) => {
    seen.platform = platform(NOT_CONNECTED, {
      localAccess: true,
      error: 'Open the private link printed by the local server to authenticate this browser.',
    });
    const out = render(page);
    expect(out).toContain(NOT_CONNECTED_TEXT);
    expect(out).toContain('authenticate this browser');
  });
});

describe('pages with real data', () => {
  it('show the real rows without any example label', () => {
    seen.platform = platform(LOCAL);
    expect(render(ActivityPage)).toContain('Policy denied a tool call');
    expect(render(SessionsPage)).toContain('Session groups');
    expect(render(Overview)).toContain('Events evaluated');
  });
});

describe('the example incident', () => {
  it('appears only while the example is on', () => {
    seen.search = 'id=18204';
    seen.platform = platform(EXAMPLE);
    const shown = render(InvestigationPage);
    expect(shown).toContain('Example incident');
    expect(shown).toContain('Illustrative chain');
    expect(shown).toContain('Untrusted README');
    expect(shown).toContain('Instructions found in the README');

    seen.platform = platform({
      ...LOCAL,
      calls: [{ ...LOCAL.calls[0]!, id: '18204' }],
    });
    const real = render(InvestigationPage);
    expect(real).not.toMatch(
      /Example incident|Illustrative chain|Untrusted README|Instructions found in the README/,
    );
    expect(real).toContain('Recorded event');

    seen.platform = platform(NOT_CONNECTED);
    expect(render(InvestigationPage)).not.toMatch(
      /Untrusted README|Illustrative chain|Instructions found in the README/,
    );
  });
});

describe('the example banner', () => {
  it('shows on every page of the shell while the example is on, and nowhere else', () => {
    for (const path of ['/', '/activity/', '/sessions/', '/overview/', '/keys/', '/settings/']) {
      seen.path = path;
      seen.platform = platform(EXAMPLE);
      expect(render(PlatformShell, { children: 'page' }), path).toContain(BANNER_TEXT);
      seen.platform = platform(NOT_CONNECTED);
      expect(render(PlatformShell, { children: 'page' }), path).not.toContain(BANNER_TEXT);
      seen.platform = platform(LOCAL);
      expect(render(PlatformShell, { children: 'page' }), path).not.toContain(BANNER_TEXT);
    }
  });

  it('says what is invented and offers one click back', () => {
    const leaveExample = vi.fn();
    seen.platform = platform(EXAMPLE, { leaveExample });
    const out = render(ExampleDataBanner);
    expect(out).toContain(BANNER_TEXT);
    expect(out).toMatch(/Activity, Sessions and Overview/);
    const back = button(/Leave the example/);
    expect(back).toBeDefined();
    back!.props.onClick();
    expect(leaveExample).toHaveBeenCalledTimes(1);
  });

  it('offers the way back to the real data when the machine is connected', () => {
    seen.platform = platform(EXAMPLE, { localAccess: true });
    render(ExampleDataBanner);
    expect(button(/Back to my data/)).toBeDefined();
  });

  it('is announced politely to assistive technology and is absent otherwise', () => {
    seen.platform = platform(EXAMPLE);
    expect(renderToStaticMarkup(createElement(ExampleDataBanner))).toMatch(/role="status"/);
    seen.platform = platform(NOT_CONNECTED);
    expect(renderToStaticMarkup(createElement(ExampleDataBanner))).toBe('');
  });
});

describe('Settings', () => {
  it('holds the theme switch and nothing else', () => {
    const out = render(SettingsPage);
    expect(out).toContain('Appearance');
    for (const label of ['Dark', 'Light', 'System']) expect(out).toContain(label);
    expect(seen.elements.filter((e) => e.type === 'button')).toHaveLength(3);
    expect(out).not.toMatch(/Example data|Local machine|Data source|threat|pwn\.watch/i);
  });
});
