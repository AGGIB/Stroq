import { closed, count, list, member, stamp, text } from './local-guards';

/**
 * The settings check: settings in an agent's own files that weaken or switch off its own checks.
 *
 * The server reports only a finding id, the agent, where it was found and sometimes a count. Every
 * word the person reads comes from the catalog below, so no value from a settings file (a command, a
 * path, a rule) can reach the page. The catalog was checked against each vendor's own documentation
 * on 2026-10-27; the notes are in docs/platform/posture-audit.md.
 */

export const POSTURE_AGENTS = ['claude-code', 'codex', 'cursor', 'windsurf'] as const;
export type PostureAgent = (typeof POSTURE_AGENTS)[number];
export const POSTURE_SCOPES = ['user', 'project', 'local'] as const;
export type PostureScope = (typeof POSTURE_SCOPES)[number];
export const POSTURE_FILES = [
  'settings',
  'config',
  'cli-config',
  'sandbox',
  'permissions',
  'devin-config',
] as const;
export type PostureFile = (typeof POSTURE_FILES)[number];
export type PostureSeverity = 'critical' | 'high' | 'medium' | 'info';

export interface PostureEntry {
  readonly agent: PostureAgent;
  readonly file: PostureFile;
  readonly severity: PostureSeverity;
  /** The setting to look for, as the vendor names it. */
  readonly setting: string;
  readonly title: string;
  readonly why: string;
  readonly fix: string;
  /** True when the finding counts rules (how many broad allow rules there are). */
  readonly counted: boolean;
}

