'use client';

import { useState } from 'react';
import { ChevronDown, Info, Search } from 'lucide-react';
import {
  Badge,
  Command,
  EmptyState,
  ExportButton,
  PageHeading,
  Panel,
} from '@/components/platform-ui';

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search-field">
      <Search size={16} aria-hidden="true" />
      <input
        name="search"
        autoComplete="off"
        spellCheck={false}
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

type Rule = {
  id: string;
  effect: 'deny' | 'ask';
  reason: string;
  action: string;
  taint: 'any' | 'suspect';
};
// Reference copied from policies/default.yaml. It does not represent an installed policy.
const RULES: readonly Rule[] = [
  {
    id: 'deny-secret-egress',
    effect: 'deny',
    reason: 'Arguments contain the value of a known secret; outbound use is blocked',
    action: 'secret.egress',
    taint: 'any',
  },
  {
    id: 'deny-secret-unscannable',
    effect: 'deny',
    reason:
      'Arguments are larger than the secret scan window (2 MiB), so Stroq cannot check them for secret values; outbound use is blocked',
    action: 'secret.unscannable',
    taint: 'any',
  },
  {
    id: 'deny-canary-file',
    effect: 'deny',
    reason:
      'A decoy file planted with stroq canary --file was touched; no task needs it, so the session is treated as compromised',
    action: 'fs.canary',
    taint: 'any',
  },
  {
    id: 'deny-self-tamper',
    effect: 'deny',
    reason:
      'Modifying agent security configuration is blocked; that change is yours to make, outside the agent (to take Stroq out: stroq uninstall)',
    action: 'config.self',
    taint: 'any',
  },
  {
    id: 'deny-git-exec',
    effect: 'deny',
    reason:
      'Installing repository-supplied execution (git exec-on-read config or hook file) is blocked',
    action: 'config.git_exec',
    taint: 'any',
  },
  {
    id: 'deny-encoded-exec',
    effect: 'deny',
    reason: 'Executing decoded or remotely fetched code is blocked',
    action: 'shell.exec_encoded',
    taint: 'any',
  },
  {
    id: 'deny-origin-suspect',
    effect: 'deny',
    reason: 'Action was dictated by content Stroq flagged as suspicious; blocked',
    action: 'origin.suspect',
    taint: 'any',
  },
  {
    id: 'deny-network-when-tainted',
    effect: 'deny',
    reason: 'Session is tainted by suspicious content; outbound network command blocked',
    action: 'shell.network',
    taint: 'suspect',
  },
  {
    id: 'deny-fetch-when-tainted',
    effect: 'deny',
    reason: 'Session is tainted by suspicious content; web fetch blocked',
    action: 'network.fetch',
    taint: 'suspect',
  },
  {
    id: 'deny-secrets-when-tainted',
    effect: 'deny',
    reason: 'Session is tainted by suspicious content; access to secrets blocked',
    action: 'fs.secrets',
    taint: 'suspect',
  },
  {
    id: 'deny-persistence-when-tainted',
    effect: 'deny',
    reason:
      'Session is tainted by suspicious content; installing something a trusted process will run later (shell startup file, SSH key, scheduled job, auto-run task) is blocked',
    action: 'config.persistence',
    taint: 'suspect',
  },
  {
    id: 'deny-push-external-when-tainted',
    effect: 'deny',
    reason: 'Session is tainted by suspicious content; push to external remote blocked',
    action: 'git.push_external',
    taint: 'suspect',
  },
  {
    id: 'ask-origin-untrusted',
    effect: 'ask',
    reason:
      'Action was copied from content the agent read (tool output is data, not instructions); confirm',
    action: 'origin.untrusted',
    taint: 'any',
  },
  {
    id: 'ask-mcp-side-effect-when-tainted',
    effect: 'ask',
    reason: 'Session is tainted by suspicious content; confirm this side-effecting MCP call',
    action: 'mcp.side_effect',
    taint: 'suspect',
  },
  {
    id: 'ask-self-touch',
    effect: 'ask',
    reason: 'Command references agent security configuration; confirm',
    action: 'config.self_touch',
    taint: 'any',
  },
  {
    id: 'ask-persistence',
    effect: 'ask',
    reason:
      'This installs something a trusted process will run later (shell startup file, SSH key, scheduled job, auto-run task); confirm',
    action: 'config.persistence',
    taint: 'any',
  },
  {
    id: 'ask-instructions-payload',
    effect: 'ask',
    reason:
      'The text being written to an instruction file itself matches an injection rule; every later session would load it; confirm',
    action: 'config.instructions_payload',
    taint: 'any',
  },
  {
    id: 'ask-instructions-when-tainted',
    effect: 'ask',
    reason:
      'Session is tainted by suspicious content; a write to a file every later session loads as instructions needs confirmation',
    action: 'config.instructions',
    taint: 'suspect',
  },
  {
    id: 'ask-destructive',
    effect: 'ask',
    reason: 'Destructive command requires confirmation',
    action: 'shell.destructive',
    taint: 'any',
  },
  {
    id: 'ask-shell-unparsed',
    effect: 'ask',
    reason:
      'Stroq could not read all of this action (a dynamic-execution form with a non-literal operand, a shell handed a program it cannot read, a fetched or decoded stream piped into a command it does not know only reads it, nesting too deep or a command too costly to read in time, or more file arguments than it will read); confirm',
    action: 'shell.unparsed',
    taint: 'any',
  },
  {
    id: 'ask-push-external',
    effect: 'ask',
    reason: 'Push to an external remote requires confirmation',
    action: 'git.push_external',
    taint: 'any',
  },
];

