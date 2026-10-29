'use client';
import {
  Activity,
  ArrowDownLeft,
  BookOpen,
  ArrowUpRight,
  ChevronRight,
  Command as CommandIcon,
  Cpu,
  FileClock,
  FileCode2,
  KeyRound,
  LayoutDashboard,
  Menu,
  Monitor,
  Moon,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  FlaskConical,
  ListChecks,
  Radio,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import { Dialog } from 'radix-ui';
import { useEffect, useState, type ReactNode } from 'react';
import { usePlatform } from './platform-provider';
import { BrandMark } from './brand-mark';
import { PLATFORM_PAGES, PLATFORM_SECTIONS } from '@/lib/platform-map';
const ICONS: Readonly<Record<string, LucideIcon>> = {
  '/': ShieldCheck,
  '/live/': Radio,
  '/activity/': Activity,
  '/agents/': Cpu,
  '/posture/': ListChecks,
  '/policies/': SlidersHorizontal,
  '/try/': FlaskConical,
  '/skills/': FileCode2,
  '/incidents/': ShieldAlert,
  '/sessions/': FileClock,
  '/keys/': KeyRound,
  '/overview/': LayoutDashboard,
};
/** The sidebar, grouped by what a page is for (`lib/platform-map.ts`). */
const NAV = PLATFORM_PAGES.map((page) => ({
  href: page.href,
  label: page.label,
  section: page.section,
  icon: ICONS[page.href] ?? ShieldCheck,
}));
const SEARCHABLE = [...NAV, { href: '/guide/', label: 'Guide', section: null, icon: BookOpen }];
export function Logo() {
  return (
    <Link href="/" className="brand" aria-label="Stroq protection">
      <BrandMark />
    </Link>
  );
}
function Navigation({ close }: { close?: () => void }) {
  const path = usePathname(),
    { localContext } = usePlatform();
  return (
    <>
      <Logo />
      <Link href="/settings/" className="workspace-switch" onClick={close}>
        <span className="workspace-icon">
          <Monitor size={16} aria-hidden="true" />
        </span>
        <strong>{localContext?.workspace.label ?? 'Local workspace'}</strong>
        <ChevronRight size={13} aria-hidden="true" />
      </Link>
      <nav aria-label="Main navigation" className="primary-nav">
        {PLATFORM_SECTIONS.map((section) => {
          const isCurrent = (href: string) =>
            href === '/'
              ? path === '/' || path.startsWith('/protection')
              : path.startsWith(href.slice(0, -1));
          const items = NAV.filter((n) => n.section === section.id);
          const links = items.map((n) => {
            const current = isCurrent(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`nav-item ${current ? 'active' : ''}`}
                aria-current={current ? 'page' : undefined}
                onClick={close}
              >
                <n.icon size={17} strokeWidth={1.6} aria-hidden="true" />
                <span>{n.label}</span>
              </Link>
            );
          });
          // The pages used only now and then fold away until one of them is open.
          return section.id === 'review' ? (
            <details
              key={section.id}
              className="nav-group nav-more"
              open={items.some((n) => isCurrent(n.href)) || undefined}
            >
              <summary className="nav-section">
                <ChevronRight size={14} aria-hidden="true" />
                {section.label}
              </summary>
              {links}
            </details>
          ) : (
            <div key={section.id} className="nav-group" role="group" aria-label={section.label}>
              <p className="nav-section">{section.label}</p>
              {links}
            </div>
          );
        })}
      </nav>
      <div className="sidebar-bottom">
        <Link
          className={`nav-item ${path.startsWith('/guide') ? 'active' : ''}`}
          href="/guide/"
          aria-current={path.startsWith('/guide') ? 'page' : undefined}
          onClick={close}
        >
          <BookOpen size={17} aria-hidden="true" />
          <span>Guide</span>
        </Link>
        <Link
          className={`nav-item ${path === '/settings/' ? 'active' : ''}`}
          href="/settings/"
          onClick={close}
        >
          <Settings2 size={17} aria-hidden="true" />
          <span>Settings</span>
        </Link>
        <div className="sidebar-user">
          <Monitor size={14} aria-hidden="true" />
          <span>On this machine</span>
          <span className="version">v0.29.0</span>
        </div>
      </div>
    </>
  );
}
export function PlatformShell({ children }: { children: ReactNode }) {
  const [searchOpen, setSearchOpen] = useState(false),
    [mobile, setMobile] = useState(false),
    [query, setQuery] = useState('');
  const { source, calls } = usePlatform(),
    { resolvedTheme, setTheme } = useTheme();
  const path = usePathname();
  const localOperation =
    path === '/' ||
    path.startsWith('/protection') ||
    path.startsWith('/skills') ||
    path.startsWith('/agents') ||
    path.startsWith('/incidents') ||
    path.startsWith('/keys') ||
    path.startsWith('/try') ||
    path.startsWith('/live') ||
    (path.startsWith('/policies') && !path.includes('/reference'));
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
  const found = calls
    .filter(
      (c) =>
        query.trim().length > 0 &&
        `${c.label} ${c.raw} ${c.agent} ${c.rule ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .slice(0, 5);
  return (
    <div className="platform-shell">
      <aside className="desktop-sidebar">
        <Navigation />
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <Dialog.Root open={mobile} onOpenChange={setMobile}>
            <Dialog.Trigger asChild>
              <button className="icon-button mobile-menu" aria-label="Open navigation">
                <Menu size={19} />
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="mobile-sidebar">
                <Dialog.Title className="sr-only">Navigation</Dialog.Title>
                <Dialog.Description className="sr-only">
                  Navigate the security platform
                </Dialog.Description>
                <Navigation close={() => setMobile(false)} />
                <Dialog.Close className="mobile-close icon-button" aria-label="Close navigation">
                  <X size={18} />
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <div className="mobile-brand">
            <Logo />
          </div>
          <span className="platform-label">Security platform</span>
          <div className="topbar-actions">
            <button
              aria-label="Search workspace"
              className="global-search"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={14} aria-hidden="true" />
              <span>Search…</span>
              <kbd>⌘ K</kbd>
            </button>
            <Link
              href="/settings/"
              className={`source-indicator ${source}`}
              aria-label={
                localOperation
                  ? 'Local engine · connection settings'
                  : source === 'demo'
                    ? 'Demo data · connect your machine'
                    : 'Local snapshot · connection settings'
              }
            >
              <i />
              {localOperation ? 'Local engine' : source === 'demo' ? 'Demo' : 'Local'}
            </Link>
            <span className="topbar-divider" />
            <button
              className="icon-button theme-button"
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle color theme"
            >
              <Sun className="sun-icon" size={17} />
              <Moon className="moon-icon" size={17} />
            </button>
          </div>
        </header>
        <main id="content" tabIndex={-1}>
          {children}
          <footer className="workspace-footer">
            <span>
              {localOperation
                ? 'Runs on this machine'
                : source === 'demo'
                  ? 'Demo · Oct 15–21, 2026 · UTC'
                  : 'Local snapshot · UTC'}
            </span>
          </footer>
        </main>
      </div>
      <Dialog.Root
        open={searchOpen}
        onOpenChange={(o) => {
          setSearchOpen(o);
          if (!o) setQuery('');
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="command-dialog">
            <Dialog.Title className="sr-only">Search workspace</Dialog.Title>
            <Dialog.Description className="sr-only">
              Search pages and security events
            </Dialog.Description>
            <div className="command-search">
              <Search size={19} aria-hidden="true" />
              <input
                aria-label="Search workspace"
                autoComplete="off"
                spellCheck={false}
                name="workspace-search"
                placeholder="Search events, agents, or pages…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Dialog.Close className="icon-button" aria-label="Close search">
                <X size={17} />
              </Dialog.Close>
            </div>
            <div className="command-results">
              <p className="eyebrow">PAGES</p>
              {SEARCHABLE.filter((n) => n.label.toLowerCase().includes(query.toLowerCase())).map(
                (n) => (
                  <Link href={n.href} key={n.href} onClick={() => setSearchOpen(false)}>
                    <n.icon size={17} aria-hidden="true" />
                    <span>{n.label}</span>
                    <ArrowDownLeft size={14} aria-hidden="true" />
                  </Link>
                ),
              )}
              {query ? <p className="eyebrow">MATCHING EVENTS</p> : null}
              {found.map((c) => (
                <Link
                  href={`/activity/event/?id=${encodeURIComponent(c.id)}`}
                  key={c.id}
                  onClick={() => setSearchOpen(false)}
                >
                  <Activity size={17} aria-hidden="true" />
                  <span>
                    {c.label}
                    <small>
                      {c.agent} · {c.date}
                    </small>
                  </span>
                  <ArrowUpRight size={14} aria-hidden="true" />
                </Link>
              ))}
              {query && found.length === 0 ? (
                <p className="search-empty">No matching events. Try an agent name or “key”.</p>
              ) : null}
            </div>
            <div className="command-footer">
              <span>
                <CommandIcon size={12} aria-hidden="true" /> K to open
              </span>
              <span>Tab to navigate · Enter to open</span>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
