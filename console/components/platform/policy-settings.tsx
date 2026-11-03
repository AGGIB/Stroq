'use client';
import Link from 'next/link';
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
import { Badge, Panel } from '@/components/platform-ui';
import { ACTION_LABELS, type RecordedActionClass } from '@/lib/incident-comparison';
import { policySelection } from '@/lib/policy-navigation';
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

/** No recorded event is being drafted from: the rules are changed from what is on screen. */
const NO_EVENT = policySelection(new URLSearchParams());

/** The rules that can be turned on, with a preview and a test before anything is written. A section of Rules. */
export function PolicySettings() {
  const selection = NO_EVENT;
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
  return (
    <section id="rules" className="rules-section" aria-labelledby="rules-title">
      <div className="rules-section-head">
        <h2 id="rules-title">Rules you can change</h2>
        <div className="rules-section-actions">
          <Link className="button" href="/policies/checks/">
            Saved checks <ArrowRight size={15} aria-hidden="true" />
          </Link>
          <button
            className="icon-button"
            aria-label="Refresh active policy"
            disabled={!localAccess || !readAllowed || Boolean(busy)}
            onClick={() => void load()}
          >
            <RefreshCw
              size={18}
              className={busy === 'load' ? 'spin' : undefined}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
      {error && (
        <div className="control-error" role="alert">
          {error}
        </div>
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
          </div>
          <Badge tone="green">Saved</Badge>
        </div>
      )}
      {!localAccess ? (
        <Panel>
          <p className="panel-body control-meta">
            Not connected to Stroq on this machine. Run <code>npx @stroq/cli console</code> to open
            this page with your data.
          </p>
        </Panel>
      ) : !state ? (
        <Panel>
          <div className="control-empty">
            {busy ? (
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
              title="Turn rules on"
              subtitle="Changes apply to all agents using this Stroq data directory."
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
      <p className="control-meta">
        MCP calls are judged on{' '}
        <Link className="inline-link" href={mcpGovernanceHref()}>
          Skills &amp; MCP
        </Link>
        .
      </p>
    </section>
  );
}