function ruleCategory(rule: Rule) {
  if (
    rule.action.startsWith('secret.') ||
    rule.action === 'fs.secrets' ||
    rule.action === 'fs.canary'
  )
    return 'Secrets';
  if (rule.action.startsWith('config.')) return 'Configuration';
  if (rule.action.startsWith('origin.')) return 'Content trust';
  return 'Actions';
}

export function PoliciesPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All rules');
  const visible = RULES.filter(
    (rule) =>
      (category === 'All rules' || ruleCategory(rule) === category) &&
      `${rule.id} ${rule.reason} ${rule.action}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="page-stack">
      <PageHeading
        title="Policies"
        actions={
          <ExportButton
            data={{
              source: 'bundled-reference',
              version: 1,
              threshold: 0.6,
              default: 'allow',
              rules: RULES,
            }}
            filename="stroq-policy-reference.json"
            label="Export reference"
          />
        }
      />
      <Panel
        title="Default policy"
        subtitle="default.yaml · v1"
        actions={<Badge tone="muted">Bundled reference</Badge>}
      >
        <div className="panel-body">
          <p className="info-note">
            <Info aria-hidden="true" size={18} />
            Reference only; your installed policy may differ. First match wins.
          </p>
          <div className="property-list">
            <div>
              <span className="muted">Rules</span>
              <strong>{RULES.length}</strong>
            </div>
            <div>
              <span className="muted">Threshold</span>
              <strong className="mono">0.6</strong>
            </div>
            <div>
              <span className="muted">Unmatched actions</span>
              <Badge tone="green">Allow</Badge>
            </div>
          </div>
        </div>
      </Panel>
      <Panel title="Rules" subtitle={`${visible.length} / ${RULES.length}`}>
        <div className="toolbar">
          <div className="filter-tabs" aria-label="Rule category">
            {['All rules', 'Secrets', 'Configuration', 'Content trust', 'Actions'].map((name) => (
              <button
                key={name}
                className={category === name ? 'is-active' : ''}
                aria-pressed={category === name}
                onClick={() => setCategory(name)}
              >
                {name}
              </button>
            ))}
          </div>
          <SearchField value={query} onChange={setQuery} placeholder="Find a rule…" />
        </div>
        <div className="rule-list">
          {visible.map((rule) => (
            <details key={rule.id} className="rule-item">
              <summary className="rule-summary">
                <span className="mono muted">
                  {String(RULES.indexOf(rule) + 1).padStart(2, '0')}
                </span>
                <span className="table-main mono">{rule.id}</span>
                <Badge tone={rule.effect === 'deny' ? 'red' : 'orange'}>
                  {rule.effect === 'deny' ? 'Deny' : 'Ask'}
                </Badge>
                <ChevronDown aria-hidden="true" size={16} />
              </summary>
              <div className="rule-description">
                <p>{rule.reason}</p>
                <div className="rule-meta">
                  <span className="mono">Class: {rule.action}</span>
                  <span>Taint: {rule.taint === 'any' ? 'any state' : 'suspect content'}</span>
                  <span>{ruleCategory(rule)}</span>
                </div>
              </div>
            </details>
          ))}
        </div>
        {!visible.length && (
          <EmptyState title="No matching rules" description="Try another category or search." />
        )}
      </Panel>
      <Panel title="Check installed policy">
        <div className="panel-body">
          <Command command="stroq policy check --json" />
          <p className="muted">Hosts without prompts may turn Ask into Deny.</p>
        </div>
      </Panel>
    </div>
  );
}
