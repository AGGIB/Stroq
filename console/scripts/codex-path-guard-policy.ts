import { resolve, isAbsolute } from 'node:path';
import { mergeGuardTables, resolveGuardProfile, table } from './codex-network-guard-parse.ts';
import type { CodexPathGuardError, CodexPathGuardCapture } from '../lib/codex-path-guard.ts';

export type PathGuardPolicyInput = {
  persistent: Record<string, any>;
  user: Record<string, any>;
  projects: Record<string, any>[];
  home: string;
  project: string;
  temporary: { tmpdir: string | null; slashTmp: string | null };
};
type Access = 'read' | 'write' | 'deny';
type Rule = { path: string; mode: Access; glob: boolean };
const access = (v: unknown): v is Access => ['read', 'write', 'deny'].includes(v as string);
const within = (path: string, parent: string) =>
  path === parent || path.startsWith(parent === '/' ? '/' : parent + '/');
const wildcard = /[\*\?\[\]\{\}]/;
const fail = (code = 'unsupported'): never => {
  throw Error('codex-path-guard-' + code);
};
function absolute(path: string, input: PathGuardPolicyInput) {
  const expanded =
    path === '~' ? input.home : path.startsWith('~/') ? input.home + path.slice(1) : path;
  if (
    !isAbsolute(expanded) ||
    /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(expanded) ||
    expanded.split('/').some((p) => p === '..' || p === '.')
  )
    return fail();
  return resolve(expanded);
}
function graph(document: Record<string, any>, name: string) {
  if (name === 'filesystem') return fail();
  const resolved = resolveGuardProfile(document, name),
    names: string[] = [];
  let builtin: string | null = null,
    at = name;
  for (let i = 0; i <= 16; i++) {
    if ([':workspace', ':read-only'].includes(at)) {
      builtin = at;
      break;
    }
    if (at === 'filesystem' || names.includes(at) || !table(document.permissions?.[at]))
      return fail('parent-unavailable');
    names.push(at);
    const parent = document.permissions[at].extends;
    if (parent === undefined) break;
    if (typeof parent !== 'string' || i === 16) return fail('parent-unavailable');
    at = parent;
  }
  return { resolved, names, builtin };
}
function roots(input: PathGuardPolicyInput, profile: Record<string, any>, key: string): string[] {
  if (key === ':root') return ['/'];
  if (key === ':minimal') return [];
  if (key === ':tmpdir' || key === ':slash_tmp') {
    const path = key === ':tmpdir' ? input.temporary.tmpdir : input.temporary.slashTmp;
    return path ? [path] : [];
  }
  if (key === ':workspace_roots')
    return [
      input.project,
      ...Object.entries(profile.workspace_roots ?? {})
        .filter(([, v]) => v === true)
        .map(([p]) => absolute(p, input)),
    ];
  if (key.startsWith(':')) return fail();
  return [absolute(key, input)];
}
function rules(input: PathGuardPolicyInput, profile: Record<string, any>): Rule[] {
  const fs = profile.filesystem;
  if (fs === undefined) return [];
  if (!table(fs) || Object.keys(fs).length > 1024) return fail();
  const result: Rule[] = [];
  for (const [key, value] of Object.entries(fs)) {
    if (key === 'glob_scan_max_depth') {
      if (
        !['bigint', 'number'].includes(typeof value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < 1 ||
        Number(value) > 64
      )
        return fail();
      continue;
    }
    const outer = roots(input, profile, key);
    if (access(value))
      for (const path of outer) result.push({ path, mode: value, glob: wildcard.test(path) });
    else {
      if (!table(value)) return fail();
      for (const [sub, mode] of Object.entries(value)) {
        if (
          !access(mode) ||
          !sub ||
          sub.startsWith('/') ||
          sub.split('/').includes('..') ||
          (sub !== '.' && sub.split('/').includes('.')) ||
          /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(sub)
        )
          return fail();
        if (key !== ':workspace_roots' && key.startsWith(':') && sub !== '.') return fail();
        for (const parent of outer) {
          const path = sub === '.' ? parent : resolve(parent, sub);
          if (!within(path, parent)) return fail();
          result.push({ path, mode, glob: wildcard.test(path) });
        }
      }
    }
    if (result.length > 4096) return fail();
  }
  return result;
}
function couldAffect(rule: Rule, target: string) {
  if (!rule.glob) return within(target, rule.path) || within(rule.path, target);
  const at = rule.path.search(wildcard),
    before = rule.path.slice(0, at),
    prefix = before.slice(0, before.lastIndexOf('/')) || '/';
  return within(target, prefix) || within(prefix, target);
}
function declared(
  input: PathGuardPolicyInput,
  g: ReturnType<typeof graph>,
  target: string,
): Access {
  const explicit = rules(input, g.resolved),
    workspaces = roots(input, g.resolved, ':workspace_roots');
  const all: Rule[] = [
    ...(g.builtin ? [{ path: '/', mode: 'read' as const, glob: false }] : []),
    ...(g.builtin === ':workspace'
      ? [...workspaces, input.temporary.tmpdir, input.temporary.slashTmp]
          .filter((p): p is string => p !== null)
          .map((path) => ({ path, mode: 'write' as const, glob: false }))
      : []),
    ...explicit,
  ];
  if (all.some((r) => r.glob && couldAffect(r, target))) return fail();
  if (all.some((r) => !r.glob && r.path !== target && within(r.path, target) && r.mode !== 'deny'))
    return fail();
  let value: Access = 'deny',
    specificity = -1;
  for (const r of all.filter((r) => !r.glob && within(target, r.path))) {
    if (
      r.path.length > specificity ||
      (r.path.length === specificity &&
        ['read', 'write', 'deny'].indexOf(r.mode) > ['read', 'write', 'deny'].indexOf(value))
    ) {
      value = r.mode;
      specificity = r.path.length;
    }
  }
  // Native workspace profiles add context-dependent readonly exceptions. Do not invent their
  // complete set or turn a broad inherited write into a definite current-path access claim.
  if (
    g.builtin === ':workspace' &&
    workspaces.some((p) => within(target, p)) &&
    value !== 'deny' &&
    !explicit.some((r) => !r.glob && r.path === target)
  )
    return fail();
  return value;
}
export function pathGuardPolicy(input: PathGuardPolicyInput, target: string) {
  let profileName: string | null = null;
  try {
    const user = input.user,
      persistent = input.persistent,
      name = user.default_permissions;
    if (
      Object.hasOwn(persistent, 'sandbox_mode') ||
      Object.hasOwn(persistent, 'sandbox_workspace_write')
    )
      return fail('mixed-config');
    if (typeof name !== 'string' || !name || name.startsWith(':')) return fail();
    profileName = name;
    if (!table(user.permissions?.[name])) return fail('parent-unavailable');
    const initial = graph(persistent, name);
    let document = persistent;
    for (const project of input.projects) {
      if (
        project.default_permissions !== undefined ||
        project.sandbox_mode !== undefined ||
        project.sandbox_workspace_write !== undefined
      )
        return fail('project-override');
      for (const profile of initial.names) {
        const change = project.permissions?.[profile];
        if (change !== undefined) {
          if (!table(change) || change.extends !== undefined) return fail('project-override');
          if (rules(input, change).some((r) => r.mode !== 'deny')) return fail('project-override');
        }
      }
      document = mergeGuardTables(document, project);
    }
    const g = graph(document, name),
      declaration = declared(input, g, target);
    const baseline: CodexPathGuardCapture['baseline'] = {
      kind: 'profile',
      profile: 'custom',
      network: g.resolved.network?.enabled === true ? 'on' : 'off',
    };
    return { profileName, declaration, reason: null, baseline };
  } catch (e) {
    const message = (e as Error).message;
    const reason: CodexPathGuardError = message.startsWith('codex-path-guard-')
      ? (message as CodexPathGuardError)
      : message === 'codex-network-parent-unavailable'
        ? 'codex-path-guard-parent-unavailable'
        : 'codex-path-guard-unsupported';
    return {
      profileName,
      declaration: 'unknown' as const,
      reason,
      baseline: {
        kind: 'unavailable' as const,
        profile: 'none' as const,
        network: 'unknown' as const,
      },
    };
  }
}
function parentSignature(document: Record<string, any>, name: string) {
  const g = graph(document, name);
  return JSON.stringify(
    {
      extends: document.permissions?.[name]?.extends ?? null,
      workspace_roots: document.permissions?.[name]?.workspace_roots ?? null,
      parents: g.names
        .filter((n) => n !== name)
        .map((n) => ({
          name: n,
          extends: document.permissions[n].extends ?? null,
          filesystem: document.permissions[n].filesystem ?? null,
          workspace_roots: document.permissions[n].workspace_roots ?? null,
        })),
    },
    (_k, v) => (typeof v === 'bigint' ? { $integer: v.toString() } : v),
  );
}
/** Reinserting an old grant must not override a newer independent restriction. */
export function assertPathGuardRestorePolicy(
  before: Record<string, any>,
  current: Record<string, any>,
  profileName: string,
  target: string,
  input: PathGuardPolicyInput,
) {
  try {
    const old = before.permissions?.[profileName]?.filesystem?.[target];
    const candidate = structuredClone(current),
      profile = candidate.permissions?.[profileName];
    if (!table(profile) || !table(profile.filesystem) || profile.filesystem[target] !== 'deny')
      return fail('conflict');
    if (old === undefined) delete profile.filesystem[target];
    else profile.filesystem[target] = old;
    if (parentSignature(before, profileName) !== parentSignature(candidate, profileName))
      return fail('conflict');
    const g = graph(candidate, profileName),
      revealed = declared(input, g, target);
    if (revealed === 'deny') return;
    const original = rules(input, graph(before, profileName).resolved),
      after = rules(input, g.resolved);
    for (const r of after)
      if (
        (r.mode === 'deny' || (revealed === 'write' && r.mode === 'read')) &&
        couldAffect(r, target) &&
        !original.some((p) => p.path === r.path && p.mode === r.mode && p.glob === r.glob)
      )
        return fail('conflict');
  } catch {
    return fail('conflict');
  }
}
