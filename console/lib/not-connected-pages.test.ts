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
import { PlatformShell } from '@/components/platform-shell';
import { SessionsPage } from '@/components/platform/sessions';
import { SettingsPage } from '@/components/platform/settings';
import { NOT_CONNECTED, type Snapshot } from '@/lib/connection';

const NOT_CONNECTED_TEXT =
  'Not connected to Stroq on this machine. Run npx @stroq/cli console to open this page with your data.';

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

beforeEach(() => {
  seen.search = '';
  seen.path = '/activity/';
  seen.platform = platform(NOT_CONNECTED);
});

describe('the default state', () => {
  it('holds no calls, agents or keys', () => {
    expect(NOT_CONNECTED).toMatchObject({ source: 'none', calls: [], agents: [], keys: [] });
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
    expect(out).not.toMatch(/collector\.example|acme|demo-|Example|Untrusted README/);
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

describe('the shell', () => {
  it('says plainly when nothing is connected and offers no example or guide', () => {
    for (const path of ['/', '/live/', '/agents/', '/policies/', '/skills/']) {
      seen.path = path;
      seen.platform = platform(NOT_CONNECTED);
      const out = render(PlatformShell, { children: 'page' });
      expect(out, path).toContain('Not connected');
      expect(out, path).not.toMatch(/Example|Guide/);
    }
  });

  it('words a connected machine as local', () => {
    seen.path = '/';
    seen.platform = platform(LOCAL);
    const out = render(PlatformShell, { children: 'page' });
    expect(out).toContain('Local engine');
    expect(out).not.toMatch(/Example|Guide/);
  });

  it('lists exactly five screens in its menu and has no Settings link', () => {
    seen.path = '/';
    seen.platform = platform(LOCAL);
    render(PlatformShell, { children: 'page' });
    const nav = seen.elements.find(
      (e) => e.type === 'nav' && e.props['aria-label'] === 'Main navigation',
    );
    expect(nav).toBeDefined();
    const links = seen.elements.filter(
      (e) => typeof e.props?.className === 'string' && e.props.className.startsWith('nav-item'),
    );
    expect(links.map((e) => e.props.href)).toEqual([
      '/',
      '/live/',
      '/agents/',
      '/policies/',
      '/skills/',
    ]);
    expect(seen.elements.some((e) => e.props?.href === '/settings/')).toBe(false);
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
