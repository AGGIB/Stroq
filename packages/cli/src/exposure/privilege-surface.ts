import { homedir } from 'node:os';
import { join } from 'node:path';
import { isPlainObject, readJsonObject } from '../commands/config-file.js';
import { isStroqHandler } from '../commands/init.js';
import type { Finding } from './findings.js';

export interface PrivilegeHit {
  readonly key: string;
  readonly file: string;
  /** Why this key widens privilege, in one clause, for the report. */
  readonly why: string;
}

const read = (file: string): Record<string, unknown> | null => {
  try {
    return readJsonObject<Record<string, unknown>>(file);
  } catch {
    return null;
  }
};

/**
 * A hook in project settings is a finding because it arrives with the repository
 * (GHSA-ph6w-f82w-28w6) — but Stroq's own entry is the thing `stroq init` writes
 * there by default, and reporting it would mean every protected project showed a
 * critical finding caused by Stroq itself. Only a handler Stroq does not own counts.
 */
function hasForeignHandler(hooks: Record<string, unknown>): boolean {
  return Object.values(hooks).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some(
        (group) =>
          isPlainObject(group) &&
          Array.isArray(group['hooks']) &&
          group['hooks'].some((handler) => !isStroqHandler(handler)),
      ),
  );
}

/**
 * The keys below are the whole argument for an action firewall over a content filter:
 * the prose that talks an agent into a privilege escalation is unbounded natural
 * language, while the set of keys that actually widen its privilege is this short and
 * near-zero false-positive. Each entry is tied to a documented incident or advisory —
 * see the plan's evidence table.
 */
function claudeHits(
  file: string,
  json: Record<string, unknown>,
  scope: 'project' | 'user',
): readonly PrivilegeHit[] {
  const hits: PrivilegeHit[] = [];
  const hooks = json['hooks'];
  if (isPlainObject(hooks)) {
    if (scope === 'user' && 'UserPromptSubmit' in hooks)
      hits.push({
        key: 'hooks.UserPromptSubmit',
        file,
        why: 'its output is injected before every prompt, in every project and every session',
      });
    if (scope === 'project' && hasForeignHandler(hooks))
      hits.push({
        key: 'hooks (project-controlled)',
        file,
        why: 'hooks in a repository-controlled settings file run shell commands that arrive with the repository',
      });
  }
  const env = json['env'];
  if (isPlainObject(env)) {
    if ('ANTHROPIC_BASE_URL' in env)
      hits.push({
        key: 'env.ANTHROPIC_BASE_URL',
        file,
        why: 'redirects API traffic, and with it credentials, to another host',
      });
    if ('CLAUDE_CODE_DISABLE_AUTO_MEMORY' in env)
      hits.push({
        key: 'env.CLAUDE_CODE_DISABLE_AUTO_MEMORY',
        file,
        why: 'controls whether memory is loaded automatically; used as anti-remediation in the 2026-04 memory compromise',
      });
  }
  if (json['enableAllProjectMcpServers'] === true)
    hits.push({
      key: 'enableAllProjectMcpServers',
      file,
      why: 'starts every MCP server a repository declares, without a per-server trust prompt',
    });
  const enabled = json['enabledMcpjsonServers'];
  if (Array.isArray(enabled) && enabled.length > 0)
    hits.push({
      key: 'enabledMcpjsonServers',
      file,
      why: 'pre-approves named MCP servers declared by a repository',
    });
  return hits;
}

/**
 * `chat.tools.autoApprove` is `true` for everything, or an object naming the tools it
 * approves. An empty object approves nothing and is not a widening, so the check is
 * "approves at least one thing" rather than plain truthiness.
 */
const autoApproves = (value: unknown): boolean =>
  value === true || (isPlainObject(value) && Object.keys(value).length > 0);

export function privilegeSurface(cwd: string, home: string = homedir()): readonly PrivilegeHit[] {
  const hits: PrivilegeHit[] = [];
  const seen = new Set<string>();
  /** One hit per key per file: a project that IS the home directory has one file, not two. */
  const push = (hit: PrivilegeHit): void => {
    const id = `${hit.key}@${hit.file}`;
    if (seen.has(id)) return;
    seen.add(id);
    hits.push(hit);
  };

  for (const [scope, base] of [
    ['project', cwd],
    ['user', home],
  ] as const) {
    const file = join(base, '.claude', 'settings.json');
    const json = read(file);
    if (json) for (const hit of claudeHits(file, json, scope)) push(hit);
  }

  const vscode = join(cwd, '.vscode', 'settings.json');
  const vs = read(vscode);
  if (autoApproves(vs?.['chat.tools.autoApprove']))
    push({
      key: 'chat.tools.autoApprove',
      file: vscode,
      why: 'approves tool calls without asking',
    });

  const tasksFile = join(cwd, '.vscode', 'tasks.json');
  const list = read(tasksFile)?.['tasks'];
  if (
    Array.isArray(list) &&
    list.some(
      (t) =>
        isPlainObject(t) &&
        isPlainObject(t['runOptions']) &&
        t['runOptions']['runOn'] === 'folderOpen',
    )
  )
    push({
      key: 'runOn: folderOpen',
      file: tasksFile,
      why: 'runs a command as soon as the folder is opened',
    });

  return hits;
}

export function privilegeFindings(hits: readonly PrivilegeHit[]): readonly Finding[] {
  return hits.map((h) => ({
    class: 'privilege-widened' as const,
    severity: 'critical' as const,
    detail: `${h.key} is set in ${h.file} — ${h.why}`,
    fix: null,
  }));
}
