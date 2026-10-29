'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ClipboardCheck,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { usePlatform } from '@/components/platform-provider';
import { Badge, EmptyState, PageHeading, Panel } from '@/components/platform-ui';
import { ACTION_LABELS, type RecordedActionClass } from '@/lib/incident-comparison';
import { policyEventReturnHref, policySelection } from '@/lib/policy-navigation';
import { policyHistoryHref } from '@/lib/policy-history-navigation';
import { mcpGovernanceHref } from '@/lib/mcp-governance-navigation';
import type { PolicyEffect } from '@/lib/policy-control';
import { PolicyPreviewPanel } from './policy-preview';
import { usePolicySettings } from './use-policy-settings';

const ACTION_GROUPS: { label: string; classes: RecordedActionClass[] }[] = [
  {
    label: 'Credentials',
    classes: ['fs.secrets', 'fs.canary', 'secret.egress', 'secret.unscannable'],
  },
  {
    label: 'Execution',
    classes: ['shell.exec_encoded', 'shell.destructive', 'shell.unparsed', 'config.persistence'],
  },
  { label: 'Network', classes: ['shell.network', 'network.fetch', 'git.push_external'] },
  {
    label: 'Agent configuration',
    classes: [
      'config.self',
      'config.self_touch',
      'config.git_exec',
      'config.instructions',
      'config.instructions_payload',
    ],
  },
  { label: 'External tools', classes: ['mcp.call', 'mcp.side_effect'] },
  { label: 'Content trust', classes: ['origin.untrusted', 'origin.suspect'] },
];
const actionLabel = (value: string) =>
  Object.hasOwn(ACTION_LABELS, value) ? ACTION_LABELS[value as RecordedActionClass] : value;

