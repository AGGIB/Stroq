import { posix } from 'node:path';
import { readYaml } from '../policy/yaml.js';
import { settle, type TaggedHit } from './agent-change.js';
import { lintStagedRuns } from './agent-editor.js';
import { boundedJson, hit } from './agent-kinds.js';
import { foldName } from './git-dir-names.js';

/**
 * lint-staged's own config files, wherever they are in the tree: what a commit runs, read as the
 * `lint-staged` key of package.json is (see `lintStagedRuns`), so a change to a file one of them
 * runs fails. The JSON and YAML forms are read; one that does not parse, cannot be read or is a
 * link is not, and neither is one written as code (`lint-staged.config.js`, `.lintstagedrc.mjs`),
 * which only running it would tell: while one of those is there, any change at all fails.
 */

/** Every lint-staged config, by its folded base name. */
const CONFIG = /^(?:\.lintstagedrc(?:\..*)?|lint-staged\.config\..*)$/;
/** The forms read as data: JSON, YAML, and the bare name, which lint-staged reads as YAML. */
const DATA = /^\.lintstagedrc(?:\.json|\.ya?ml)?$/;
/** The most lint-staged configs one check reads; past them, one finding fails. */
const MAX_CONFIGS = 64;

/** Whether a path of the tree is a lint-staged config. */
export const isLintStagedConfig = (path: string): boolean =>
  CONFIG.test(foldName(posix.basename(path)));

/** The value of a data config's text, or undefined when it does not parse. */
function valueOf(name: string, text: string): { readonly value: unknown } | undefined {
  if (name.endsWith('.json')) {
    try {
      return { value: JSON.parse(text) as unknown };
    } catch {
      return undefined;
    }
  }
  const read = readYaml(text);
  return read.ok ? { value: read.value } : undefined;
}

/**
 * The run entries of the lint-staged configs at `paths` of the head, and the findings for those not
 * read, which fail when the change touches anything (`anyChange`). `read` gives the texts of the
 * paths it can read as plain files within the size cap.
 */
export function lintStagedConfigs(
  paths: readonly string[],
  read: (paths: readonly string[]) => ReadonlyMap<string, string>,
  anyChange: boolean,
): { readonly entries: TaggedHit[]; readonly hits: TaggedHit[] } {
  const entries: TaggedHit[] = [];
  const hits: TaggedHit[] = [];
  const unread = (path: string, why: string): void => {
    if (anyChange) hits.push(settle(hit('unreadable-config', path, 1, 'lint-staged', why), 'new'));
  };
  const cut = paths[MAX_CONFIGS];
  if (cut !== undefined)
    unread(cut, `${paths.length - MAX_CONFIGS} more lint-staged configs were not read`);
  const now = paths.slice(0, MAX_CONFIGS);
  const texts = read(now.filter((p) => DATA.test(foldName(posix.basename(p)))));
  for (const path of now) {
    const name = foldName(posix.basename(path));
    if (!DATA.test(name)) {
      unread(path, 'lint-staged config in code, not read, so what a commit runs is not known');
      continue;
    }
    const text = texts.get(path);
    const parsed = text === undefined ? undefined : valueOf(name, text);
    if (parsed === undefined) {
      unread(path, 'lint-staged config not read, so what a commit runs is not known');
      continue;
    }
    entries.push({
      ...hit('git-hook-file', path, 1, 'lint-staged', boundedJson(parsed.value, undefined, true)),
      severity: 'warning',
      status: 'present',
      runs: lintStagedRuns(parsed.value),
    });
  }
  return { entries, hits };
}
