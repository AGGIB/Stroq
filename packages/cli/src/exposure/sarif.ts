import { createHash } from 'node:crypto';
import type { TaggedHit } from './agent-change.js';
import { AGENT_KINDS, KIND_SEVERITY, type AgentKind, type Severity } from './agent-kinds.js';
import { describe, plainQuote } from './agent-report.js';
import { PRE_TRUST, WHY, repoFindings, type RepoSurface } from './repo-surface.js';

const SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const HELP = 'https://github.com/AGGIB/Stroq/blob/main/docs/GUIDE.md#before-you-open-a-repository';
/**
 * GitHub ranks a code-scanning alert by this number, and 9.0 and above is critical —
 * which is what `stroq inspect` already calls every one of these, and why it exits 1.
 */
const SECURITY_SEVERITY = '9.0';
/** What runs once the folder is trusted ranks below what runs before anyone is asked. */
const AGENT_SECURITY_SEVERITY: Readonly<Record<Severity, string>> = {
  error: '8.0',
  warning: '5.0',
  notice: '2.0',
};
const LEVEL: Readonly<Record<Severity, string>> = {
  error: 'error',
  warning: 'warning',
  notice: 'note',
};
const FINGERPRINT = 'stroqFinding/v1';

/** Why each kind an agent or editor runs is reported; the rule text in SARIF. */
const AGENT_WHY: Readonly<Record<AgentKind, string>> = {
  'agent-hook':
    'An agent runs this hook command by itself on its own events, with your permissions.',
  'agent-helper-command':
    'Claude Code runs this helper command by itself, for example to draw the status line or fetch a key.',
  'agent-api-redirect':
    "This sends the agent's API traffic, and the key with it, to another address.",
  'agent-permission-bypass': 'This lets the agent or editor run tools without asking you first.',
  'agent-plugin':
    'This turns on a plugin, or adds a place plugins come from, for everyone who opens the repository.',
  'mcp-auto-approve':
    'This starts every MCP server the repository declares without asking about each one.',
  'mcp-server-runs-code':
    'This MCP server entry starts a shell or runs code written on its own command line.',
  'mcp-server': 'The agent starts this MCP server program when it opens the repository.',
  'editor-autorun-task': 'The editor runs this task as soon as the folder is opened.',
  'agent-definition-hook':
    'This skill, subagent or command declares hooks that run commands while it is active.',
  'instruction-hidden-text':
    'This instruction file holds characters that show nothing, which can hide text from a reviewer.',
  'instruction-file': 'The agent reads this instruction file in every session.',
  'devcontainer-host-command': WHY['devcontainer-host-command'] ?? '',
  'devcontainer-command': 'The dev container runs this command when it is created or started.',
  'package-script-agent-path':
    'npm runs this install script, and it names a file an agent or editor loads by itself.',
  'package-script': 'npm runs this script when the dependencies are installed.',
  'nested-bare-repo': WHY['nested-bare-repo'] ?? '',
  'unreadable-config': 'This agent config could not be read, and it may run something.',
  'config-link-outside':
    'This agent config is a link to a file outside the repository, which was not read.',
};

const ruleId = (kind: string): string => `stroq/${kind}`;
const isPreTrust = (kind: string): boolean => (PRE_TRUST as ReadonlySet<string>).has(kind);

const fingerprint = (h: TaggedHit): string =>
  createHash('sha256')
    .update([h.kind, h.file, h.name, h.value].join('\u0000'))
    .digest('hex')
    .slice(0, 32);

function rule(kind: string): object {
  if (isPreTrust(kind))
    return {
      id: ruleId(kind),
      name: kind,
      shortDescription: { text: `Repository-supplied execution: ${kind}` },
      fullDescription: { text: WHY[kind] ?? 'repository-supplied execution' },
      helpUri: HELP,
      defaultConfiguration: { level: 'error' },
      properties: { 'security-severity': SECURITY_SEVERITY, tags: ['security'] },
    };
  const severity = KIND_SEVERITY[kind as AgentKind];
  return {
    id: ruleId(kind),
    name: kind,
    shortDescription: {
      text: `Runs by itself when an agent or editor opens the repository: ${kind}`,
    },
    fullDescription: { text: AGENT_WHY[kind as AgentKind] },
    helpUri: HELP,
    defaultConfiguration: { level: LEVEL[severity] },
    properties: { 'security-severity': AGENT_SECURITY_SEVERITY[severity], tags: ['security'] },
  };
}

/**
 * `stroq inspect` as a SARIF 2.1.0 log, for GitHub code scanning and any other tool
 * that reads the format: a repository's pre-trust execution shown on the pull request
 * that adds it, before anyone opens the checkout with an agent.
 *
 * One rule per kind, all of them always listed so the rule set does not change with the
 * repository scanned. The pre-trust kinds come first, as they always have. What runs on an
 * ordinary open or build is left out, exactly as it is left out of the exit code: a check
 * that flags every repository with a pre-commit hook is a check people turn off.
 *
 * What an agent or editor runs by itself follows, one result per finding, at its line, with
 * a fingerprint made of what it runs rather than where, so an edit above it does not make it
 * a new alert, and `properties.change` saying whether the change being checked brought it.
 * An instruction file nothing changed is left out: reading it is not a finding.
 *
 * `stroq exposure` has no SARIF form on purpose. Its findings are about this machine —
 * an agent without hooks, an MCP server outside the proxy — and have no file in the
 * repository to point at, which code scanning requires of every result.
 */
export function inspectSarif(
  surface: RepoSurface,
  version: string,
  agent: readonly TaggedHit[] = [],
): object {
  const kinds: string[] = [...PRE_TRUST, ...AGENT_KINDS.filter((k) => !isPreTrust(k))];
  const findings = repoFindings(surface);
  const preTrust = surface.preTrust.map((hit, i) => {
    const finding = findings[i];
    const fix = finding?.fix ? ` Fix: ${finding.fix}.` : '';
    return {
      ruleId: ruleId(hit.kind),
      ruleIndex: kinds.indexOf(hit.kind),
      level: 'error',
      message: { text: `${finding?.detail ?? `${hit.file} — ${hit.what}`}.${fix}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: hit.file.replace(/\\/g, '/'), uriBaseId: '%SRCROOT%' },
          },
        },
      ],
    };
  });
  const agentResults = agent
    .filter((h) => !(h.severity === 'notice' && h.status === 'present'))
    .map((h) => ({
      ruleId: ruleId(h.kind),
      ruleIndex: kinds.indexOf(h.kind),
      level: LEVEL[h.severity],
      message: { text: describe(h, plainQuote) },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: h.file, uriBaseId: '%SRCROOT%' },
            region: { startLine: h.line },
          },
        },
      ],
      partialFingerprints: { [FINGERPRINT]: fingerprint(h) },
      properties: { change: h.status },
    }));
  return {
    $schema: SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'stroq',
            version,
            informationUri: 'https://stroq.dev',
            rules: kinds.map(rule),
          },
        },
        results: [...preTrust, ...agentResults],
      },
    ],
  };
}