export const POSTURE_CATALOG = {
  'claude-hooks-off': {
    agent: 'claude-code',
    file: 'settings',
    severity: 'critical',
    setting: 'disableAllHooks',
    title: 'Claude Code hooks are switched off',
    why: 'With hooks off, Claude Code never asks Stroq about what it does. Nothing it does is judged or recorded.',
    fix: 'Remove "disableAllHooks" from this file, or set it to false.',
    counted: false,
  },
  'claude-bypass-permissions': {
    agent: 'claude-code',
    file: 'settings',
    severity: 'high',
    setting: 'permissions.defaultMode',
    title: 'Claude Code runs without asking',
    why: 'The default mode is "bypassPermissions": every tool call runs without a permission prompt.',
    fix: 'Set permissions.defaultMode to "default", or remove it.',
    counted: false,
  },
  'claude-bypass-ignored': {
    agent: 'claude-code',
    file: 'settings',
    severity: 'medium',
    setting: 'permissions.defaultMode',
    title: 'A project settings file sets Claude Code to run without asking',
    why: 'The default mode is "bypassPermissions". Claude Code’s settings reference says current versions ignore this from a project or local file, but versions before 2.1.257 honored it, and the file may be meant for you to copy into your own.',
    fix: 'Remove it from this file.',
    counted: false,
  },
  'claude-bypass-accepted': {
    agent: 'claude-code',
    file: 'settings',
    severity: 'medium',
    setting: 'skipDangerousModePermissionPrompt',
    title: 'The bypass warning was accepted once',
    why: 'Claude Code sets this after you accept the one-time warning for running without permission prompts. It suggests that mode has been used or can be turned on without a question.',
    fix: 'Remove skipDangerousModePermissionPrompt so the warning shows again.',
    counted: false,
  },
  'claude-allow-any-shell': {
    agent: 'claude-code',
    file: 'settings',
    severity: 'high',
    setting: 'permissions.allow',
    title: 'Any shell command is allowed without asking',
    why: 'An allow rule of "Bash" or "Bash(*)" lets Claude Code run every shell command without a prompt.',
    fix: 'Replace it with the specific commands you use, such as "Bash(pnpm test)".',
    counted: true,
  },
  'claude-allow-interpreter': {
    agent: 'claude-code',
    file: 'settings',
    severity: 'medium',
    setting: 'permissions.allow',
    title: 'A shell or interpreter is allowed without asking',
    why: 'An allow rule for python, node, bash, sh, curl, ssh or similar runs any code or network call that follows it, so it is as wide as allowing every command.',
    fix: 'Allow the exact script or command instead of the program that runs anything.',
    counted: true,
  },
  'claude-allow-any-web': {
    agent: 'claude-code',
    file: 'settings',
    severity: 'medium',
    setting: 'permissions.allow',
    title: 'Fetching any web page is allowed without asking',
    why: 'An allow rule of "WebFetch" or "WebFetch(domain:*)" lets the agent read any address, which is how hidden instructions reach it.',
    fix: 'Allow the domains you use, such as "WebFetch(domain:docs.example.com)".',
    counted: true,
  },
  'claude-all-project-mcp': {
    agent: 'claude-code',
    file: 'settings',
    severity: 'medium',
    setting: 'enableAllProjectMcpServers',
    title: 'Every MCP server a repository declares is approved',
    why: 'A repository can list MCP servers in .mcp.json. With this on, they start without you reviewing them, and they run code.',
    fix: 'Remove enableAllProjectMcpServers and approve servers one by one.',
    counted: false,
  },
  'claude-repo-helper': {
    agent: 'claude-code',
    file: 'settings',
    severity: 'high',
    setting: 'apiKeyHelper',
    title: 'A project settings file sets a start-up command for Claude Code',
    why: 'This file sets a helper command (apiKeyHelper, awsAuthRefresh, awsCredentialExport or otelHeadersHelper). Claude Code runs it as you, and a repository can ship this file.',
    fix: 'Check the command. Remove it unless you wrote it.',
    counted: false,
  },
  'claude-repo-redirect': {
    agent: 'claude-code',
    file: 'settings',
    severity: 'high',
    setting: 'env.ANTHROPIC_BASE_URL',
    title: 'A project settings file sets where Claude Code sends prompts',
    why: 'This file sets ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY, and a repository can ship this file. If it applies, your prompts and code go to the server it names.',
    fix: 'Remove it from this file unless you set it on purpose.',
    counted: false,
  },
  'claude-sandbox-off': {
    agent: 'claude-code',
    file: 'settings',
    severity: 'info',
    setting: 'sandbox.enabled',
    title: 'Claude Code’s own sandbox is off',
    why: 'The sandbox is off by default, so commands run with your full access. A second layer would limit what a wrong decision can do.',
    fix: 'Turn it on with /sandbox in Claude Code if you want it.',
    counted: false,
  },
  'codex-hooks-off': {
    agent: 'codex',
    file: 'config',
    severity: 'critical',
    setting: 'features.hooks',
    title: 'Codex hooks are switched off',
    why: 'With hooks off, Codex never asks Stroq about what it does. A repository file can carry this too.',
    fix: 'Remove hooks = false from the [features] table.',
    counted: false,
  },
  'codex-no-approvals-no-sandbox': {
    agent: 'codex',
    file: 'config',
    severity: 'critical',
    setting: 'approval_policy',
    title: 'Codex runs with no approvals and no sandbox',
    why: 'Approvals are "never" and the sandbox is full access. Nothing asks you and nothing limits what runs.',
    fix: 'Set approval_policy to "on-request" and sandbox_mode to "workspace-write".',
    counted: false,
  },
  'codex-approval-never': {
    agent: 'codex',
    file: 'config',
    severity: 'high',
    setting: 'approval_policy',
    title: 'Codex never asks before acting',
    why: 'approval_policy is "never", so Codex runs what it decides to run without asking you.',
    fix: 'Set approval_policy to "on-request".',
    counted: false,
  },
  'codex-sandbox-full-access': {
    agent: 'codex',
    file: 'config',
    severity: 'high',
    setting: 'sandbox_mode',
    title: 'Codex has no sandbox',
    why: 'sandbox_mode is "danger-full-access" (or the default permission profile is). Commands run with your full access.',
    fix: 'Set sandbox_mode to "workspace-write".',
    counted: false,
  },
  'codex-network-access': {
    agent: 'codex',
    file: 'config',
    severity: 'medium',
    setting: 'sandbox_workspace_write.network_access',
    title: 'Codex commands can reach the network',
    why: 'network_access is true, so commands inside the sandbox can send data out.',
    fix: 'Remove it, or set network_access to false.',
    counted: false,
  },
  'codex-home-trusted': {
    agent: 'codex',
    file: 'config',
    severity: 'high',
    setting: 'projects.<path>.trust_level',
    title: 'Your whole home folder is trusted in Codex',
    why: 'Trusting a folder lets every repository under it load its own Codex settings and hooks. For the home folder or the root, that is every repository you clone.',
    fix: 'Trust individual repositories instead, and set the broad entry to "untrusted".',
    counted: false,
  },
  'codex-approval-retired': {
    agent: 'codex',
    file: 'config',
    severity: 'info',
    setting: 'approval_policy',
    title: 'Codex uses a retired approval setting',
    why: 'approval_policy "untrusted" is retired. Current Codex may ignore it or refuse to start, so what you intended may not apply.',
    fix: 'Use "on-request" or a granular approval policy.',
    counted: false,
  },
  'cursor-unrestricted': {
    agent: 'cursor',
    file: 'cli-config',
    severity: 'high',
    setting: 'approvalMode',
    title: 'Cursor’s command line runs everything',
    why: 'approvalMode is "unrestricted": every command and tool call runs without asking.',
    fix: 'Set approvalMode to "allowlist" or "auto-review".',
    counted: false,
  },
  'cursor-allow-any-shell': {
    agent: 'cursor',
    file: 'cli-config',
    severity: 'high',
    setting: 'permissions.allow',
    title: 'Any shell command is allowed in Cursor',
    why: 'An allow entry such as Shell(*), or one for a shell, an interpreter or curl, runs whatever follows it without asking.',
    fix: 'Allow exact commands, such as Shell(git) or Shell(pnpm).',
    counted: true,
  },
  'cursor-allow-any-web': {
    agent: 'cursor',
    file: 'cli-config',
    severity: 'medium',
    setting: 'permissions.allow',
    title: 'Fetching any web page is allowed in Cursor',
    why: 'WebFetch(*) lets the agent read any address, which is how hidden instructions reach it.',
    fix: 'Allow the domains you use.',
    counted: true,
  },
  'cursor-allow-any-mcp': {
    agent: 'cursor',
    file: 'cli-config',
    severity: 'medium',
    setting: 'permissions.allow',
    title: 'Every MCP tool is allowed in Cursor',
    why: 'Mcp(*:*) lets every tool of every MCP server run without asking.',
    fix: 'Allow the servers and tools you use.',
    counted: true,
  },
  'cursor-sandbox-off': {
    agent: 'cursor',
    file: 'sandbox',
    severity: 'high',
    setting: 'type',
    title: 'Cursor’s sandbox is turned off',
    why: 'sandbox.json sets type "insecure_none", so commands run with your full access. A repository can ship this file.',
    fix: 'Use "workspace_readwrite" or "workspace_readonly".',
    counted: false,
  },
  'cursor-sandbox-network-open': {
    agent: 'cursor',
    file: 'sandbox',
    severity: 'medium',
    setting: 'networkPolicy.default',
    title: 'Cursor’s sandbox allows all network access',
    why: 'networkPolicy.default is "allow", so sandboxed commands can send data to any address.',
    fix: 'Set networkPolicy.default to "deny" and allow the hosts you need.',
    counted: false,
  },
  'cursor-allowlist-wide': {
    agent: 'cursor',
    file: 'permissions',
    severity: 'medium',
    setting: 'terminalAllowlist',
    title: 'Cursor’s allowlist is very wide',
    why: 'permissions.json allows a shell, an interpreter or every MCP tool without asking. A repository can ship this file.',
    fix: 'Allow exact commands and tools only.',
    counted: true,
  },
  'windsurf-allow-any-exec': {
    agent: 'windsurf',
    file: 'devin-config',
    severity: 'medium',
    setting: 'permissions.allow',
    title: 'Any command is allowed in the Devin local agent',
    why: 'An Exec(*) style allow rule runs any command without asking.',
    fix: 'Allow exact commands.',
    counted: true,
  },
} as const satisfies Record<string, PostureEntry>;

