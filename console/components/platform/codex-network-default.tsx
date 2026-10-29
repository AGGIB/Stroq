'use client';
import { Badge } from '@/components/platform-ui';
import { CODEX_NETWORK_ERROR_MESSAGES } from '@/lib/codex-network-client';
import type { CodexNetworkControls } from './use-codex-network-controls';
const PROFILE = {
  workspace: 'Workspace',
  'read-only': 'Read-only',
  'full-access': 'Full access',
  custom: 'Custom permission profile',
  none: 'No explicit profile',
} as const;
export function CodexNetworkDefault({ action }: { action: CodexNetworkControls }) {
  const { guard: g, checks } = action,
    c = g.capture;
  return (
    <section aria-label="Captured Codex user default" className="codex-network-default">
      <div className="codex-network-heading">
        <h3>User default</h3>
        <button
          className={c ? 'inline-link' : 'button primary'}
          disabled={!action.connected || !!action.busy}
          onClick={() => void g.inspect()}
        >
          {action.busy === 'capture' ? 'Inspecting…' : c ? 'Inspect again' : 'Inspect settings'}
        </button>
      </div>
      {!c ? (
        <p className="control-meta">
          Inspect the selected user configuration to review networking.
        </p>
      ) : (
        <>
          <dl className="property-list codex-network-facts">
            <div>
              <dt>Declared networking</dt>
              <dd>
                {c.baseline.network === 'on'
                  ? 'On'
                  : c.baseline.network === 'off'
                    ? 'Off'
                    : 'Unverified'}
              </dd>
            </div>
            <div>
              <dt>Permission source</dt>
              <dd>
                {c.baseline.kind === 'legacy'
                  ? 'Legacy sandbox settings'
                  : PROFILE[c.baseline.profile]}
              </dd>
            </div>
            <div>
              <dt>Captured</dt>
              <dd>
                <time dateTime={c.capturedAt}>
                  {new Date(c.capturedAt).toLocaleTimeString('en-GB')}
                </time>
              </dd>
            </div>
          </dl>
          {c.reason && (
            <p
              className={
                c.reason === 'codex-network-already-off' ? 'control-meta' : 'control-error'
              }
              role={c.reason === 'codex-network-already-off' ? 'status' : 'alert'}
            >
              {CODEX_NETWORK_ERROR_MESSAGES[c.reason]}
            </p>
          )}
          {c.canGuard && (
            <button
              className="button primary"
              disabled={
                !!action.busy ||
                g.pending.length > 0 ||
                g.state?.records.some((r) => r.operationStatus === 'unknown')
              }
              onClick={() => void g.prepare()}
            >
              Preview network off
            </button>
          )}
          {c.canCheck && (
            <button
              className="button primary"
              disabled={!!action.busy || !checks.canPrepare}
              onClick={() => void checks.prepare()}
            >
              Preview native check
            </button>
          )}
          <p className="control-meta">
            Base user setting. Other profiles, trusted projects and CLI overrides can differ.
          </p>
          <details className="codex-network-evidence">
            <summary>Scope & evidence</summary>
            <p>
              Existing chats and commands are not stopped. MCP, browser, connectors and cloud use
              separate controls. Managed requirements and actual client adoption remain unverified
              where listed.
            </p>
            <dl className="property-list">
              <div>
                <dt>Native compatibility</dt>
                <dd>{c.compatibility.status}</dd>
              </div>
              <div>
                <dt>Codex build</dt>
                <dd>{c.compatibility.version ?? 'Unverified'}</dd>
              </div>
              <div>
                <dt>Captured layers</dt>
                <dd>
                  {c.layers.filter((l) => l.status === 'captured').length} read ·{' '}
                  {c.layers.filter((l) => l.status === 'unsupported').length} unsupported
                </dd>
              </div>
            </dl>
            {c.gaps.length > 0 && (
              <ul>
                {c.gaps.map((gap) => (
                  <li key={gap}>{GAPS[gap]}</li>
                ))}
              </ul>
            )}
            {c.binding && (
              <>
                <span>Captured settings SHA-256</span>
                <code>{c.binding.captureSha256}</code>
              </>
            )}
          </details>
        </>
      )}
    </section>
  );
}
const GAPS = {
  'named-profile-unverified': 'Named configuration profiles unverified',
  'session-overrides-unverified': 'Session and CLI overrides unverified',
  'running-clients-unverified': 'Existing client adoption unverified',
  'other-surfaces-unverified': 'Other agent surfaces outside this setting',
  'system-source-unavailable': 'A system configuration source is unavailable',
  'managed-source-unverified': 'Managed requirements unverified',
  'project-source-unavailable': 'A project configuration source is unavailable',
  'context-unavailable': 'Selected context unavailable',
  'native-unsupported': 'Native Codex build unsupported',
} as const;
