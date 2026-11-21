import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isPlainObject } from '../commands/config-file.js';
import { parseToml } from '../exposure/toml-lite.js';
import { readTargetStrict } from '../harden/read.js';
import { BASE_PATHS, KEY_PATHS } from './rules.js';
import {
  claudeSandboxStatus,
  hasClaudeSettings,
  readSettingsObject,
  sandboxSummary,
  type ClaudeSandboxStatus,
  type SandboxLocation,
} from './status.js';

function codexStatus(where: SandboxLocation): string {
  const file = join(where.env.CODEX_HOME || join(where.home, '.codex'), 'config.toml');
  try {
    const text = readTargetStrict(file);
    const doc = parseToml(text ?? '')?.doc;
    if (!doc) throw new Error();
    const profile = doc.default_permissions;
    const mode = doc.sandbox_mode;
    if (profile !== undefined && (mode !== undefined || doc.sandbox_workspace_write !== undefined))
      return 'User config mixes permission profiles and legacy sandbox settings. Check which configuration the CLI accepts.';
    if (profile === undefined) {
      if (mode === 'danger-full-access') return 'User config selects full access.';
      if (mode === 'workspace-write' || mode === 'read-only')
        return 'User config selects ' + mode + ' mode without per-path deny rules.';
      if (mode !== undefined) throw new Error();
      return 'User config has no explicit sandbox mode or permission profile.';
    }
    if (profile === ':danger-full-access') return 'User config selects full access.';
    if (profile === ':workspace' || profile === ':read-only')
      return 'User config selects the built-in ' + profile + ' permission profile.';
    if (
      typeof profile !== 'string' ||
      !isPlainObject(doc.permissions) ||
      !Object.hasOwn(doc.permissions, profile)
    )
      throw new Error();
    const selected = doc.permissions[profile];
    if (!isPlainObject(selected)) throw new Error();
    const fs = selected.filesystem ?? {};
    if (!isPlainObject(fs)) throw new Error();
    const count = KEY_PATHS.filter(
      (key) => fs[key] === 'deny' || fs[join(where.home, key.slice(2))] === 'deny',
    ).length;
    return (
      'Selected user profile directly lists ' +
      count +
      '/' +
      KEY_PATHS.length +
      ' key paths with deny access.'
    );
  } catch {
    return 'Codex user sandbox settings could not be assessed.';
  }
}

function cursorStatus(where: SandboxLocation): string {
  try {
    const user = readSettingsObject(join(where.home, '.cursor/sandbox.json'));
    const project = readSettingsObject(join(where.cwd, '.cursor/sandbox.json'));
    const mode = Object.hasOwn(project, 'type') ? project.type : user.type;
    const boundary = Object.hasOwn(project, 'readBoundary')
      ? project.readBoundary
      : user.readBoundary;
    if (mode === 'insecure_none') return 'sandbox.json requests an unsandboxed run.';
    if (mode !== undefined && mode !== 'workspace_readwrite' && mode !== 'workspace_readonly')
      throw new Error();
    if (boundary === undefined)
      return 'No read boundary set in sandbox.json. Check the run mode in Cursor.';
    if (boundary !== 'workspace' && boundary !== 'system') throw new Error();
    return (
      'The ' +
      (project.readBoundary === undefined ? 'user' : 'project') +
      ' sandbox.json sets ' +
      boundary +
      ' read access. Individual key-file denies are unavailable.'
    );
  } catch {
    return 'Cursor sandbox settings could not be assessed.';
  }
}

export const CODEX_EXAMPLE = [
  '# Example for a new profile. Adapt your current profile if you already use one.',
  '# Select this at the top level, separately from legacy sandbox_mode or sandbox_workspace_write.',
  'default_permissions = "stroq-keys"',
  '[permissions.stroq-keys]',
  'extends = ":workspace"',
  '[permissions.stroq-keys.filesystem]',
  ...BASE_PATHS.map((path) => '"' + path + '" = "deny"'),
].join('\n');

export interface SandboxReport {
  readonly agent: 'claude-code' | 'codex' | 'cursor';
  readonly detail: string;
  readonly claude?: ClaudeSandboxStatus;
}

export function sandboxReports(where: SandboxLocation, all: boolean): SandboxReport[] {
  const reports: SandboxReport[] = [];
  if (all || hasClaudeSettings(where)) {
    const claude = claudeSandboxStatus(where);
    reports.push({
      agent: 'claude-code',
      claude,
      detail: sandboxSummary(claude),
    });
  }
  if (
    all ||
    existsSync(where.env.CODEX_HOME || join(where.home, '.codex')) ||
    existsSync(join(where.cwd, '.codex'))
  ) {
    reports.push({
      agent: 'codex',
      detail:
        codexStatus(where) +
        ' Project settings, flags and admin policy can change the running session.',
    });
  }
  if (all || existsSync(join(where.home, '.cursor')) || existsSync(join(where.cwd, '.cursor'))) {
    reports.push({
      agent: 'cursor',
      detail: cursorStatus(where) + ' The app run mode and team policy can change access.',
    });
  }
  return reports;
}