export type PostureId = keyof typeof POSTURE_CATALOG;
const IDS = Object.keys(POSTURE_CATALOG) as readonly PostureId[];

export interface CannotCheckEntry {
  readonly title: string;
  readonly why: string;
}

/** Things that matter and live where Stroq cannot read them. Said out loud, so a clean result is not read as complete. */
export const CANNOT_CHECK = {
  'cursor-ide-run-mode': {
    title: 'Cursor’s Run Mode',
    why: 'Whether the Cursor app is set to Run Everything is stored inside the app, not in a file Stroq can read. Check Settings, Agents, Approvals in Cursor.',
  },
  'windsurf-auto-execution': {
    title: 'Windsurf’s terminal auto-execution level',
    why: 'The Auto or Turbo level is stored inside the app, not in a file Stroq can read. Check the Settings panel.',
  },
  'command-line-flags': {
    title: 'Flags used for one run',
    why: 'Flags such as --dangerously-skip-permissions, --yolo and --force apply to one run and leave nothing to read.',
  },
  'managed-settings': {
    title: 'Settings pushed by an organization',
    why: 'Managed settings and requirements files set by an administrator are not read.',
  },
} as const satisfies Record<string, CannotCheckEntry>;

export type CannotCheckId = keyof typeof CANNOT_CHECK;
const CANNOT_IDS = Object.keys(CANNOT_CHECK) as readonly CannotCheckId[];

