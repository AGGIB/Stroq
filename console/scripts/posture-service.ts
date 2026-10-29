import { realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  CANNOT_CHECK,
  POSTURE_LIMITATIONS,
  postureOrder,
  validatePostureAudit,
  type CannotCheckId,
  type PostureAudit,
  type PostureFile,
  type PostureFinding,
  type PostureAgent,
  type PostureScope,
  type PostureSource,
} from '../lib/posture';
import {
  analyzeClaudeSettings,
  analyzeCodexConfig,
  analyzeCursorCli,
  analyzeCursorPermissions,
  analyzeCursorSandbox,
  analyzeDevinConfig,
  claudeSandboxSetting,
} from './posture-analyzers';
import { readSettingsFile, type SettingsFormat } from './posture-reader';

type Response = { status: number; body: unknown };

interface Dependencies {
  /** Your home folder. */
  readonly userHome: string;
  /** The workspace the console was started for. */
  readonly project: string;
  /** `CODEX_HOME` when set, which moves Codex's folder out of the home folder. */
  readonly codexHome?: string | null;
  readonly now?: () => Date;
}

interface Place {
  readonly agent: PostureAgent;
  readonly scope: PostureScope;
  readonly file: PostureFile;
  readonly format: SettingsFormat;
  readonly path: string;
  readonly confineTo: string | null;
  readonly analyze: (value: unknown) => PostureFinding[];
}

const ALL_CANNOT_CHECK = Object.keys(CANNOT_CHECK) as CannotCheckId[];

/** The fixed list of files looked at. Nothing the browser sends picks a path. */
function placesOf({ userHome, project, codexHome }: Dependencies): Place[] {
  const user = (...parts: string[]) => join(userHome, ...parts);
  const repo = (...parts: string[]) => join(project, ...parts);
  const codexFolder = codexHome && isAbsolute(codexHome) ? codexHome : user('.codex');
  const mine = (scope: PostureScope) => (scope === 'user' ? null : project);
  const place = (
    agent: PostureAgent,
    scope: PostureScope,
    file: PostureFile,
    format: SettingsFormat,
    path: string,
    analyze: (value: unknown) => PostureFinding[],
  ): Place => ({ agent, scope, file, format, path, confineTo: mine(scope), analyze });
  return [
    place('claude-code', 'user', 'settings', 'json', user('.claude', 'settings.json'), (v) =>
      analyzeClaudeSettings(v, 'user'),
    ),
    place('claude-code', 'project', 'settings', 'json', repo('.claude', 'settings.json'), (v) =>
      analyzeClaudeSettings(v, 'project'),
    ),
    place('claude-code', 'local', 'settings', 'json', repo('.claude', 'settings.local.json'), (v) =>
      analyzeClaudeSettings(v, 'local'),
    ),
    place('codex', 'user', 'config', 'toml', join(codexFolder, 'config.toml'), (v) =>
      analyzeCodexConfig(v, 'user', { userHome }),
    ),
    place('codex', 'project', 'config', 'toml', repo('.codex', 'config.toml'), (v) =>
      analyzeCodexConfig(v, 'project', { userHome }),
    ),
    place('cursor', 'user', 'cli-config', 'json', user('.cursor', 'cli-config.json'), (v) =>
      analyzeCursorCli(v, 'user'),
    ),
    place('cursor', 'project', 'cli-config', 'json', repo('.cursor', 'cli.json'), (v) =>
      analyzeCursorCli(v, 'project'),
    ),
    place('cursor', 'user', 'sandbox', 'json', user('.cursor', 'sandbox.json'), (v) =>
      analyzeCursorSandbox(v, 'user'),
    ),
    place('cursor', 'project', 'sandbox', 'json', repo('.cursor', 'sandbox.json'), (v) =>
      analyzeCursorSandbox(v, 'project'),
    ),
    place('cursor', 'user', 'permissions', 'json', user('.cursor', 'permissions.json'), (v) =>
      analyzeCursorPermissions(v, 'user'),
    ),
    place('cursor', 'project', 'permissions', 'json', repo('.cursor', 'permissions.json'), (v) =>
      analyzeCursorPermissions(v, 'project'),
    ),
    place(
      'windsurf',
      'user',
      'devin-config',
      'json',
      user('.config', 'devin', 'config.json'),
      (v) => analyzeDevinConfig(v, 'user'),
    ),
    place('windsurf', 'project', 'devin-config', 'json', repo('.devin', 'config.json'), (v) =>
      analyzeDevinConfig(v, 'project'),
    ),
    place('windsurf', 'local', 'devin-config', 'json', repo('.devin', 'config.local.json'), (v) =>
      analyzeDevinConfig(v, 'local'),
    ),
  ];
}

