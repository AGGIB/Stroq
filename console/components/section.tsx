import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  readonly title: string;
  readonly lede?: ReactNode;
  readonly aside?: ReactNode;
  readonly children?: ReactNode;
}

export function PageHeader({ title, lede, aside, children }: PageHeaderProps) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="min-w-0">
        <h1 className="text-balance text-[26px] font-bold leading-8 tracking-[-0.028em] md:text-[30px] md:leading-9">
          {title}
        </h1>
        {lede === undefined ? null : <p className="mt-1.5 text-ink-2">{lede}</p>}
        {children}
      </div>
      {aside}
    </header>
  );
}

interface SectionProps {
  readonly id: string;
  readonly title: string;
  readonly extra?: ReactNode;
  readonly link?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/** Space, a small title, then hairline rows. No boxes. */
export function Section({ id, title, extra, link, children, className }: SectionProps) {
  return (
    <section aria-labelledby={id} className={cn('mt-9 md:mt-12', className)}>
      <div className="mb-1.5 flex min-h-7 items-center gap-1.5">
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
        {extra}
        <span className="flex-1" />
        {link}
      </div>
      {children}
    </section>
  );
}

interface MoreLinkProps {
  readonly href: string;
  readonly children: ReactNode;
}

export function MoreLink({ href, children }: MoreLinkProps) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-0.5 whitespace-nowrap rounded-sm text-[13px] font-medium text-ink-2 transition-colors duration-150 hover:text-foreground"
    >
      {children}
      <ChevronRight aria-hidden="true" className="size-3.5" />
    </Link>
  );
}