export function PolicySettingsPage() {
  const selection = policySelection(useSearchParams());
  const { localAccess } = usePlatform();
  const {
    workspaceId,
    readAllowed,
    state,
    preview,
    receipt,
    error,
    busy,
    effect,
    threshold,
    promoted,
    denyClasses,
    ack,
    ackSharedScope,
    eventComparison,
    eventError,
    eventBusy,
    eventMessage,
    needsRecheck,
    changed,
    disabled,
    load,
    setEffect,
    setThreshold,
    togglePromoted,
    toggleDenyClass,
    setAck,
    setAckSharedScope,
    prepare,
    apply,
    loadEventDraft,
  } = usePolicySettings(selection);
  const blockedLink =
    selection.invalid ||
    (selection.requested && workspaceId !== null && selection.workspaceId !== workspaceId);
  const returnHref = policyEventReturnHref(selection);
  return (
    <div className="page-stack">
      <PageHeading
        title="Policies"
        actions={
          <>
            <Link className="button" href={mcpGovernanceHref()}>
              MCP governance <ArrowRight size={15} aria-hidden="true" />
            </Link>
            <Link className="button" href={policyHistoryHref()}>
              Change history <ArrowRight size={15} aria-hidden="true" />
            </Link>
            <Link className="button" href="/policies/checks/">
              Saved checks <ArrowRight size={15} aria-hidden="true" />
            </Link>
            <Link className="button" href="/policies/reference/">
              Rule reference <ArrowRight size={15} aria-hidden="true" />
            </Link>
            <button
              className="icon-button"
              aria-label="Refresh active policy"
              disabled={!localAccess || !readAllowed || Boolean(busy) || eventBusy}
              onClick={() => void load()}
            >
              <RefreshCw
                size={18}
                className={busy === 'load' ? 'spin' : undefined}
                aria-hidden="true"
              />
            </button>
          </>
        }
      />
      {blockedLink && (
        <div className="control-error" role="alert">
          {selection.invalid
            ? 'This recorded-event link is invalid.'
            : 'This event link belongs to another workspace.'}
          <Link className="inline-link" href="/policies/">
            Open current Policies
          </Link>
        </div>
      )}
      {error && (
        <div className="control-error" role="alert">
          {error}
        </div>
      )}
      {selection.requested && !blockedLink && (
        <section className="policy-event-draft" aria-label="Recorded event draft">
          <div>
            <Badge tone="orange">Recorded event draft</Badge>
            <p>Review recorded actions before changing protection.</p>
          </div>
          <div className="policy-event-actions">
            <button
              className="button"
              disabled={
                !localAccess ||
                !readAllowed ||
                !state?.editable ||
                Boolean(busy) ||
                eventBusy ||
                needsRecheck
              }
              onClick={() => void loadEventDraft()}
            >
              {eventBusy ? (
                <LoaderCircle size={16} className="spin" aria-hidden="true" />
              ) : (
                <ClipboardCheck size={16} aria-hidden="true" />
              )}
              {eventComparison ? 'Reload recorded actions' : 'Load recorded actions'}
            </button>
            <Link className="inline-link" href={returnHref}>
              {receipt ? 'Recompare event' : 'Return to event'}
              <ArrowRight size={14} />
            </Link>
            <Link className="inline-link" href="/policies/">
              Clear event
            </Link>
          </div>
          {eventError && (
            <p className="control-error" role="alert">
              {eventError}
            </p>
          )}
          {eventMessage && (
            <p className="control-meta" role="status">
              {eventMessage}
            </p>
          )}
        </section>
      )}
      {receipt && (
        <div className="policy-receipt" role="status">
          <Check size={20} aria-hidden="true" />
          <div>
            <strong>Policy applied</strong>
            <p>
              {receipt.backupId ? 'Previous configuration backed up.' : 'New policy file created.'}{' '}
              Applied {new Date(receipt.appliedAt).toLocaleTimeString('en-GB')}.
            </p>
            <p>Restart running proxies. Existing tasks keep their launch policy.</p>
            <Link className="inline-link" href={policyHistoryHref(receipt.receiptId)}>
              Review recovery options <ArrowRight size={14} aria-hidden="true" />
            </Link>
            <Link className="inline-link" href="/agents/tasks/">
              Review task permissions <ArrowRight size={14} />
            </Link>
            {selection.incidentId && (
              <Link className="inline-link" href={returnHref}>
                Recompare event
                <ArrowRight size={14} />
              </Link>
            )}
          </div>
          <Badge tone="green">Saved</Badge>
        </div>
      )}
      {!localAccess ? (
        <Panel>
          <EmptyState
            title="Connect your local engine"
            description="Open the private local server link to inspect and update the active policy."
          />
          <div className="panel-body">
            <Link href="/settings/" className="button">
              Connection settings <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </Panel>
      ) : blockedLink ? null : !state ? (
        <Panel>
          <div className="control-empty">
            {busy || (selection.requested && workspaceId === null) ? (
              <>
                <LoaderCircle size={28} className="spin" aria-hidden="true" />
                <p>Reading current policy…</p>
              </>
            ) : (
              <>
                <ShieldCheck size={28} aria-hidden="true" />
                <p>Refresh to load the local policy.</p>
              </>
            )}
          </div>
        </Panel>
      ) : (
        <>
          <div className="protection-status">
            <div className="protection-status-main">
              <ShieldCheck size={20} aria-hidden="true" />
              <strong>{state.source === 'default' ? 'Bundled default' : 'Local policy'}</strong>
              <span className="control-meta">{state.rules.length} rules · This user</span>
            </div>
            <Badge tone={state.check.ok ? 'green' : 'orange'}>
              {state.check.ok ? 'Valid' : 'Needs attention'}
            </Badge>
          </div>
          <div className="policy-workbench">
            <Panel
              title="Protection settings"
              subtitle="All agents using this Stroq data directory."
            >
              <div className="panel-body">
                <div className="policy-rules-heading">
                  <h3>Add action blocks</h3>
                  <p className="muted">Choose categories to deny in every session context.</p>
                </div>
                <div className="policy-class-options" role="group" aria-label="New action blocks">
                  {ACTION_GROUPS.map((group) => {
                    const selected = group.classes.filter((value) =>
                      denyClasses.includes(value),
                    ).length;
                    return (
                      <details className="policy-class-group" key={group.label} open={selected > 0}>
                        <summary>
                          <span>{group.label}</span>
                          {selected > 0 && <Badge tone="orange">{selected} selected</Badge>}
                          <ChevronDown size={16} aria-hidden="true" />
                        </summary>
                        <div>
                          {group.classes.map((value) => (
                            <label className="policy-class-option" key={value}>
                              <input
                                type="checkbox"
                                checked={denyClasses.includes(value)}
                                disabled={disabled || eventBusy}
                                onChange={() => toggleDenyClass(value)}
                              />
                              <span>{ACTION_LABELS[value]}</span>
                            </label>
                          ))}
                        </div>
                      </details>
                    );
                  })}
                </div>
                <div className="policy-field">
                  <label htmlFor="policy-default">
                    <strong>Unmatched actions</strong>
                    <span>When no policy rule applies</span>
                  </label>
                  <select
                    id="policy-default"
                    className="select-field"
                    value={effect}
                    disabled={disabled || eventBusy}
                    onChange={(e) => setEffect(e.target.value as PolicyEffect)}
                  >
                    <option value="allow" disabled={state.defaultEffect !== 'allow'}>
                      Allow
                    </option>
                    <option value="ask" disabled={state.defaultEffect === 'deny'}>
                      Ask for approval
                    </option>
                    <option value="deny">Deny</option>
                  </select>
                </div>
                <div className="policy-field">
                  <label htmlFor="policy-threshold">
                    <strong>Detection threshold</strong>
                    <span>Lower values flag more content.</span>
                  </label>
                  <div className="policy-number">
                    <input
                      id="policy-threshold"
                      type="number"
                      min={0}
                      max={state.threshold ?? 1}
                      step={0.05}
                      value={threshold}
                      disabled={disabled || eventBusy}
                      onChange={(e) => {
                        if (e.target.value !== '') setThreshold(Number(e.target.value));
                      }}
                    />
                    <span>Current: {state.threshold}</span>
                  </div>
                </div>
                <details className="policy-approval-controls">
                  <summary>Promote existing approval rules</summary>
                  <div className="policy-rule-options">
                    {state.rules
                      .filter((rule) => rule.effect === 'ask')
                      .map((rule) => (
                        <label key={rule.index} className="policy-rule-option">
                          <input
                            type="checkbox"
                            disabled={disabled || eventBusy}
                            checked={promoted.includes(rule.index)}
                            onChange={() => togglePromoted(rule.index)}
                          />
                          <span>
                            <strong>Rule {rule.index + 1}</strong>
                            <small>
                              {rule.classes.length
                                ? rule.classes.map(actionLabel).join(' · ')
                                : 'All action classes'}{' '}
                              · {rule.taint === 'any' ? 'any context' : `${rule.taint} context`}
                            </small>
                          </span>
                          <Badge tone="muted">Ask → Deny</Badge>
                        </label>
                      ))}
                    {state.rules.every((rule) => rule.effect !== 'ask') && (
                      <p className="control-meta">No approval rules to promote.</p>
                    )}
                  </div>
                </details>
                <div className="policy-actions">
                  <button
                    className="button primary"
                    disabled={
                      disabled ||
                      eventBusy ||
                      needsRecheck ||
                      !changed ||
                      !Number.isFinite(threshold) ||
                      threshold < 0 ||
                      threshold > (state.threshold ?? 1)
                    }
                    onClick={() => void prepare()}
                  >
                    {busy === 'preview' ? (
                      <LoaderCircle size={16} className="spin" aria-hidden="true" />
                    ) : (
                      <ClipboardCheck size={16} aria-hidden="true" />
                    )}
                    {busy === 'preview' ? 'Comparing scenarios…' : 'Preview & test changes'}
                  </button>
                </div>
              </div>
            </Panel>
            <PolicyPreviewPanel
              preview={preview}
              busy={busy}
              ack={ack}
              ackSharedScope={ackSharedScope}
              onAcknowledge={setAck}
              onAcknowledgeSharedScope={setAckSharedScope}
              onApply={apply}
            />
          </div>
        </>
      )}
    </div>
  );
}
