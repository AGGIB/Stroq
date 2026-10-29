import { parse } from 'smol-toml';
import type { CodexNetworkGuardKind } from '../lib/codex-network-guard.ts';
import { networkFail } from './codex-network-guard-binding.ts';
export const table = (v: unknown): v is Record<string, any> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
export function parseGuardToml(bytes: Uint8Array | null) {
  if (bytes === null) return {};
  if (bytes.byteLength > 256 * 1024) networkFail('codex-network-unsupported');
  try {
    const d = parse(new TextDecoder('utf8', { fatal: true }).decode(bytes), {
      maxDepth: 32,
      unsafeKeyBehaviour: 'throw',
      integersAsBigInt: true,
    });
    let nodes = 0;
    const visit = (v: unknown, depth = 0) => {
      if (++nodes > 16384 || depth > 32) networkFail('codex-network-unsupported');
      if (Array.isArray(v)) for (const x of v) visit(x, depth + 1);
      else if (table(v)) for (const x of Object.values(v)) visit(x, depth + 1);
    };
    visit(d);
    return d;
  } catch {
    networkFail('codex-network-unsupported');
  }
}
export const mergeGuardTables = (
  a: Record<string, any>,
  b: Record<string, any>,
): Record<string, any> =>
  Object.fromEntries(
    [...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [
      k,
      table(a[k]) && table(b[k]) ? mergeGuardTables(a[k], b[k]) : Object.hasOwn(b, k) ? b[k] : a[k],
    ]),
  );
const validName = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 2048 &&
  !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v);
