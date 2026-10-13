import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const canonical = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};

function ancestorSources(
  project: string,
  homes: ReadonlySet<string>,
  platform: NodeJS.Platform,
): string[] {
  const sources: string[] = [];
  for (let parent = resolve(project); ; parent = dirname(parent)) {
    const folder = join(parent, '.codex');
    const compared = platform === 'win32' ? folder.toLowerCase() : folder;
    if (!homes.has(compared)) sources.push(join(folder, 'hooks.json'), join(folder, 'config.toml'));
    if (dirname(parent) === parent) return sources;
  }
}

/** --ignore-user-config leaves an empty user layer; its adjacent hooks.json can still load. */
export function codexHookSources(
  env: Record<string, string>,
  project: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const home =
    platform === 'win32' ? (env['USERPROFILE'] ?? homedir()) : (env['HOME'] ?? homedir());
  const codexHome = resolve(env['CODEX_HOME'] ?? join(home, '.codex'));
  const homes = new Set(
    [codexHome, canonical(codexHome)].map((path) =>
      platform === 'win32' ? path.toLowerCase() : path,
    ),
  );
  const system =
    platform === 'win32'
      ? join(env['ProgramData'] ?? 'C:\\ProgramData', 'OpenAI', 'Codex')
      : '/etc/codex';
  const sources = [
    join(codexHome, 'hooks.json'),
    ...['hooks.json', 'config.toml', 'requirements.toml', 'managed_config.toml'].map((file) =>
      join(system, file),
    ),
  ];
  if (platform === 'darwin')
    sources.push(
      '/Library/Managed Preferences/com.openai.codex.plist',
      join(home, 'Library', 'Managed Preferences', 'com.openai.codex.plist'),
    );
  return [
    ...sources,
    ...ancestorSources(project, homes, platform),
    ...ancestorSources(canonical(project), homes, platform),
  ];
}

/** Refuse rather than merge a source the CLI cannot reliably exclude. Never read its contents. */
export function codexIsolationProblem(
  env: Record<string, string>,
  project: string,
  inspect: (path: string) => unknown = lstatSync,
): string | null {
  if (env['CODEX_HOME'] !== undefined && !isAbsolute(env['CODEX_HOME']))
    return 'Codex home must be an absolute path to inspect hook sources safely; no inference request was made';
  try {
    realpathSync.native(project);
  } catch {
    return 'Codex project real path could not be established; no inference request was made';
  }
  for (const source of codexHookSources(env, project)) {
    try {
      inspect(source);
      return 'Codex has another hook or managed configuration source; it cannot be isolated safely, so no inference request was made';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return 'Codex hook sources could not be inspected safely; no inference request was made';
    }
  }
  return null;
}
