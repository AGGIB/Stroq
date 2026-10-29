import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { dayLabel } from '@/lib/data';
import type { EventDetail, EvidenceBlock } from '@/lib/events';
import { commandLine } from '@/lib/shell';
import { CopyCommand } from './copy-command';
import { PageHeader, Section } from './section';
import { StatusSquare } from './status-square';
import { VerifyLine } from './verify-line';

function Steps({ steps }: { readonly steps: EventDetail['steps'] }) {
  return (
    <ol
      className="mt-9 grid gap-4 md:grid-cols-[repeat(var(--n),minmax(0,1fr))] md:gap-0"
      style={{ '--n': steps.length } as React.CSSProperties}
    >
      {steps.map((step, i) => (
        <li
          key={step.role}
          className="relative grid grid-cols-[32px_minmax(0,1fr)] gap-x-3.5 md:block md:pr-6
            after:absolute after:left-4 after:top-[38px] after:-bottom-3.5 after:border-l after:border-hairline-strong last:after:hidden
            md:after:left-11 md:after:right-3 md:after:top-4 md:after:bottom-auto md:after:border-l-0 md:after:border-t"
        >
          <StatusSquare kind={step.kind} size="lg" className="row-span-3" />
          <span className="block text-xs font-medium text-ink-3 md:mt-3.5">
            {i + 1} · {step.role}
          </span>
          <b className="mt-0.5 block text-base font-semibold leading-[22px]">{step.title}</b>
          <small className="mt-0.5 block text-[13px] leading-[18px] text-ink-2">
            {step.detail}
          </small>
        </li>
      ))}
    </ol>
  );
}

function Marked({ text, mark }: { readonly text: string; readonly mark: string | undefined }) {
  const at = mark === undefined ? -1 : text.indexOf(mark);
  if (mark === undefined || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="font-semibold text-st-red">{mark}</span>
      {text.slice(at + mark.length)}
    </>
  );
}

function Evidence({ block }: { readonly block: EvidenceBlock }) {
  return (
    <div>
      <h3 className="mb-1.5 mt-4 text-[13px] font-semibold text-ink-2">{block.title}</h3>
      {block.lines === undefined ? null : (
        <pre
          tabIndex={0}
          role="region"
          aria-label={block.title}
          className="mb-1.5 overflow-x-auto rounded-md bg-code px-3 py-2.5 font-mono text-xs leading-[19px] outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {block.lines.map((line, i) => (
            <span key={i} className="block">
              {line.n === undefined ? null : (
                <span className="mr-3 select-none text-ink-3">{line.n}</span>
              )}
              <Marked text={line.text} mark={line.mark} />
            </span>
          ))}
        </pre>
      )}
      {block.code === undefined && block.text === undefined ? null : (
        <p className="text-[13px] text-ink-2">
          {block.code === undefined ? null : (
            <code className="text-xs text-foreground">{block.code}</code>
          )}
          {block.code !== undefined && block.text !== undefined ? ': ' : null}
          {block.text}
        </p>
      )}
    </div>
  );
}

export function EventView({ detail }: { readonly detail: EventDetail }) {
  const { call } = detail;
  return (
    <>
      <Link
        href="/activity/"
        className="mb-4 inline-flex items-center gap-1 rounded-sm text-[13px] font-medium text-ink-2 transition-colors duration-150 hover:text-foreground"
      >
        <ChevronLeft aria-hidden="true" className="size-3.5" />
        Activity
      </Link>
      <PageHeader
        title={detail.headline}
        lede={
          <>
            <span className="text-foreground">{detail.subject}</span> · {call.agent} ·{' '}
            {dayLabel(call.date).toLowerCase()} {call.time}
          </>
        }
      />
      <Steps steps={detail.steps} />
      <div className="mt-9 grid grid-cols-[minmax(0,1fr)] items-start gap-9 md:mt-12 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-14">
        <Section id="evidence" title="Evidence" className="mt-0 md:mt-0">
          <div className="border-t border-border pt-1">
            {detail.evidence.map((block) => (
              <Evidence key={block.title} block={block} />
            ))}
          </div>
        </Section>
        <aside aria-label="Next steps and details" className="flex flex-col gap-9">
          <Section id="next" title="If you want to" className="mt-0 md:mt-0">
            <div className="border-t border-border pt-3">
              <p className="mb-1.5 text-[13px] text-ink-2">Replay the session</p>
              <CopyCommand command={commandLine('stroq', 'replay', detail.session.id)} />
              <p className="mb-1.5 mt-3 text-[13px] text-ink-2">
                Clear its flag after you checked it
              </p>
              <CopyCommand
                command={commandLine('stroq', 'untaint', '--session', detail.session.id)}
              />
            </div>
          </Section>
          <Section id="details" title="Details" className="mt-0 md:mt-0">
            <dl className="border-t border-border pt-2 text-sm">
              {[
                ['Session', detail.session.name],
                ['Project', detail.project],
                ['Log entry', call.id],
              ].map(([term, value]) => (
                <div key={term} className="grid grid-cols-[76px_minmax(0,1fr)] gap-3 py-1.5">
                  <dt className="text-[13px] text-ink-3">{term}</dt>
                  <dd className="min-w-0 break-words tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </Section>
        </aside>
      </div>
      <VerifyLine
        text="Check that nobody edited Stroq's log since this was written."
        command="stroq verify"
      />
    </>
  );
}