export interface PostureFinding {
  readonly id: PostureId;
  readonly agent: PostureAgent;
  readonly scope: PostureScope;
  /** How many rules, for findings about broad allow rules; null for every other finding. */
  readonly count: number | null;
}

export type SourceState = 'read' | 'missing' | 'unreadable' | 'oversize' | 'invalid' | 'unsafe';
export const SOURCE_STATES: readonly SourceState[] = [
  'read',
  'missing',
  'unreadable',
  'oversize',
  'invalid',
  'unsafe',
];

export interface PostureSource {
  readonly agent: PostureAgent;
  readonly scope: PostureScope;
  readonly file: PostureFile;
  readonly state: SourceState;
}

export interface PostureAudit {
  readonly schema: 'stroq-posture/1';
  readonly source: 'local';
  readonly generatedAt: string;
  readonly sources: readonly PostureSource[];
  readonly findings: readonly PostureFinding[];
  readonly cannotCheck: readonly CannotCheckId[];
  readonly limitations: readonly string[];
}

export const POSTURE_LIMITATIONS: readonly string[] = [
  'Reads the settings files of Claude Code, Codex, Cursor and Windsurf in your home folder and in this workspace. Nothing is changed and no program is started.',
  'A finding names a setting and where it was found. It does not show the value, the rule text or the path.',
  'It does not work out which setting wins when files disagree, and it does not know whether a repository has been trusted. A setting in a repository file may have no effect until you trust the folder.',
  'No findings means none of the checked settings were found. It does not mean the agent is configured well.',
];

export const MAX_POSTURE_FINDINGS = 64;
export const MAX_POSTURE_SOURCES = 32;

export const POSTURE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  'invalid-request': 'That request could not be read. Reload the page.',
  busy: 'The settings are being read. Try again in a moment.',
  'runtime-unavailable': 'The local engine is not available. Rebuild it and restart the console.',
  'engine-unavailable': 'The local engine is not available. Rebuild it and restart the console.',
};

