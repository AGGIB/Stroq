'use client';

import { Activity, Bot, KeyRound, LayoutGrid, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { AGENTS, KEYS } from '@/lib/data';
import { cn } from '@/lib/utils';
import { ThemeToggle } from './theme-toggle';

const keysNeedingYou = KEYS.filter((k) => k.needsYou).length;
const agentsNotTested = AGENTS.filter((a) => a.state === 'unver').length;

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutGrid },
  { href: '/activity/', label: 'Activity', icon: Activity },
  {
    href: '/keys/',
    label: 'Keys',
    icon: KeyRound,
    badge: keysNeedingYou,
    badgeLabel: 'keys need you',
    tone: 'red',
  },
  {
    href: '/agents/',
    label: 'Agents',
    icon: Bot,
    badge: agentsNotTested,
    badgeLabel: 'agent not tested',
    tone: 'amber',
  },
] as const;

function isCurrent(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href.replace(/\/$/, ''));
}

export function BrandMark({ className }: { readonly className?: string }) {
  return (
    <span
      className={cn(
        'grid size-[22px] place-items-center rounded-[5px] bg-primary text-primary-foreground',
        className,
      )}
    >
      <svg viewBox="0 0 16 16" className="size-[13px]" aria-hidden="true">
        <path
          d="M3 11.5c1.4 1 3 1.5 5 1.5 2.6 0 4-1.1 4-2.8 0-3.9-8-2.2-8-6C4 2.6 5.5 1.5 8 1.5c1.6 0 3 .4 4 1.1"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar aria-label="Stroq">
      <SidebarHeader className="px-3 pt-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-sm px-1"
          onClick={() => setOpenMobile(false)}
        >
          <BrandMark />
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
            Stroq
          </span>
        </Link>
        <p className="pl-[42px] text-xs text-ink-3">This Mac · local only</p>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <nav aria-label="Sections">
            <SidebarMenu>
              {NAV.map((item) => {
                const current = isCurrent(pathname, item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={current}
                      className="h-8 font-medium text-ink-2 data-[active=true]:font-medium"
                    >
                      <Link
                        href={item.href}
                        aria-current={current ? 'page' : undefined}
                        onClick={() => setOpenMobile(false)}
                      >
                        <item.icon aria-hidden="true" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {'badge' in item && item.badge > 0 ? (
                      <SidebarMenuBadge
                        className={cn(
                          'rounded-full px-1.5 text-xs font-semibold',
                          item.tone === 'red'
                            ? 'bg-st-red text-st-on peer-hover/menu-button:text-st-on peer-data-[active=true]/menu-button:text-st-on'
                            : 'bg-st-amber/20 text-st-amber-ink peer-hover/menu-button:text-st-amber-ink peer-data-[active=true]/menu-button:text-st-amber-ink',
                        )}
                      >
                        {item.badge}
                        <span className="sr-only"> {item.badgeLabel}</span>
                      </SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-2.5 border-t border-sidebar-border px-4 pb-3 pt-3 text-xs text-ink-3">
        <p className="flex items-center gap-2">
          <ShieldCheck aria-hidden="true" className="size-3.5" />
          <span>
            <b className="font-medium text-ink-2">Log not altered</b> · 2 min ago
          </span>
        </p>
        <p>Read-only · v0.29.0</p>
        <ThemeToggle />
      </SidebarFooter>
    </Sidebar>
  );
}

/** Phones only: the sidebar opens as a sheet from this bar. */
export function MobileBar() {
  return (
    <div className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-border bg-background px-2 md:hidden">
      <SidebarTrigger aria-label="Open navigation" className="size-9" />
      <BrandMark />
      <span className="text-[15px] font-semibold">Stroq</span>
    </div>
  );
}
