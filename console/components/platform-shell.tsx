'use client';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Command as CommandIcon,
  Cpu,
  FileCode2,
  Menu,
  Monitor,
  Moon,
  Search,
  ShieldCheck,
  SlidersHorizontal,
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
import { PLATFORM_PAGES } from '@/lib/platform-map';
import { liveEventHref } from '@/lib/live-navigation';
const ICONS: Readonly<Record<string, LucideIcon>> = {
  '/': ShieldCheck,
  '/live/': Radio,
  '/agents/': Cpu,
  '/policies/': SlidersHorizontal,
  '/skills/': FileCode2,
};
/** The sidebar: the five screens of `lib/platform-map.ts`, and nothing else. */
const NAV = PLATFORM_PAGES.map((page) => ({
  href: page.href,
  label: page.label,
  icon: ICONS[page.href] ?? ShieldCheck,
}));
const SEARCHABLE = NAV;
export function Logo() {
  return (
    <Link href="/" className="brand" aria-label="Stroq check">
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
      <div className="workspace-switch" aria-label="Workspace">
        <span className="workspace-icon">
          <Monitor size={16} aria-hidden="true" />
        </span>
        <strong>{localContext?.workspace.label ?? 'Local workspace'}</strong>
      </div>
      <nav aria-label="Main navigation" className="primary-nav">
        <div className="nav-group">
          {NAV.map((n) => {
            const current = n.href === '/' ? path === '/' : path.startsWith(n.href.slice(0, -1));
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
          })}
        </div>
      </nav>
      <div className="sidebar-bottom">
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
  const { source, calls, localAccess } = usePlatform(),
    { resolvedTheme, setTheme } = useTheme();
  // What the top bar claims must match what is connected: no connection is never worded like a
  // live machine.
  const connection = source === 'local' || localAccess ? 'local' : 'none';
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
            <span
              className={`source-indicator ${connection}`}
              role="status"
              aria-label={
                connection === 'local' ? 'Connected to the local engine' : 'Not connected'
              }
            >
              <i />
              {connection === 'local' ? 'Local engine' : 'Not connected'}
            </span>
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
            <span>{connection === 'none' ? 'Not connected' : 'Runs on this machine'}</span>
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
                <Link href={liveEventHref(c)} key={c.id} onClick={() => setSearchOpen(false)}>
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
