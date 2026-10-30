import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Server-owned discovery roots. Kept free of detector/core imports in this control bundle.
export const INVENTORY_MONITOR_SKILL_ROOTS = [
  { project: '.claude/skills', user: '.claude/skills' },
  { project: '.agents/skills', user: '.agents/skills' },
  { project: '.codex/skills', user: '.codex/skills' },
  { project: '.cursor/skills', user: '.cursor/skills' },
  { project: '.windsurf/skills', user: '.codeium/windsurf/skills' },
  { project: '.devin/skills', user: '.config/devin/skills' },
] as const;

/** Match effective MCP source selection without retaining its raw environment values. */
export function inventorySourceProfileSha256(
  userHome: string,
  environment: Readonly<Record<string, string | undefined>> = {},
  platform: NodeJS.Platform = process.platform,
) {
  const base = (setting: string | undefined, fallback: string) => {
    if (setting === undefined || setting === '') return join(userHome, fallback);
    if (setting.length > 4096 || !isAbsolute(setting) || /[\u0000-\u001f\u007f]/.test(setting))
      return null;
    const selected = resolve(setting),
      rel = relative(userHome, selected);
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : selected;
  };
  return createHash('sha256')
    .update(
      JSON.stringify({
        schema: 'stroq-inventory-source-profile/1',
        platform,
        appData:
          platform === 'win32' ? base(environment.APPDATA, join('AppData', 'Roaming')) : null,
        xdg: platform === 'win32' ? null : base(environment.XDG_CONFIG_HOME, '.config'),
      }),
    )
    .digest('hex');
}
async function canonicalFuture(path: string) {
  let at = resolve(path);
  const suffix: string[] = [];
  for (let depth = 0; depth < 128; depth++) {
    try {
      return join(await realpath(at), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(at) === at) throw error;
      suffix.push(basename(at));
      at = dirname(at);
    }
  }
  throw new Error('context-unavailable');
}
export async function assertInventoryMonitorContext({
  home,
  roots,
}: {
  home: string;
  roots: { project: { path: string }; user: { path: string } };
}) {
  try {
    const selected = [resolve(home), await canonicalFuture(home)];
    const scopes =
      roots.project.path === roots.user.path ? (['user'] as const) : (['project', 'user'] as const);
    for (const source of INVENTORY_MONITOR_SKILL_ROOTS)
      for (const scope of scopes) {
        const sourceRoot = join(roots[scope].path, source[scope]);
        if (
          selected.some((path) => {
            const rel = relative(sourceRoot, path);
            return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
          })
        )
          throw new Error('context-unavailable');
      }
  } catch {
    throw new Error('context-unavailable');
  }
}
