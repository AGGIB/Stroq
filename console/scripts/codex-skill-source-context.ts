import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { rootIdentity, type RootIdentity } from './inventory-observation-files';
import {
  captureCodexSkillConfig,
  unavailableCodexSkillConfig,
  type CapturedCodexSkillConfig,
} from './codex-skill-source-config';

export interface CodexSkillSourceContextOptions {
  project: string;
  userHome: string;
  codexEnvironment?: { CODEX_HOME?: string };
  deadline?: number;
}
type MarkerPin = {
  path: string;
  state: 'absent' | 'file' | 'directory' | 'unsafe' | 'unreadable';
  identity?: Record<string, number>;
};
export interface CodexSkillSourceContext {
  project: RootIdentity;
  userHome: RootIdentity;
  profile: {
    status: 'default' | 'custom' | 'unverified';
    path: string | null;
    reason: 'custom-profile-unsupported' | null;
  };
  controlContextId: string | null;
  configuration: CapturedCodexSkillConfig;
  ancestry: {
    status: 'bounded' | 'cwd-only' | 'uncertain' | 'limit';
    boundary: string;
    parents: RootIdentity[];
    reason:
      | 'marker-unreadable'
      | 'marker-unsafe'
      | 'ancestor-limit'
      | 'config-invalid'
      | 'config-unavailable'
      | 'custom-profile-unsupported'
      | null;
  };
  sources: {
    path: string;
    family: 'agents' | 'codex-legacy';
    scope: 'repo' | 'user';
    depth: number;
    root: RootIdentity;
  }[];
  assertCurrent(): Promise<void>;
}
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
};
function checkDeadline(deadline?: number) {
  if (deadline !== undefined && Date.now() > deadline) throw new Error('deadline');
}
async function canonicalRoot(path: string) {
  const root = await rootIdentity(path);
  if (root.path !== path || !isAbsolute(path)) throw new Error('changed-context');
  return root;
}
async function markerPin(path: string): Promise<MarkerPin> {
  try {
    const stat = await lstat(path);
    const identity = {
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      mode: stat.mode,
      nlink: stat.nlink,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
    return {
      path,
      state: stat.isSymbolicLink()
        ? 'unsafe'
        : stat.isFile()
          ? 'file'
          : stat.isDirectory()
            ? 'directory'
            : 'unsafe',
      identity,
    };
  } catch (error: unknown) {
    return {
      path,
      state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable',
    };
  }
}
async function customProfile(user: RootIdentity, path: string) {
  if (path.length > 4096 || !isAbsolute(path) || !inside(user.path, path)) return null;
  const normalized = resolve(path);
  // Every component must be a directory in the selected canonical user tree.
  let at = user.path;
  for (const part of relative(user.path, normalized).split(sep).filter(Boolean)) {
    at = join(at, part);
    if ((await canonicalRoot(at)).path !== at) return null;
  }
  return normalized;
}
/** A bounded declaration preview; no Git, client, skill body, plugin or configuration command executes. */
export async function captureCodexSkillSourceContext(
  options: CodexSkillSourceContextOptions,
): Promise<CodexSkillSourceContext> {
  const check = () => checkDeadline(options.deadline);
  check();
  let project: RootIdentity;
  let userHome: RootIdentity;
  try {
    [project, userHome] = await Promise.all([
      canonicalRoot(options.project),
      canonicalRoot(options.userHome),
    ]);
  } catch {
    throw new Error('changed-context');
  }
  const rootPins: RootIdentity[] = [project, userHome];
  const rawProfile = options.codexEnvironment?.CODEX_HOME;
  let profile: CodexSkillSourceContext['profile'] = {
    status: 'default',
    path: join(userHome.path, '.codex'),
    reason: null,
  };
  if (rawProfile !== undefined && rawProfile !== '') {
    let path: string | null = null;
    try {
      if (typeof rawProfile === 'string' && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(rawProfile))
        path = await customProfile(userHome, rawProfile);
    } catch {
      path = null;
    }
    profile = path
      ? { status: 'custom', path, reason: null }
      : { status: 'unverified', path: null, reason: 'custom-profile-unsupported' };
    if (path) rootPins.push(await canonicalRoot(path));
  }
  check();
  const captured =
    profile.path === null
      ? {
          configuration: unavailableCodexSkillConfig('unsupported'),
          assertCurrent: async () => {
            check();
          },
        }
      : await captureCodexSkillConfig({
          root: userHome,
          path: join(profile.path, 'config.toml'),
          deadline: options.deadline,
        });
  const configuration = captured.configuration;
  const ancestry: CodexSkillSourceContext['ancestry'] = {
    status: 'cwd-only',
    boundary: project.path,
    parents: [project],
    reason: null,
  };
  const markers: MarkerPin[] = [];
  if (configuration.markerStatus === 'unknown') {
    ancestry.status = 'uncertain';
    ancestry.reason =
      profile.reason ??
      (configuration.status === 'unavailable' ? 'config-unavailable' : 'config-invalid');
  } else if (configuration.markers.length) {
    let current = project;
    for (let depth = 0; depth < 32; depth += 1) {
      check();
      if (depth > 0) ancestry.parents.push(current);
      let found = false;
      for (const marker of configuration.markers) {
        const pin = await markerPin(join(current.path, marker));
        markers.push(pin);
        check();
        if (pin.state === 'unsafe' || pin.state === 'unreadable') {
          ancestry.status = 'uncertain';
          ancestry.reason = pin.state === 'unsafe' ? 'marker-unsafe' : 'marker-unreadable';
          break;
        }
        if (pin.state === 'file' || pin.state === 'directory') found = true;
      }
      if (ancestry.status === 'uncertain') break;
      if (found) {
        ancestry.status = 'bounded';
        ancestry.boundary = current.path;
        break;
      }
      const parent = dirname(current.path);
      if (parent === current.path) break;
      if (depth === 31) {
        ancestry.status = 'limit';
        ancestry.reason = 'ancestor-limit';
        break;
      }
      try {
        current = await canonicalRoot(parent);
      } catch {
        ancestry.status = 'uncertain';
        ancestry.reason = 'marker-unreadable';
        break;
      }
    }
  }
  rootPins.push(...ancestry.parents);
  const selected = ancestry.status === 'bounded' ? ancestry.parents : [project];
  const sources: CodexSkillSourceContext['sources'] = selected.flatMap((root, depth) =>
    (['agents', 'codex-legacy'] as const).map((family) => ({
      path: join(root.path, family === 'agents' ? '.agents' : '.codex', 'skills'),
      family,
      scope: 'repo' as const,
      depth,
      root,
    })),
  );
  const userSources: CodexSkillSourceContext['sources'] = [
    {
      path: join(userHome.path, '.agents', 'skills'),
      family: 'agents',
      scope: 'user',
      depth: 0,
      root: userHome,
    },
  ];
  if (profile.path !== null)
    userSources.push({
      path: join(profile.path, 'skills'),
      family: 'codex-legacy',
      scope: 'user',
      depth: 0,
      root: userHome,
    });
  const selectedUserPaths = new Set<string>();
  for (const source of userSources) {
    // A selected data-directory route may coincide with a shared-skill root.
    // Capture an identical path once; user scope wins and the first user route stays stable.
    if (selectedUserPaths.has(source.path)) continue;
    selectedUserPaths.add(source.path);
    const duplicate = sources.findIndex((candidate) => candidate.path === source.path);
    if (duplicate >= 0) sources.splice(duplicate, 1);
    sources.push(source);
  }
  const context: CodexSkillSourceContext = {
    project,
    userHome,
    profile,
    controlContextId:
      profile.path === null
        ? null
        : `codex-context-${createHash('sha256')
            .update(
              `stroq-codex-control-context/1\0${userHome.path}\0${profile.path}\0${join(profile.path, 'config.toml')}`,
            )
            .digest('hex')}`,
    configuration,
    ancestry,
    sources,
    async assertCurrent() {
      check();
      try {
        for (const pin of rootPins) {
          check();
          if (!isDeepStrictEqual(await canonicalRoot(pin.path), pin)) throw new Error();
        }
        for (const pin of markers) {
          check();
          if (!isDeepStrictEqual(await markerPin(pin.path), pin)) throw new Error();
        }
        await captured.assertCurrent();
      } catch (error: unknown) {
        if ((error as Error).message === 'deadline') throw error;
        throw new Error('changed-context');
      }
      check();
    },
  };
  await context.assertCurrent();
  return context;
}