const validFinding = (v: unknown): v is PostureFinding => {
  if (!closed(v, ['id', 'agent', 'scope', 'count']) || !member(v.id, IDS)) return false;
  const entry: PostureEntry = POSTURE_CATALOG[v.id as PostureId];
  if (v.agent !== entry.agent || !member(v.scope, POSTURE_SCOPES)) return false;
  return entry.counted ? count(v.count, 10_000) && (v.count as number) >= 1 : v.count === null;
};

const validSource = (v: unknown): v is PostureSource =>
  closed(v, ['agent', 'scope', 'file', 'state']) &&
  member(v.agent, POSTURE_AGENTS) &&
  member(v.scope, POSTURE_SCOPES) &&
  member(v.file, POSTURE_FILES) &&
  member(v.state, SOURCE_STATES);

export function validatePostureAudit(v: unknown): v is PostureAudit {
  if (
    !closed(v, [
      'schema',
      'source',
      'generatedAt',
      'sources',
      'findings',
      'cannotCheck',
      'limitations',
    ])
  )
    return false;
  if (
    v.schema !== 'stroq-posture/1' ||
    v.source !== 'local' ||
    !stamp(v.generatedAt) ||
    !list(v.sources, MAX_POSTURE_SOURCES, validSource) ||
    !list(v.findings, MAX_POSTURE_FINDINGS, validFinding) ||
    !list(v.cannotCheck, CANNOT_IDS.length, (item): item is CannotCheckId =>
      member(item, CANNOT_IDS),
    ) ||
    new Set(v.cannotCheck).size !== v.cannotCheck.length ||
    !list(v.limitations, 8, (item): item is string => text(item, 500)) ||
    v.limitations.length === 0
  )
    return false;
  // One finding per setting and place.
  const keys = v.findings.map((f) => `${f.id}/${f.scope}`);
  return new Set(keys).size === keys.length;
}

const RANK: Readonly<Record<PostureSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  info: 3,
};

/** The worst first; a repository-shipped setting before the same one in your own file; then by agent. */
export function postureOrder(findings: readonly PostureFinding[]): PostureFinding[] {
  const shipped = (f: PostureFinding) => (f.scope === 'user' ? 1 : 0);
  return [...findings].sort(
    (a, b) =>
      RANK[POSTURE_CATALOG[a.id].severity] - RANK[POSTURE_CATALOG[b.id].severity] ||
      shipped(a) - shipped(b) ||
      POSTURE_AGENTS.indexOf(a.agent) - POSTURE_AGENTS.indexOf(b.agent) ||
      a.id.localeCompare(b.id),
  );
}

export function postureCounts(
  findings: readonly PostureFinding[],
): Record<PostureSeverity, number> {
  const counts: Record<PostureSeverity, number> = { critical: 0, high: 0, medium: 0, info: 0 };
  for (const finding of findings) counts[POSTURE_CATALOG[finding.id].severity] += 1;
  return counts;
}

/** Where a setting lives, as a fixed label. The person's real paths never reach the page. */
export const POSTURE_LOCATIONS: Readonly<
  Record<PostureAgent, Partial<Record<PostureFile, Readonly<Record<PostureScope, string | null>>>>>
> = {
  'claude-code': {
    settings: {
      user: '~/.claude/settings.json',
      project: '.claude/settings.json',
      local: '.claude/settings.local.json',
    },
  },
  codex: { config: { user: '~/.codex/config.toml', project: '.codex/config.toml', local: null } },
  cursor: {
    'cli-config': { user: '~/.cursor/cli-config.json', project: '.cursor/cli.json', local: null },
    sandbox: { user: '~/.cursor/sandbox.json', project: '.cursor/sandbox.json', local: null },
    permissions: {
      user: '~/.cursor/permissions.json',
      project: '.cursor/permissions.json',
      local: null,
    },
  },
  windsurf: {
    'devin-config': {
      user: '~/.config/devin/config.json',
      project: '.devin/config.json',
      local: '.devin/config.local.json',
    },
  },
};

