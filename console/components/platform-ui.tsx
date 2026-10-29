'use client';
import type { ReactNode } from 'react';
import { ArrowDownToLine, SearchX } from 'lucide-react';
import { AgentBrand } from './agent-brand';
import { CopyCommand } from './copy-command';
import { downloadJson } from '@/lib/platform';
export function Badge({
  tone = 'muted',
  children,
}: {
  tone?: 'green' | 'orange' | 'red' | 'muted';
  children: ReactNode;
}) {
  return (
    <span className={`badge ${tone}`}>
      <span className="badge-dot" />
      {children}
    </span>
  );
}
export function AgentGlyph({ name }: { name: string }) {
  return (
    <span className={`agent-glyph ${name === 'Claude Code' ? 'claude' : ''}`}>
      <AgentBrand name={name} />
    </span>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="heading-actions">{actions}</div> : null}
    </div>
  );
}
export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title ? (
        <div className="panel-heading">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}
export function Command({ command }: { command: string }) {
  return <CopyCommand command={command} className="command-block" />;
}
export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty-state">
      <SearchX size={30} aria-hidden="true" />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
export function ExportButton({
  data,
  filename = 'stroq-report.json',
  label = 'Export',
}: {
  data: unknown;
  filename?: string;
  label?: string;
}) {
  return (
    <button
      className="button"
      onClick={() => downloadJson(typeof data === 'function' ? data() : data, filename)}
    >
      <ArrowDownToLine size={15} aria-hidden="true" />
      {label}
    </button>
  );
}
