'use client';
import { useRef, useState } from 'react';
import { History, Pause, Radar, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import { INVENTORY_MONITOR_LIMITATIONS, type InventoryMonitorError } from '@/lib/inventory-monitor';
import { useInventoryMonitor } from './use-inventory-monitor';
import { InventoryMonitorPreview } from './inventory-monitor-preview';
import { InventoryMonitorHistory } from './inventory-monitor-history';
const STATUS = {
  disabled: 'Off',
  enabled: 'Watching',
  'in-use': 'In use',
  stopped: 'Stopped',
  'needs-review': 'Needs review',
  unavailable: 'Unavailable',
} as const;
function cause(error: InventoryMonitorError | null) {
  if (error === 'inventory-busy' || error === 'workspace-review-busy')
    return 'Another source check is running. The next scheduled attempt will retry.';
  if (error?.startsWith('observation-'))
    return 'Observed history could not be verified. Earlier captures remain historical.';
  if (error?.startsWith('monitor-store-')) return 'Saved watch settings could not be verified.';
  if (error === 'runtime-unavailable' || error === 'stale-capture')
    return 'The saved scope or analysis runtime needs a fresh review.';
  if (error === 'context-unavailable')
    return 'The workspace and user source identities could not be verified.';
  if (error === 'deadline-exceeded') return 'The bounded check reached its deadline.';
  if (error === 'monitor-in-use') return 'Another local console owns this watch.';
  return 'The latest source check did not establish a new complete observation.';
}
export function InventoryMonitor({
  onCheck,
  canRefresh = true,
}: { onCheck?: (checkId: string) => boolean | void; canRefresh?: boolean } = {}) {
  const action = useInventoryMonitor({ onCheck, canRefresh }),
    state = action.state,
    busy = action.busy !== null;
  const [open, setOpen] = useState(false),
    [intent, setIntent] = useState<'enable' | 'pause'>('enable');
  const [historyOpen, setHistoryOpen] = useState(false),
    [selectedId, setSelectedId] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null),
    historyTrigger = useRef<HTMLButtonElement | null>(null),
    refreshButton = useRef<HTMLButtonElement | null>(null),
    container = useRef<HTMLElement | null>(null);
  const savedIntent =
    !!state?.revision &&
    ['enabled', 'needs-review', 'in-use', 'unavailable'].includes(state.status);
  const canEnable =
    !!state?.runtimeSha256 &&
    ['disabled', 'enabled', 'needs-review'].includes(state.status) &&
    !busy &&
    !action.needsRecheck;
  const canPause = savedIntent && !busy && !action.needsRecheck;
  const historyState = action.historyState ?? (state?.history.status === 'ready' ? state : null);
  const latest = historyState?.history.records[0],
    attempt = state?.lastAttempt;
  const failure = attempt && ['failed', 'cancelled', 'skipped'].includes(attempt.status);
  const health = action.needsRecheck
    ? 'Recheck required'
    : action.freshness === 'historical'
      ? 'Saved state historical'
      : state?.history.status === 'unavailable'
        ? 'History unavailable'
        : attempt?.status === 'running'
          ? 'Checking'
          : attempt?.status === 'failed'
            ? 'Last check failed'
            : attempt?.status === 'cancelled'
              ? 'Last check cancelled'
              : attempt?.status === 'skipped'
                ? 'Check waiting'
                : latest && !latest.complete
                  ? 'Partial capture'
                  : null;
  const prepare = (next: 'enable' | 'pause', button: HTMLButtonElement) => {
    trigger.current = button;
    setIntent(next);
    setOpen(true);
    void action.prepare(next);
  };
  const close = () => {
    action.invalidate();
    setOpen(false);
  };
  return (
    <section
      className="workspace-monitor inventory-monitor"
      aria-label="Skills and MCP change watch"
      ref={container}
      tabIndex={-1}
    >
      <div className="workspace-monitor-heading">
        <div className="workspace-monitor-heading-main">
          <Radar size={22} aria-hidden="true" />
          <div>
            <h2>Skills & MCP watch</h2>
            <p>Every 5 minutes · project and user sources</p>
          </div>
          <Badge
            tone={
              state?.status === 'needs-review' || state?.status === 'unavailable'
                ? 'orange'
                : 'muted'
            }
          >
            {state ? STATUS[state.status] : 'Unavailable'}
          </Badge>
        </div>
        <div className="workspace-monitor-controls">
          <button
            className="icon-button"
            aria-label="Refresh inventory watch state"
            ref={refreshButton}
            disabled={!action.workspaceId || busy}
            onClick={action.refresh}
          >
            <RefreshCw
              size={17}
              className={action.busy === 'load' ? 'spin' : undefined}
              aria-hidden="true"
            />
          </button>
          <button
            className="button small"
            ref={historyTrigger}
            disabled={!historyState}
            onClick={() => {
              setSelectedId(historyState?.latestCaptureId ?? null);
              setHistoryOpen(true);
            }}
          >
            <History size={16} aria-hidden="true" />
            Observed versions
          </button>
          {savedIntent && (
            <button
              className="button small"
              disabled={!canPause}
              onClick={(event) => prepare('pause', event.currentTarget)}
            >
              <Pause size={16} aria-hidden="true" />
              Pause watch
            </button>
          )}
          {(!savedIntent || state?.status === 'needs-review') && (
            <button
              className="button small"
              disabled={!canEnable}
              onClick={(event) => prepare('enable', event.currentTarget)}
            >
              <Radar size={16} aria-hidden="true" />
              {state?.status === 'needs-review' ? 'Review watch' : 'Watch sources'}
            </button>
          )}
        </div>
      </div>
      {(latest || state?.nextCheckAt) && (
        <div className="workspace-monitor-facts">
          {latest && (
            <span>
              Last captured{' '}
              <time dateTime={latest.lastObservedAt}>
                {new Date(latest.lastObservedAt).toLocaleString('en-GB')}
              </time>{' '}
              · {latest.itemCount} items
            </span>
          )}
          {state?.nextCheckAt && (
            <span>
              Next check{' '}
              <time dateTime={state.nextCheckAt}>
                {new Date(state.nextCheckAt).toLocaleTimeString('en-GB')}
              </time>
            </span>
          )}
        </div>
      )}
      {health && (
        <div className="inventory-monitor-health" role="status">
          <Badge tone={health === 'Checking' ? 'muted' : 'orange'}>{health}</Badge>
          {failure && (
            <span>
              {cause(attempt.error)}
              {latest && ' Previous capture remains historical.'}
            </span>
          )}
          {latest && !latest.complete && !failure && (
            <span>{latest.gaps} coverage gaps. Missing items are unconfirmed.</span>
          )}
        </div>
      )}
      {state && ['needs-review', 'unavailable', 'in-use', 'stopped'].includes(state.status) && (
        <p className="control-meta" role="status">
          {state.status === 'stopped'
            ? 'This console has stopped scheduling checks.'
            : cause(state.reason)}
        </p>
      )}
      {action.needsRecheck && (
        <p className="control-error" role="status">
          Watch change completion is unknown.{' '}
          <button className="inline-link" disabled={busy} onClick={action.refresh}>
            Recheck saved state
          </button>
        </p>
      )}
      {!open && action.error && (
        <p className="control-error" role="alert">
          {action.error}
        </p>
      )}
      {action.pollStopped && (
        <p className="control-meta" role="status">
          Saved-state updates paused. Refresh watch state to retry.
        </p>
      )}
      <details className="workspace-monitor-limits">
        <summary>Scope & limits</summary>
        <ul>
          {INVENTORY_MONITOR_LIMITATIONS.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </details>
      <InventoryMonitorPreview
        action={action}
        open={open}
        intent={intent}
        onClose={close}
        onReturnFocus={() => {
          if (trigger.current?.isConnected && !trigger.current.disabled) trigger.current.focus();
          else if (refreshButton.current?.isConnected && !refreshButton.current.disabled)
            refreshButton.current.focus();
          else container.current?.focus();
        }}
      />
      <InventoryMonitorHistory
        state={historyState}
        open={historyOpen}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onClose={() => setHistoryOpen(false)}
        onReturnFocus={() => {
          if (historyTrigger.current?.isConnected && !historyTrigger.current.disabled)
            historyTrigger.current.focus();
          else container.current?.focus();
        }}
        historical={action.historyHistorical || action.freshness === 'historical'}
      />
    </section>
  );
}
