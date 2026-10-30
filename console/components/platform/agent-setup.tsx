'use client';
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { Dialog } from 'radix-ui';
import { ArrowRight, Check, LoaderCircle, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { Agent } from '@/lib/data';
import { usePlatform } from '@/components/platform-provider';
import { useControl } from '@/components/control-provider';
import { AgentGlyph, Badge, Command } from '@/components/platform-ui';
import {
  SETUP_AGENTS,
  SETUP_REASONS,
  setupSelection,
  type SetupAgent,
  type SetupScope,
} from '@/lib/agent-setup';
import { setupApplyInput } from '@/lib/agent-setup-binding';
import { hookCheckHrefForSetup } from '@/lib/hook-check-navigation';
import { useAgentSetup } from './use-agent-setup';

export function SetupDialog({
  agent,
  scope: initialScope = 'project',
  label = 'Connect agent',
  onConfigured,
}: {
  agent?: Pick<Agent, 'id'>;
  scope?: SetupScope;
  label?: string;
  onConfigured?: () => void;
}) {
  const { localAccess, connectLocal } = usePlatform();
  const { refresh } = useControl();
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const parentKey = `${agent?.id ?? 'any'}:${initialScope}`;
  const [selection, setSelection] = useState(() => ({
    parentKey,
    ...setupSelection(agent?.id, initialScope),
  }));
  const currentSelection =
    selection.parentKey === parentKey
      ? selection
      : { parentKey, ...setupSelection(agent?.id, initialScope) };
  const { agent: selected, scope } = currentSelection;
  const trigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const consent = useRef<HTMLInputElement | null>(null);
  const action = useAgentSetup({
    open,
    agent: selected,
    scope,
    generation,
    onConfigured: () => {
      onConfigured?.();
      void connectLocal();
      void refresh(false);
    },
  });
  const { state, preview, result, busy } = action;
  const hookHref = result ? hookCheckHrefForSetup(result) : null;
  const error =
    action.error ??
    (action.needsRecheck
      ? 'Completion is unknown. Recheck current configuration before preparing another setup.'
      : null);
  const canApply = preview && setupApplyInput(preview, action.acknowledged) !== null;
  const id = useId();
  useEffect(() => {
    setSelection({ parentKey, ...setupSelection(agent?.id, initialScope) });
    setGeneration((before) => before + 1);
  }, [parentKey, agent?.id, initialScope]);
  useEffect(() => {
    if (preview) (consent.current ?? heading.current)?.focus();
  }, [preview]);
  const select = (next: { agent: SetupAgent; scope: SetupScope }) => {
    setSelection({ parentKey, ...next });
    setGeneration((before) => before + 1);
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (busy === 'apply') return;
        if (value) {
          setSelection({ parentKey, ...setupSelection(agent?.id, initialScope) });
          setGeneration((before) => before + 1);
        }
        setOpen(value);
      }}
    >
      <Dialog.Trigger asChild>
        <button ref={trigger} className={`button ${agent ? 'subtle small' : 'primary'}`}>
          {agent ? (
            <ShieldCheck size={15} aria-hidden="true" />
          ) : (
            <Plus size={16} aria-hidden="true" />
          )}
          {label}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content setup-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            heading.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() => {
              if (trigger.current?.isConnected) trigger.current.focus();
              else document.getElementById(agent?.id ?? selected)?.focus();
            });
          }}
        >
          <div className="dialog-header">
            <Dialog.Title ref={heading} tabIndex={-1}>
              {result
                ? result.status === 'review-required'
                  ? 'Hook setup needs review'
                  : result.status === 'unchanged'
                    ? 'Configuration unchanged'
                    : 'Hooks configured'
                : 'Connect agent'}
            </Dialog.Title>
            <Dialog.Description>
              Local configuration for {state?.context.workspace ?? 'This workspace'}
            </Dialog.Description>
            <Dialog.Close
              className="dialog-close icon-button"
              disabled={busy === 'apply'}
              aria-label="Close setup"
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          {!localAccess ? (
            <div className="setup-body">
              <p className="muted">
                Open the private local server link to preview and install hooks.
              </p>
              <Link href="/settings/" className="button" onClick={() => setOpen(false)}>
                Connection settings <ArrowRight size={15} />
              </Link>
            </div>
          ) : (
            <>
              <div className="setup-body">
                {error && (
                  <p className="control-error" role="alert">
                    {error}
                  </p>
                )}
                {action.message && (
                  <p className="control-meta" role="status">
                    {action.message}
                  </p>
                )}
                {(busy === 'load' || busy === 'recheck') && (
                  <p className="control-meta" role="status">
                    <LoaderCircle size={18} className="spin" aria-hidden="true" />{' '}
                    {busy === 'recheck'
                      ? 'Rechecking current configuration…'
                      : 'Checking setup support…'}
                  </p>
                )}
                {state && !result && (
                  <>
                    <div className="setup-selects">
                      <div>
                        <label htmlFor={`${id}-agent`}>Agent</label>
                        <select
                          id={`${id}-agent`}
                          className="select-field"
                          value={selected}
                          disabled={Boolean(busy)}
                          onChange={(event) =>
                            select({ agent: event.target.value as SetupAgent, scope })
                          }
                        >
                          {Object.entries(SETUP_AGENTS).map(([key, name]) => (
                            <option value={key} key={key}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`${id}-scope`}>Install scope</label>
                        <select
                          id={`${id}-scope`}
                          className="select-field"
                          value={scope}
                          disabled={Boolean(busy)}
                          onChange={(event) =>
                            select({ agent: selected, scope: event.target.value as SetupScope })
                          }
                        >
                          <option value="project">Workspace ({state.context.workspace})</option>
                          <option value="user">User (all workspaces)</option>
                        </select>
                      </div>
                    </div>
                    {!action.canPreview && (
                      <p className="control-error" role="status">
                        {SETUP_REASONS[
                          state.reason ??
                            state.agents.find((entry) => entry.id === selected)?.reason ??
                            ''
                        ] ?? 'Setup is unavailable for this agent and scope.'}
                      </p>
                    )}
                  </>
                )}
                {preview && (
                  <>
                    <div className="setup-preview">
                      <div className="setup-preview-heading">
                        <AgentGlyph name={SETUP_AGENTS[preview.agent]} />
                        <strong>{SETUP_AGENTS[preview.agent]}</strong>
                        <Badge tone={preview.remainingLookalikes > 0 ? 'orange' : 'muted'}>
                          {preview.remainingLookalikes > 0
                            ? 'Review required'
                            : preview.operation === 'create'
                              ? 'Create configuration'
                              : preview.operation === 'update'
                                ? 'Update configuration'
                                : 'Existing configuration'}
                        </Badge>
                      </div>
                      <dl className="property-list">
                        <div>
                          <dt>Impact</dt>
                          <dd>
                            {preview.scopeImpact === 'all-workspaces'
                              ? 'User (all workspaces)'
                              : preview.context}
                          </dd>
                        </div>
                        <div>
                          <dt>Target</dt>
                          <dd>
                            <code>{preview.target}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>Exact hooks to add</dt>
                          <dd>{preview.addedHooks}</dd>
                        </div>
                        <div>
                          <dt>Other hooks preserved</dt>
                          <dd>{preview.preservedHooks}</dd>
                        </div>
                        {preview.replacedHooks > 0 && (
                          <div>
                            <dt>Exact duplicates normalized</dt>
                            <dd>{preview.replacedHooks}</dd>
                          </div>
                        )}
                      </dl>
                      {preview.scope === 'project' && preview.scopeImpact === 'all-workspaces' && (
                        <p className="control-error" role="status">
                          This workspace resolves to a user-wide file.
                        </p>
                      )}
                      {preview.remainingLookalikes > 0 && (
                        <p className="control-error" role="status">
                          {preview.remainingLookalikes} similar or modified commands remain and may
                          also run. Setup does not repair or remove them.
                        </p>
                      )}
                      {preview.operation === 'unchanged' && (
                        <p className="control-meta">
                          No settings or installation record will be changed.
                        </p>
                      )}
                      <details className="setup-next">
                        <summary>Events & next steps</summary>
                        <div className="setup-events">
                          {preview.hookEvents.map((event, index) => (
                            <div key={`${event.event}-${index}`}>
                              <span>{event.event}</span>
                              <Badge tone="muted">
                                {event.blocking ? 'Decision hook' : 'Observation hook'}
                              </Badge>
                            </div>
                          ))}
                        </div>
                        <ul>
                          {preview.nextSteps.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ul>
                      </details>
                      <details className="setup-next">
                        <summary>Fingerprints & recovery</summary>
                        <dl className="property-list">
                          <div>
                            <dt>Current settings</dt>
                            <dd className="inventory-digest">
                              {preview.sourceSha256 ?? 'No source file'}
                            </dd>
                          </div>
                          <div>
                            <dt>After setup</dt>
                            <dd className="inventory-digest">{preview.candidateSha256}</dd>
                          </div>
                          <div>
                            <dt>Recovery</dt>
                            <dd>
                              {preview.operation === 'unchanged'
                                ? 'No backup created'
                                : preview.backup.required
                                  ? 'Exact previous settings and recovery record'
                                  : 'New configuration and recovery record'}
                            </dd>
                          </div>
                        </dl>
                        <code className="inventory-digest">{preview.backup.label}</code>
                      </details>
                    </div>
                    {preview.needs.acknowledgeRetainedCopy && (
                      <label className="policy-ack">
                        <input
                          ref={consent}
                          type="checkbox"
                          disabled={busy === 'apply'}
                          checked={action.acknowledged.acknowledgeRetainedCopy}
                          onChange={(event) =>
                            action.acknowledge('acknowledgeRetainedCopy', event.target.checked)
                          }
                        />
                        <span>
                          Keep a private, unencrypted copy of previous settings and installation
                          records, including unrelated entries and any embedded credentials, without
                          automatic expiry.
                        </span>
                      </label>
                    )}
                    {preview.needs.acknowledgeSharedScope && (
                      <label className="policy-ack">
                        <input
                          type="checkbox"
                          disabled={busy === 'apply'}
                          checked={action.acknowledged.acknowledgeSharedScope}
                          onChange={(event) =>
                            action.acknowledge('acknowledgeSharedScope', event.target.checked)
                          }
                        />
                        <span>Apply this setup across workspaces for this OS user.</span>
                      </label>
                    )}
                    <p className="control-meta">
                      Preview expires {new Date(preview.expiresAt).toLocaleTimeString('en-GB')}.
                      Configuration only; live blocking is unverified.
                    </p>
                  </>
                )}
                {result && (
                  <>
                    <div
                      className={result.status === 'configured' ? 'setup-success' : 'setup-preview'}
                    >
                      {result.status === 'configured' && <Check size={24} aria-hidden="true" />}
                      <div>
                        <div className="setup-preview-heading">
                          <AgentGlyph name={SETUP_AGENTS[result.agent]} />
                          <strong>{SETUP_AGENTS[result.agent]}</strong>
                          <Badge tone={result.status === 'review-required' ? 'orange' : 'muted'}>
                            {result.status === 'review-required'
                              ? 'Review required'
                              : result.status === 'unchanged'
                                ? 'Unchanged'
                                : 'Configuration'}
                          </Badge>
                        </div>
                        <p className="control-meta">
                          {result.operation === 'unchanged'
                            ? 'No settings or installation record changed.'
                            : `Restart the agent${result.needsApproval ? ' and approve its hooks' : ''}.`}
                        </p>
                      </div>
                    </div>
                    <dl className="property-list">
                      <div>
                        <dt>Source</dt>
                        <dd>
                          <code>{result.target}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Impact</dt>
                        <dd>
                          {result.scopeImpact === 'all-workspaces'
                            ? 'User (all workspaces)'
                            : result.context}
                        </dd>
                      </div>
                      <div>
                        <dt>Exact hooks present</dt>
                        <dd>{result.currentExactHooks}</dd>
                      </div>
                      <div>
                        <dt>Other hooks preserved</dt>
                        <dd>{result.preservedHooks}</dd>
                      </div>
                    </dl>
                    {result.remainingLookalikes > 0 && (
                      <p className="control-error" role="status">
                        {result.remainingLookalikes} similar or modified commands remain and may
                        also run. Review them separately before relying on this setup.
                      </p>
                    )}
                    <details className="setup-next">
                      <summary>Next steps</summary>
                      <ul>
                        {result.nextSteps.map((step) => (
                          <li key={step}>{step}</li>
                        ))}
                      </ul>
                    </details>
                    <details className="setup-next">
                      <summary>Receipt & recovery</summary>
                      <p>Recorded {new Date(result.configuredAt).toLocaleString('en-GB')}.</p>
                      <code className="inventory-digest">{result.candidateSha256}</code>
                      {result.backup.label ? (
                        <code className="inventory-digest">{result.backup.label}</code>
                      ) : (
                        <p>No recovery copy created for this unchanged configuration.</p>
                      )}
                    </details>
                    <p className="control-meta">
                      Configuration evidence only. Live blocking has not been tested.
                    </p>
                  </>
                )}
              </div>
              <div className="dialog-footer">
                {result && hookHref ? (
                  <Link className="button primary" href={hookHref} onClick={() => setOpen(false)}>
                    Test hook responses <ArrowRight size={15} />
                  </Link>
                ) : result ? (
                  <Link className="button" href="/agents/" onClick={() => setOpen(false)}>
                    Review current Agents <ArrowRight size={15} />
                  </Link>
                ) : action.needsRecheck || action.error ? (
                  <button
                    className="button"
                    disabled={Boolean(busy)}
                    onClick={() => void action.recheck()}
                  >
                    <RefreshCw size={16} aria-hidden="true" /> Recheck configuration
                  </button>
                ) : preview ? (
                  <>
                    <button
                      className="button"
                      disabled={Boolean(busy)}
                      onClick={() => void action.prepare()}
                    >
                      Refresh preview
                    </button>
                    <button
                      className="button primary"
                      disabled={Boolean(busy) || !canApply}
                      onClick={() => void action.apply()}
                    >
                      {busy === 'apply' ? (
                        <LoaderCircle className="spin" size={16} aria-hidden="true" />
                      ) : (
                        <ShieldCheck size={16} aria-hidden="true" />
                      )}
                      {busy === 'apply'
                        ? 'Confirming…'
                        : preview.operation === 'unchanged'
                          ? 'Confirm configuration'
                          : 'Install hooks'}
                    </button>
                  </>
                ) : (
                  <button
                    className="button primary"
                    disabled={Boolean(busy) || !action.canPreview}
                    onClick={() => void action.prepare()}
                  >
                    {busy === 'preview' ? (
                      <LoaderCircle className="spin" size={16} aria-hidden="true" />
                    ) : (
                      <ArrowRight size={16} aria-hidden="true" />
                    )}
                    {busy === 'preview' ? 'Preparing…' : 'Preview installation'}
                  </button>
                )}
              </div>
              {!state?.available && !busy && !result && (
                <details className="setup-next">
                  <summary>Terminal setup</summary>
                  <Command
                    command={`stroq init --agent ${selected}${scope === 'user' ? ' --user' : ''}`}
                  />
                </details>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