/** One finding per setting and place; if two files give the same one, the counts add. */
function merged(findings: readonly PostureFinding[]): PostureFinding[] {
  const byKey = new Map<string, PostureFinding>();
  for (const found of findings) {
    const key = `${found.id}/${found.scope}`;
    const before = byKey.get(key);
    byKey.set(
      key,
      before === undefined || before.count === null || found.count === null
        ? (before ?? found)
        : { ...before, count: Math.min(10_000, before.count + found.count) },
    );
  }
  return [...byKey.values()];
}

/**
 * Reads the settings files of the supported agents and reports which weakening settings they hold.
 * Read-only: nothing is written, no program is started, and the reply holds only ids and counts.
 */
export function createPostureService(dependencies: Dependencies) {
  const now = dependencies.now ?? (() => new Date());
  const places = placesOf(dependencies);
  let inFlight: Promise<Response> | null = null;

  /** When the workspace is the home folder, its files are your own files, not a repository's. */
  async function sameAsHome(): Promise<boolean> {
    try {
      const [project, home] = await Promise.all([
        realpath(dependencies.project),
        realpath(dependencies.userHome),
      ]);
      return project === home;
    } catch {
      return false;
    }
  }

  async function run(): Promise<Response> {
    const skipProject = await sameAsHome();
    const checked = places.filter((place) => !(skipProject && place.confineTo !== null));
    const reads = await Promise.all(checked.map((place) => readSettingsFile(place)));
    const sources: PostureSource[] = [];
    const found: PostureFinding[] = [];
    const sandbox: Partial<Record<PostureScope, boolean>> = {};
    checked.forEach((place, index) => {
      const read = reads[index];
      if (read === undefined) return;
      sources.push({ agent: place.agent, scope: place.scope, file: place.file, state: read.state });
      if (read.state !== 'read') return;
      found.push(...place.analyze(read.value));
      if (place.agent !== 'claude-code') return;
      const setting = claudeSandboxSetting(read.value);
      if (setting !== undefined) sandbox[place.scope] = setting;
    });
    // The sandbox setting that wins is the most local one that says anything.
    const winner: PostureScope | null =
      (['local', 'project', 'user'] as const).find((scope) => sandbox[scope] !== undefined) ?? null;
    const sandboxOn = winner !== null && sandbox[winner] === true;
    const withSandbox: PostureFinding[] = found.filter(
      (finding) => !(sandboxOn && finding.id === 'claude-sandbox-off'),
    );
    if (winner !== null && !sandboxOn && winner !== 'user')
      withSandbox.push({
        id: 'claude-sandbox-off',
        agent: 'claude-code',
        scope: winner,
        count: null,
      });
    const body: PostureAudit = {
      schema: 'stroq-posture/1',
      source: 'local',
      generatedAt: now().toISOString(),
      sources,
      findings: postureOrder(merged(withSandbox)),
      cannotCheck: ALL_CANNOT_CHECK,
      limitations: [...POSTURE_LIMITATIONS],
    };
    if (!validatePostureAudit(body)) return { status: 500, body: { error: 'engine-unavailable' } };
    return { status: 200, body };
  }

  /** Requests that arrive while a read is under way share it; each read opens up to 14 files. */
  function audit(): Promise<Response> {
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return { audit, close: async () => {} };
}