export function resolveGuardProfile(
  document: Record<string, any>,
  name: string,
  seen: string[] = [],
): Record<string, any> {
  if (seen.length > 16 || seen.includes(name)) networkFail('codex-network-parent-unavailable');
  if (name === ':workspace' || name === ':read-only') return { network: { enabled: false } };
  if (name === ':danger-full-access') return { network: { enabled: true } };
  if (name.startsWith(':') || !table(document.permissions) || !table(document.permissions[name]))
    networkFail('codex-network-parent-unavailable');
  const p = document.permissions[name];
  if (
    Object.keys(p).some(
      (k) => !['extends', 'description', 'filesystem', 'workspace_roots', 'network'].includes(k),
    ) ||
    (p.extends !== undefined && !validName(p.extends)) ||
    (p.filesystem !== undefined && !table(p.filesystem)) ||
    (p.workspace_roots !== undefined &&
      (!table(p.workspace_roots) ||
        Object.values(p.workspace_roots).some((x) => typeof x !== 'boolean'))) ||
    (p.network !== undefined && !table(p.network))
  )
    networkFail('codex-network-unsupported');
  if (p.extends === ':danger-full-access') networkFail('codex-network-unsupported');
  if (p.network?.enabled !== undefined && typeof p.network.enabled !== 'boolean')
    networkFail('codex-network-unsupported');
  if (p.network) {
    const allowed = [
      'enabled',
      'domains',
      'unix_sockets',
      'proxy_url',
      'enable_socks5',
      'socks_url',
      'enable_socks5_udp',
      'allow_local_binding',
    ];
    if (Object.keys(p.network).some((k) => !allowed.includes(k)))
      networkFail('codex-network-unsupported');
    for (const key of ['domains', 'unix_sockets'])
      if (
        p.network[key] !== undefined &&
        (!table(p.network[key]) ||
          Object.keys(p.network[key]).length > 512 ||
          Object.values(p.network[key]).some((v) => v !== 'allow' && v !== 'deny'))
      )
        networkFail('codex-network-unsupported');
    for (const key of ['enable_socks5', 'enable_socks5_udp', 'allow_local_binding'])
      if (p.network[key] !== undefined && typeof p.network[key] !== 'boolean')
        networkFail('codex-network-unsupported');
  }

  const inherited = p.extends
    ? resolveGuardProfile(document, p.extends, [...seen, name])
    : { network: { enabled: false } };
  return mergeGuardTables(inherited, p);
}
export function classifyGuard(
  document: Record<string, any>,
  user: Record<string, any>,
  implicitMode: 'read-only' | 'workspace-write' | null = null,
) {
  const profile = user.default_permissions,
    legacy =
      Object.hasOwn(document, 'sandbox_mode') || Object.hasOwn(document, 'sandbox_workspace_write');
  if (document.default_permissions !== undefined && legacy)
    networkFail('codex-network-mixed-config');
  if (profile !== undefined) {
    if (!validName(profile)) networkFail('codex-network-unsupported');
    const resolved = resolveGuardProfile(document, profile),
      on = resolved.network?.enabled === true;
    const kind: CodexNetworkGuardKind | null = on
      ? profile === ':danger-full-access'
        ? 'profile-child'
        : profile.startsWith(':')
          ? null
          : 'profile-network-off'
      : null;
    return {
      kind,
      parentProfile: profile,
      baseline: {
        kind: 'profile' as const,
        profile: (profile === ':workspace'
          ? 'workspace'
          : profile === ':read-only'
            ? 'read-only'
            : profile === ':danger-full-access'
              ? 'full-access'
              : 'custom') as 'workspace' | 'read-only' | 'full-access' | 'custom',
        network: on ? ('on' as const) : ('off' as const),
      },
      filesystemEffect:
        profile === ':danger-full-access'
          ? ('workspace-restricted' as const)
          : ('unchanged' as const),
    };
  }
  if (document.default_permissions !== undefined) networkFail('codex-network-parent-unavailable');
  const explicitMode = user.sandbox_mode ?? document.sandbox_mode;
  const mode = explicitMode ?? implicitMode,
    workspace = document.sandbox_workspace_write;
  if (workspace !== undefined && !table(workspace)) networkFail('codex-network-unsupported');
  if (workspace?.network_access !== undefined && typeof workspace.network_access !== 'boolean')
    networkFail('codex-network-unsupported');
  if (mode === 'danger-full-access' && user.sandbox_mode !== 'danger-full-access')
    networkFail('codex-network-unsupported');
  if (
    mode === 'workspace-write' &&
    workspace?.network_access === true &&
    user.sandbox_workspace_write?.network_access !== true
  )
    networkFail('codex-network-unsupported');
  if (mode === 'danger-full-access')
    return {
      kind: 'legacy-enable-workspace' as const,
      parentProfile: null,
      baseline: {
        kind: 'legacy' as const,
        profile: 'full-access' as const,
        network: 'on' as const,
      },
      filesystemEffect: 'workspace-restricted' as const,
    };
  if (mode === 'workspace-write')
    return {
      kind: workspace?.network_access === true ? ('legacy-network-off' as const) : null,
      parentProfile: null,
      baseline: {
        kind: explicitMode === undefined ? ('implicit' as const) : ('legacy' as const),
        profile: 'workspace' as const,
        network: workspace?.network_access === true ? ('on' as const) : ('off' as const),
      },
      filesystemEffect: 'unchanged' as const,
    };
  if (mode === 'read-only')
    return {
      kind: null,
      parentProfile: null,
      baseline: {
        kind: explicitMode === undefined ? ('implicit' as const) : ('legacy' as const),
        profile: 'read-only' as const,
        network: 'off' as const,
      },
      filesystemEffect: 'unchanged' as const,
    };
  networkFail('codex-network-unsupported');
}
export function projectGuardOverride(document: Record<string, any>) {
  if (document.default_permissions !== undefined || document.sandbox_mode !== undefined)
    return 'selector-override' as const;
  if (document.sandbox_workspace_write?.network_access !== undefined)
    return 'network-override' as const;
  if (
    table(document.permissions) &&
    Object.values(document.permissions).some(
      (p) => table(p) && (p.extends !== undefined || p.network !== undefined),
    )
  )
    return 'network-override' as const;
  return Object.hasOwn(document, 'permissions') ? ('parent-edit' as const) : ('none' as const);
}

export function implicitGuardMode(
  user: Record<string, any>,
  roots: { project: { path: string }; ancestry: { boundary: string; parents: { path: string }[] } },
): 'read-only' | 'workspace-write' | null {
  if (user.projects === undefined) return 'read-only';
  if (!table(user.projects)) return null;
  const keys = [roots.project.path, roots.ancestry.boundary];
  for (const path of keys) {
    const row = user.projects[path];
    if (row !== undefined) {
      if (!table(row) || !['trusted', 'untrusted'].includes(row.trust_level)) return null;
      return 'workspace-write';
    }
  }
  if (
    Object.keys(user.projects).some(
      (path) => roots.project.path === path || roots.project.path.startsWith(path + '/'),
    )
  )
    return null;
  return 'read-only';
}
