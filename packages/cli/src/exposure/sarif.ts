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
  'agent-env':
    'This sets a variable for every command the agent and its hooks start, and the variable loads code or sends traffic elsewhere.',
  'agent-permission-bypass':
    'This lets the agent or editor run tools without asking you first, or takes away a rule that refused it something.',
  'agent-broad-allow':
    'This allow rule, folder or mode lets the agent do something without asking you first.',
  'agent-plugin':
    'This turns on a plugin, or adds a place plugins come from, for everyone who opens the repository.',
  'mcp-auto-approve':
    'This starts every MCP server the repository declares without asking about each one.',
  'mcp-server-runs-code':
    'This MCP server entry starts a shell or runs code written on its own command line, or sets variables or a folder that can make it run other code.',
  'mcp-server': 'The agent starts this MCP server program when it opens the repository.',
  'editor-autorun-task':
    'The editor configures automatic tasks for folder opening or Agent Session worktree creation.',
  'agent-definition-hook':
    'This skill, subagent or command declares hooks that run commands while it is active.',
  'instruction-hidden-text':
    'This instruction file holds characters that show nothing, which can hide text from a reviewer.',
  'instruction-file': 'The agent reads this instruction file in every session.',
  'binary-file':
    'This file in an agent folder holds a NUL byte, so it is a binary file, which an agent does not read as instructions.',
  'devcontainer-host-command': WHY['devcontainer-host-command'] ?? '',
  'devcontainer-command': 'The dev container runs this command when it is created or started.',
  'devcontainer-setting':
    'This dev container setting, or a file it builds from, decides what the container is built from, what it gets of this machine, or what runs in it.',
  'package-script-agent-path':
    'npm runs this install script, and it names a file an agent or editor loads by itself.',
  'package-script': 'npm runs this script when the dependencies are installed.',
  'nested-bare-repo': WHY['nested-bare-repo'] ?? '',
  'unreadable-config': 'This agent config could not be read, and it may run something.',
  'config-link-outside':
    'This agent config is a link to a file outside the repository, which was not read.',
  'config-submodule':
    'An agent folder or config is a submodule: what it holds comes from another repository when the submodule is checked out, and was not read.',
  'git-hook-file':
    'Git runs this file as a hook, on a commit, a checkout or a merge, without asking anyone, and the change adds or edits it.',
  'agent-run-file-changed':
    'An entry that runs by itself may start or load this file, and the change edits it, so what runs may change though the entry does not.',
};

const ruleId = (kind: string): string => `stroq/${kind}`;
const isPreTrust = (kind: string): boolean => (PRE_TRUST as ReadonlySet<string>).has(kind);

/** The part of a shown value that comes from this run's key, which changes every run. */
const RUN_DIGEST = /keyed:[0-9a-f]{16}/g;

/**
 * Each finding's fingerprint. One whose value is shown whole hashes its kind, file, name and
 * value, so two entries that differ only in what they run are two alerts. One whose value is
 * scrubbed never puts that value in a hash: a hash of it, public in a public repository's code
 * scanning, would let anyone test guesses at a weak secret. It hashes the scrubbed text without
 * this run's digest, and its place among the entries of its file with the same kind, name and
 * scrubbed text, so two that differ only in a secret are two alerts while the file keeps its order.
 *
 * Whether `--changed-from` passes is decided by the exit code, never by these: a fingerprint that
 * stays the same when a scrubbed value changes only changes how code scanning lists the alert.
 */
function fingerprints(hits: readonly TaggedHit[]): string[] {
  const seen = new Map<string, number>();
  const hash = (text: string): string =>
    createHash('sha256').update(text).digest('hex').slice(0, 32);
  return hits.map((h) => {
    if (h.shown === h.value) return hash([h.kind, h.file, h.name, h.value].join('\u0000'));
    const key = [h.kind, h.file, h.name, h.shown.replace(RUN_DIGEST, 'keyed')].join('\u0000');
    const place = seen.get(key) ?? 0;
    seen.set(key, place + 1);
    return hash(`${key}\u0000scrubbed\u0000${place}`);
  });
}

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
  const shown = agent.filter((h) => !(h.severity === 'notice' && h.status === 'present'));
  const prints = fingerprints(shown);
  const agentResults = shown.map((h, i) => ({
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
    partialFingerprints: { [FINGERPRINT]: prints[i] as string },
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
