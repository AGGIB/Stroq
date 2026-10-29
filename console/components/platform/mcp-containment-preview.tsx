'use client';
import type { Ref } from 'react';
import { Badge } from '@/components/platform-ui';
import { INVENTORY_AGENTS } from '@/lib/inventory';
import type { McpContainmentPreview } from '@/lib/mcp-containment';
import type { McpContainmentAcknowledgements } from '@/lib/mcp-containment-binding';

export function McpContainmentPreviewDetails({
  preview,
  acknowledgements,
  onAcknowledge,
  acknowledgeRef,
  disabled,
  policyWorkspaceLabel,
}: {
  preview: McpContainmentPreview;
  acknowledgements: McpContainmentAcknowledgements;
  onAcknowledge: (key: keyof McpContainmentAcknowledgements, value: boolean) => void;
  acknowledgeRef: Ref<HTMLInputElement>;
  disabled: boolean;
  policyWorkspaceLabel: string;
}) {
  const protecting = preview.action === 'protect-registration';
  const undoProxy = preview.action === 'restore-registration' && preview.proxy !== null;
  const shared = protecting && preview.artifact.scope === 'user';
  const toolApproval = protecting && preview.proxy?.toolApproval === true;
  return (
    <>
      <dl className="property-list">
        <div>
          <dt>Registration</dt>
          <dd>{preview.artifact.name}</dd>
        </div>
        <div>
          <dt>Client</dt>
          <dd>{INVENTORY_AGENTS[preview.artifact.agent]}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>
            {preview.artifact.scope === 'user' ? 'User · multiple workspaces' : 'This workspace'}
          </dd>
        </div>
        {preview.proxy && (
          <div>
            <dt>Workspace context</dt>
            <dd>{policyWorkspaceLabel}</dd>
          </div>
        )}
        <div>
          <dt>Other registrations</dt>
          <dd>{preview.siblings} preserved</dd>
        </div>
        <div>
          <dt>Configuration layout</dt>
          <dd>{preview.reformatted ? 'Will be reformatted' : 'Supported layout preserved'}</dd>
        </div>
      </dl>
      <div className="mcp-operation-notice">
        <Badge tone="orange">Configuration only</Badge>
        <p>
          {protecting
            ? 'Configures this entry to use a strict proxy after reconnect. No server is started or verified.'
            : undoProxy
              ? 'Restore the original entry only while this exact Stroq wrapper is still present.'
              : 'Connected servers may keep running. Other sources may still provide this server.'}
        </p>
        {shared && (
          <p>
            This Stroq policy and the {policyWorkspaceLabel} workspace context will apply across
            workspaces.
          </p>
        )}
        {toolApproval && (
          <p>
            The tool listing is held until every exact version is approved. No tools or calls are
            approved automatically.
          </p>
        )}
      </div>
      <div className="mcp-acknowledgements">
        <label>
          <input
            ref={acknowledgeRef}
            type="checkbox"
            checked={acknowledgements.session}
            disabled={disabled}
            onChange={(event) => onAcknowledge('session', event.target.checked)}
          />
          <span>
            I understand this changes one registration source and does not stop an active server.
            Restart or reconnect the client.
          </span>
        </label>
        {toolApproval && (
          <label>
            <input
              type="checkbox"
              checked={acknowledgements.toolContracts ?? false}
              disabled={disabled}
              onChange={(event) => onAcknowledge('toolContracts', event.target.checked)}
            />
            <span>
              I agree to retain advertised tool descriptions and schemas, which may contain
              sensitive values, unencrypted in the private Stroq store.
            </span>
          </label>
        )}
        {preview.proxy && (
          <label>
            <input
              type="checkbox"
              checked={acknowledgements.proxy}
              disabled={disabled}
              onChange={(event) => onAcknowledge('proxy', event.target.checked)}
            />
            <span>
              {undoProxy
                ? 'I understand removing the proxy removes its strict filtering and policy blocking for future connections.'
                : 'I accept strict message filtering, restricted environment variables, and blocking when policy asks. Cloaking stays off.'}
            </span>
          </label>
        )}
        {shared && (
          <label>
            <input
              type="checkbox"
              checked={acknowledgements.sharedPolicy}
              disabled={disabled}
              onChange={(event) => onAcknowledge('sharedPolicy', event.target.checked)}
            />
            <span>
              Use this Stroq policy and the {policyWorkspaceLabel} workspace context for this
              user-wide connection.
            </span>
          </label>
        )}
        <label>
          <input
            type="checkbox"
            checked={acknowledgements.retention}
            disabled={disabled}
            onChange={(event) => onAcknowledge('retention', event.target.checked)}
          />
          <span>
            I agree to retain the complete configuration, including credentials and unrelated
            entries, unencrypted in the private Stroq user store.
          </span>
        </label>
      </div>
      {preview.proxy && (
        <details className="artifact-section">
          <summary>{undoProxy ? 'Proxy being removed' : 'Strict proxy behavior'}</summary>
          <ul className="mcp-proxy-details">
            <li>
              Policy can block tool calls. An MCP proxy cannot prompt, so ask decisions are denied.
            </li>
            <li>
              Strict mode withholds messages it cannot fully read and scan; repeated withheld
              messages can end the server.
            </li>
            <li>
              The server receives its declared environment variables and base process variables.
              Implicit credentials may no longer be available.
            </li>
            <li>
              Scanned responses may carry warnings. This does not sandbox server code, pin its
              package, or undo effects already performed.
            </li>
            {!undoProxy && (
              <li>Cloaking is off; no reversible cloaking dictionary is created by this action.</li>
            )}
            {toolApproval && (
              <>
                <li>
                  Complete captures can include multiple pages. Incomplete or invalidated listings
                  remain unavailable.
                </li>
                <li>
                  Ordinary Stroq policy still applies. Approval does not retry a call or establish
                  honest server behavior.
                </li>
              </>
            )}
          </ul>
        </details>
      )}
      <details className="artifact-section">
        <summary>Exact configuration fingerprints</summary>
        <p className="control-meta">
          {preview.artifact.configSource === 'claude-desktop-user'
            ? 'Manual desktop configuration'
            : preview.artifact.scope === 'user'
              ? 'User MCP configuration'
              : 'Project MCP configuration'}
        </p>
        <dl className="mcp-fingerprints">
          <div>
            <dt>Original entry</dt>
            <dd>
              <code className="inventory-digest">{preview.artifact.sha256}</code>
            </dd>
          </div>
          <div>
            <dt>Current configuration</dt>
            <dd>
              <code className="inventory-digest">{preview.configSha256}</code>
            </dd>
          </div>
          <div>
            <dt>Planned configuration</dt>
            <dd>
              <code className="inventory-digest">{preview.candidateSha256}</code>
            </dd>
          </div>
        </dl>
      </details>
      <details className="artifact-section">
        <summary>Recovery & limits</summary>
        <p className="control-meta">
          Up to {preview.retention.maxRecords} retained records. No automatic deletion, including
          after restore.
        </p>
        {preview.limitations.map((limit) => (
          <p className="control-meta" key={limit}>
            {limit}
          </p>
        ))}
        <p className="control-meta">
          Preview expires {new Date(preview.expiresAt).toLocaleTimeString('en-GB')}.
        </p>
      </details>
    </>
  );
}
