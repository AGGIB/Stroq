import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import cliPackage from '../../packages/cli/package.json';

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

import { PlatformShell } from '@/components/platform-shell';
import { NOT_CONNECTED, type Snapshot } from '@/lib/connection';

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

/** What the markup says: everything outside `<…>`, white space folded. Read by hand, not with a pattern. */
function text(html: string): string {
  let out = '';
  let inTag = false;
  for (const c of html) {
    if (c === '<') inTag = true;
    else if (c === '>') inTag = false;
    else if (!inTag) out += c;
  }
  return out.replace(/\s+/g, ' ');
}
function render(component: ComponentType<any>, props: object = {}) {
  seen.elements.length = 0;
  return text(renderToStaticMarkup(createElement(component, props)));
}

beforeEach(() => {
  seen.search = '';
  seen.path = '/';
  seen.platform = platform(NOT_CONNECTED);
});

describe('the default state', () => {
  it('holds no calls, agents or keys', () => {
    expect(NOT_CONNECTED).toMatchObject({ source: 'none', calls: [], agents: [], keys: [] });
  });
});

describe('the shell', () => {
  it('shows the CLI package version in the sidebar', () => {
    const html = renderToStaticMarkup(createElement(PlatformShell, { children: 'page' }));
    expect(html).toContain(`<span class="version">v${cliPackage.version}</span>`);
  });

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

  it('holds the menu of the desktop panel in a sticky column that scrolls by itself', () => {
    seen.path = '/';
    seen.platform = platform(LOCAL);
    render(PlatformShell, { children: 'page' });
    const panel = seen.elements.find((e) => e.props?.className === 'desktop-sidebar');
    expect(panel).toBeDefined();
    const inner = [panel?.props.children].flat()[0];
    expect(inner.props.className).toBe('sidebar-sticky');
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

  it('marks the screen that is open, and only that one', () => {
    seen.path = '/policies/checks/';
    seen.platform = platform(LOCAL);
    render(PlatformShell, { children: 'page' });
    const current = seen.elements
      .filter((e) => e.props?.['aria-current'] === 'page')
      .map((e) => e.props.href);
    expect(current).toEqual(['/policies/']);
  });

  it('searches events by their address on Live', () => {
    seen.platform = platform(LOCAL);
    const out = render(PlatformShell, { children: 'page' });
    expect(out).toContain('Search');
  });
});