export const AGENT_NAMES: Readonly<Record<PostureAgent, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
};

export const SCOPE_WORDS: Readonly<Record<PostureScope, string>> = {
  user: 'Your own file',
  project: 'A file in this repository',
  local: 'A local file in this repository',
};

export const SEVERITY_WORDS: Readonly<Record<PostureSeverity, string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  info: 'Note',
};

export const SOURCE_STATE_WORDS: Readonly<Record<SourceState, string>> = {
  read: 'Read',
  missing: 'Not found',
  unreadable: 'Could not be read',
  oversize: 'Too large to read',
  invalid: 'Could not be understood',
  unsafe: 'Skipped: a link, or outside the folder',
};

/** The fixed label of where a file lives, or null when that agent has no such file at that scope. */
export function postureLocation(
  agent: PostureAgent,
  file: PostureFile,
  scope: PostureScope,
): string | null {
  return POSTURE_LOCATIONS[agent][file]?.[scope] ?? null;
}

/**
 * Files that exist but could not be checked: too large, not understood, a link, or not readable.
 * A file that was never there is not one of them. A file that hides its content from the check is the
 * case a hostile repository would choose, so it is always said out loud.
 */
export function uncheckedSources(audit: PostureAudit): readonly PostureSource[] {
  return audit.sources.filter((source) => source.state !== 'read' && source.state !== 'missing');
}

/** The one line the Protection page shows about the settings check, or null when it has nothing to add. */
export function postureStripText(audit: PostureAudit): { serious: boolean; text: string } | null {
  const read = audit.sources.some((source) => source.state === 'read');
  const unchecked = uncheckedSources(audit).length;
  if (!read && unchecked === 0) return null;
  const counts = postureCounts(audit.findings);
  const parts = [
    counts.critical > 0 ? `${counts.critical} critical` : null,
    counts.high > 0 ? `${counts.high} high` : null,
  ].filter((part): part is string => part !== null);
  const n = counts.critical + counts.high;
  const cannot =
    unchecked === 0
      ? ''
      : `${unchecked} settings ${unchecked === 1 ? 'file' : 'files'} could not be checked`;
  if (n > 0) {
    const found = `${parts.join(' and ')} ${n === 1 ? 'setting' : 'settings'} found in your agents’ files`;
    return { serious: true, text: unchecked === 0 ? found : `${found}; ${cannot}` };
  }
  if (unchecked > 0) return { serious: true, text: cannot };
  return { serious: false, text: 'No critical or high settings found in your agents’ files' };
}

/** The key a finding is remembered by between visits: its id and where it was found, never a value. */
export const postureKey = (finding: Pick<PostureFinding, 'id' | 'scope'>): string =>
  `${finding.id}/${finding.scope}`;

const KNOWN_KEYS: ReadonlySet<string> = new Set(
  IDS.flatMap((id) => POSTURE_SCOPES.map((scope) => `${id}/${scope}`)),
);

/** Reads what was stored last time, keeping only keys this catalog could have produced. */
export function parseSeenKeys(stored: unknown): string[] | null {
  if (!Array.isArray(stored) || stored.length > MAX_POSTURE_FINDINGS) return null;
  return stored.filter((key): key is string => typeof key === 'string' && KNOWN_KEYS.has(key));
}

export interface PostureChanges {
  /** Keys present now that were not there at the last check. */
  readonly added: ReadonlySet<string>;
  /** How many findings from the last check are gone. */
  readonly gone: number;
}

/** What changed since the last check, or null when there was no earlier check to compare with. */
export function postureChanges(
  before: readonly string[] | null,
  findings: readonly PostureFinding[],
): PostureChanges | null {
  if (before === null) return null;
  const was = new Set(before);
  const now = new Set(findings.map(postureKey));
  return {
    added: new Set([...now].filter((key) => !was.has(key))),
    gone: [...was].filter((key) => !now.has(key)).length,
  };
}
