import { isDeepStrictEqual } from 'node:util';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';
import { snapshotFile, type FileSnapshot, type RootIdentity } from './inventory-observation-files';

export type DeclaredSkillState = 'not-specified' | 'enabled' | 'disabled' | 'unknown';
export interface CapturedCodexSkillConfig {
  status: 'missing' | 'ready' | 'invalid' | 'unavailable' | 'unsupported';
  sha256: string | null;
  markerStatus: 'default' | 'configured' | 'unknown';
  markers: string[];
  rules: { kind: 'path' | 'name'; value: string; enabled: boolean }[];
  ignoredRules: number;
}
export interface CodexSkillConfigCapture {
  configuration: CapturedCodexSkillConfig;
  assertCurrent(): Promise<void>;
}
const CONFIG_BYTES = 256 * 1024;
const MAX_RULES = 512;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);
const trimName = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
const table = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(value) === Object.prototype);
const unknownConfig = (
  status: CapturedCodexSkillConfig['status'],
  sha256: string | null = null,
): CapturedCodexSkillConfig => ({
  status,
  sha256,
  markerStatus: 'unknown',
  markers: [],
  rules: [],
  ignoredRules: 0,
});
export const unavailableCodexSkillConfig = (status: 'unsupported' | 'unavailable') =>
  unknownConfig(status);
function parseConfig(bytes: Buffer | null, sha256: string, base: string): CapturedCodexSkillConfig {
  if (bytes === null)
    return {
      status: 'missing',
      sha256: null,
      markerStatus: 'default',
      markers: ['.git'],
      rules: [],
      ignoredRules: 0,
    };
  let document: Record<string, unknown>;
  try {
    document = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), {
      maxDepth: 32,
      unsafeKeyBehaviour: 'throw',
    });
  } catch {
    return unknownConfig('invalid', sha256);
  }
  const result: CapturedCodexSkillConfig = {
    status: 'ready',
    sha256,
    markerStatus: 'default',
    markers: ['.git'],
    rules: [],
    ignoredRules: 0,
  };
  if (Object.hasOwn(document, 'project_root_markers')) {
    const markers = document.project_root_markers;
    if (!Array.isArray(markers) || markers.some((marker) => typeof marker !== 'string'))
      return unknownConfig('invalid', sha256);
    if (
      markers.length > 32 ||
      markers.some(
        (marker) =>
          !text(marker, 255) ||
          !marker ||
          marker === '.' ||
          marker === '..' ||
          /[\\/]/.test(marker),
      )
    )
      return unknownConfig('unsupported', sha256);
    result.markerStatus = 'configured';
    result.markers = [...new Set(markers as string[])];
  }
  if (document.skills === undefined) return result;
  if (!table(document.skills)) return unknownConfig('invalid', sha256);
  const rules = document.skills.config;
  if (rules === undefined) return result;
  if (!Array.isArray(rules) || rules.length > MAX_RULES) return unknownConfig('invalid', sha256);
  for (const rule of rules) {
    if (
      !table(rule) ||
      typeof rule.enabled !== 'boolean' ||
      (rule.path !== undefined && !text(rule.path, 4096)) ||
      (rule.name !== undefined && !text(rule.name, 2048))
    )
      return unknownConfig('invalid', sha256);
    const path = rule.path as string | undefined;
    const name = rule.name as string | undefined;
    if (
      (path !== undefined) === (name !== undefined) ||
      (name !== undefined && !trimName(name)) ||
      path === ''
    ) {
      result.ignoredRules += 1;
      continue;
    }
    result.rules.push(
      path !== undefined
        ? {
            kind: 'path',
            value: isAbsolute(path) ? resolve(path) : resolve(base, path),
            enabled: rule.enabled,
          }
        : { kind: 'name', value: trimName(name!), enabled: rule.enabled },
    );
  }
  return result;
}
/** Selectors are compared with captured documents only. They never authorize additional filesystem reads. */
export function declaredSkillState(
  config: CapturedCodexSkillConfig,
  item: { path: string; name: string | null; knownPaths?: ReadonlySet<string> },
): DeclaredSkillState {
  if (!['ready', 'missing'].includes(config.status)) return 'unknown';
  // Native rule collection keeps the last occurrence of an identical selector.
  const last = new Map<string, number>();
  config.rules.forEach((rule, index) => last.set(`${rule.kind}\0${rule.value}`, index));
  const rules = config.rules.filter(
    (rule, index) => last.get(`${rule.kind}\0${rule.value}`) === index,
  );
  const evaluate = (name: string | null): Set<DeclaredSkillState> => {
    let states = new Set<DeclaredSkillState>(['not-specified']);
    for (const rule of rules) {
      const next: DeclaredSkillState = rule.enabled ? 'enabled' : 'disabled';
      if (rule.kind === 'path') {
        if (rule.value === item.path) states = new Set([next]);
        // A different canonical captured document cannot alias this document.
        else if (!item.knownPaths?.has(rule.value)) states.add(next);
      } else if (name !== null && rule.value === name) states = new Set([next]);
    }
    return states;
  };
  const possible = evaluate(item.name);
  // A missing valid name may match any one selector, never several distinct names.
  if (item.name === null)
    for (const name of new Set(
      rules.filter((rule) => rule.kind === 'name').map((rule) => rule.value),
    ))
      for (const state of evaluate(name)) possible.add(state);
  return possible.size === 1 ? [...possible][0]! : 'unknown';
}

export function codexSkillConfigSummary(config: CapturedCodexSkillConfig) {
  return {
    status: config.status,
    sha256: config.sha256,
    rules: config.rules.length + config.ignoredRules,
    unmatchedRules: config.ignoredRules,
  };
}
// Refused files still pin the observable path without following a link or reading oversized bytes.
async function refusedConfigPin(root: RootIdentity, file: string, check: () => void) {
  const rel = relative(root.path, file);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return ['outside'];
  const pins: unknown[] = [];
  let at = root.path;
  for (const part of ['', ...rel.split(sep)]) {
    check();
    if (part) at = join(at, part);
    try {
      const stat = await lstat(at);
      const identity = { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
      pins.push(
        stat.isDirectory()
          ? identity
          : {
              ...identity,
              nlink: stat.nlink,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              ctimeMs: stat.ctimeMs,
            },
      );
      if (stat.isSymbolicLink() || !stat.isDirectory()) break;
    } catch (error: unknown) {
      pins.push((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable');
      break;
    }
  }
  return pins;
}
export async function captureCodexSkillConfig(options: {
  root: RootIdentity;
  path: string;
  deadline?: number;
}): Promise<CodexSkillConfigCapture> {
  const check = () => {
    if (options.deadline !== undefined && Date.now() > options.deadline)
      throw new Error('deadline');
  };
  let before: FileSnapshot;
  try {
    check();
    before = await snapshotFile(options.root, options.path, CONFIG_BYTES);
    check();
  } catch {
    const pin = await refusedConfigPin(options.root, options.path, check);
    return {
      configuration: unknownConfig('unavailable'),
      async assertCurrent() {
        if (!isDeepStrictEqual(pin, await refusedConfigPin(options.root, options.path, check)))
          throw new Error('changed-context');
        check();
      },
    };
  }
  const configuration = parseConfig(before.bytes, before.sha256, dirname(options.path));
  return {
    configuration,
    async assertCurrent() {
      check();
      try {
        const after = await snapshotFile(options.root, options.path, CONFIG_BYTES);
        if (!isDeepStrictEqual(before, after)) throw new Error();
      } catch {
        throw new Error('changed-context');
      }
      check();
    },
  };
}
