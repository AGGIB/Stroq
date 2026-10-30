import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Blind, KeyFinding, NextStep, Todo, ToolCall } from '@/lib/data';
import { cn } from '@/lib/utils';
import { CopyCommand } from './copy-command';
import { MoreLink } from './section';
import { StatusSquare } from './status-square';

// Rows sit on hairlines. Each has a square on the left, two lines of text, and at most one next step.

const ROW = 'relative grid min-h-14 items-center gap-4 border-b border-border px-2.5 py-2.5';

export function RowList({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <ul className={cn('border-t border-border', className)}>{children}</ul>;
}

function Lines({
  title,
  sub,
  mono = false,
  wrap = false,
}: {
  readonly title: ReactNode;
  readonly sub: ReactNode;
  readonly mono?: boolean;
  readonly wrap?: boolean;
}) {
  return (
    <span className="min-w-0">
      <span className={cn('block truncate font-semibold', mono && 'font-mono text-[13px]')}>
        {title}
      </span>
      <span
        className={cn(
          'mt-px block text-[13px] leading-[18px] text-ink-3',
          wrap ? 'text-pretty' : 'truncate',
        )}
      >
        {sub}
      </span>
    </span>
  );
}

export function NextStepView({ step }: { readonly step: NextStep | undefined }) {
  if (step === undefined) return null;
  if (step.kind === 'command') return <CopyCommand command={step.command} />;
  if (step.kind === 'link') return <MoreLink href={step.href}>{step.label}</MoreLink>;
  return (
    <span
      className={cn(
        'text-[13px] leading-[18px]',
        step.quiet === true ? 'text-ink-2' : 'text-foreground',
      )}
    >
      {step.text}
    </span>
  );
}

export function ActionRow({ call }: { readonly call: ToolCall }) {
  return (
    <li
      className={cn(
        ROW,
        'grid-cols-[20px_minmax(0,1fr)_auto] transition-colors duration-150 hover:bg-accent md:grid-cols-[20px_minmax(0,1fr)_110px_52px]',
        'has-[a:focus-visible]:bg-accent has-[a:focus-visible]:shadow-[inset_2px_0_0_var(--foreground)]',
      )}
    >
      <StatusSquare kind={call.decision} />
      <span className="min-w-0">
        <Link
          href={`/activity/event/?id=${encodeURIComponent(call.id)}`}
          className="block truncate font-semibold outline-hidden after:absolute after:inset-0"
        >
          {call.label}
        </Link>
        <code className="mt-px block truncate text-xs text-ink-3">{call.raw}</code>
      </span>
      <span className="hidden whitespace-nowrap text-[13px] text-ink-2 md:block">{call.agent}</span>
      <span className="whitespace-nowrap text-right text-[13px] tabular-nums text-ink-3">
        {call.time}
      </span>
    </li>
  );
}

export function TodoRow({ todo }: { readonly todo: Todo }) {
  const why = (
    <>
      {todo.whyCode === undefined ? null : (
        <>
          <code className="text-xs text-ink-2">{todo.whyCode}</code>{' '}
        </>
      )}
      {todo.why}
    </>
  );
  return (
    <li
      className={cn(ROW, 'grid-cols-[20px_minmax(0,1fr)] md:grid-cols-[20px_minmax(0,1fr)_290px]')}
    >
      <StatusSquare kind={todo.status} />
      <Lines title={todo.title} sub={why} />
      <span className="col-start-2 flex min-w-0 md:col-start-3 md:justify-end">
        <NextStepView step={todo.next} />
      </span>
    </li>
  );
}

function Arrow({ className }: { readonly className?: string }) {
  return (
    <ArrowRight
      aria-hidden="true"
      className={cn('size-3.5 justify-self-center text-ink-3', className)}
    />
  );
}

export function KeyRow({ finding }: { readonly finding: KeyFinding }) {
  return (
    <li
      id={finding.id}
      className={cn(
        ROW,
        'scroll-mt-6 gap-3 grid-cols-[20px_minmax(0,1fr)_14px_minmax(0,1fr)]',
        'lg:grid-cols-[20px_minmax(0,1.1fr)_14px_minmax(0,.75fr)_14px_minmax(0,1fr)_290px]',
        'target:bg-accent',
      )}
    >
      <StatusSquare kind={finding.outcome} />
      <Lines title={finding.name} sub={finding.source} mono />
      <Arrow />
      <Lines title={finding.agent} sub={finding.when} />
      <Arrow className="hidden lg:block" />
      <span className="col-start-2 col-end-[-1] lg:col-auto">
        <Lines title={finding.destination} sub={finding.outcomeText} wrap />
      </span>
      {finding.next === undefined ? null : (
        <span className="col-start-2 col-end-[-1] flex min-w-0 lg:col-auto">
          <NextStepView step={finding.next} />
        </span>
      )}
    </li>
  );
}

export function BlindRow({ blind }: { readonly blind: Blind }) {
  const title = (
    <>
      {blind.code === undefined ? null : (
        <>
          <code className="text-[13px]">{blind.code}</code>{' '}
        </>
      )}
      {blind.title}
    </>
  );
  return (
    <li className={cn(ROW, 'grid-cols-[20px_minmax(0,1fr)]')}>
      <StatusSquare kind="unread" />
      <Lines title={title} sub={blind.reason} />
    </li>
  );
}
