import {
  parseGuardToml,
  mergeGuardTables,
  resolveGuardProfile,
  table,
} from './codex-network-guard-parse.ts';
import { networkFail, type GuardCapture } from './codex-network-guard-binding.ts';
const knownNetwork = [
  'enabled',
  'domains',
  'unix_sockets',
  'enable_socks5',
  'enable_socks5_udp',
  'allow_local_binding',
];
const mode = (v: unknown) => v === 'read' || v === 'write' || v === 'deny';
function safeProfile(profile: Record<string, any>) {
  if (
    Object.keys(profile).some(
      (k) => !['description', 'extends', 'workspace_roots', 'filesystem', 'network'].includes(k),
    )
  )
    networkFail('codex-network-unsupported');
  if (profile.filesystem !== undefined) {
    if (!table(profile.filesystem) || Object.keys(profile.filesystem).length > 1024)
      networkFail('codex-network-unsupported');
    for (const [path, value] of Object.entries(profile.filesystem)) {
      if (path === 'glob_scan_max_depth') {
        if (
          (typeof value !== 'number' && typeof value !== 'bigint') ||
          !Number.isSafeInteger(Number(value)) ||
          Number(value) < 1 ||
          Number(value) > 64
        )
          networkFail('codex-network-unsupported');
      } else if (!mode(value) && (!table(value) || Object.values(value).some((v) => !mode(v))))
        networkFail('codex-network-unsupported');
    }
  }
  if (profile.network && Object.keys(profile.network).some((k) => !knownNetwork.includes(k)))
    networkFail('codex-network-unsupported');
  const result = Object.fromEntries(Object.entries(profile).filter(([k]) => k !== 'description'));
  if (result.filesystem?.glob_scan_max_depth !== undefined)
    result.filesystem = {
      ...result.filesystem,
      glob_scan_max_depth: Number(result.filesystem.glob_scan_max_depth),
    };
  return result;
}
export function networkCheckRecipe(capture: GuardCapture) {
  if (
    capture.public.baseline.network !== 'off' ||
    ['codex-network-project-override', 'codex-network-managed-unverified'].includes(
      capture.public.reason ?? '',
    )
  )
    networkFail('codex-network-unsupported');
  let document: Record<string, any> = {};
  for (const scope of ['system', 'user', 'project']) {
    const sources = capture.sources.filter((s) => s.scope === scope);
    if (scope === 'project') sources.reverse();
    for (const s of sources)
      document = mergeGuardTables(document, parseGuardToml(s.snapshot.bytes));
  }
  if (capture.public.baseline.kind === 'profile') {
    const selectedProfile = document.default_permissions;
    if (typeof selectedProfile !== 'string') networkFail('codex-network-unsupported');
    if (resolveGuardProfile(document, selectedProfile).network?.enabled === true)
      networkFail('codex-network-unsupported');
    const entries: [string, Record<string, any>][] = [];
    const seen = new Set<string>();
    const visit = (name: string) => {
      if (name.startsWith(':')) {
        if (![':workspace', ':read-only'].includes(name)) networkFail('codex-network-unsupported');
        return;
      }
      if (seen.has(name) || seen.size >= 16) networkFail('codex-network-unsupported');
      seen.add(name);
      const p = document.permissions?.[name];
      if (!table(p)) networkFail('codex-network-unsupported');
      const safe = safeProfile(p);
      entries.push([name, safe]);
      if (typeof p.extends === 'string') visit(p.extends);
    };
    visit(selectedProfile);
    return { kind: 'profile' as const, profiles: Object.fromEntries(entries), selectedProfile };
  }
  const readonly = capture.public.baseline.profile === 'read-only',
    workspace = capture.public.baseline.profile === 'workspace';
  if (!readonly && !workspace) networkFail('codex-network-unsupported');
  const settings = document.sandbox_workspace_write ?? {};
  if (!table(settings)) networkFail('codex-network-unsupported');
  if (workspace && settings.network_access === true) networkFail('codex-network-unsupported');
  const roots = settings.writable_roots ?? [];
  if (
    !Array.isArray(roots) ||
    roots.length > 64 ||
    roots.some(
      (p: unknown) =>
        typeof p !== 'string' ||
        !p.startsWith('/') ||
        p.length > 4096 ||
        /[\u0000-\u001f\u007f]/.test(p),
    )
  )
    networkFail('codex-network-unsupported');
  for (const k of ['exclude_tmpdir_env_var', 'exclude_slash_tmp'])
    if (settings[k] !== undefined && typeof settings[k] !== 'boolean')
      networkFail('codex-network-unsupported');
  const filesystem = workspace
    ? {
        ...(settings.exclude_tmpdir_env_var ? { ':tmpdir': 'read' } : {}),
        ...(settings.exclude_slash_tmp ? { ':slash_tmp': 'read' } : {}),
      }
    : {};
  const profile = {
    extends: readonly ? ':read-only' : ':workspace',
    ...(workspace && roots.length
      ? { workspace_roots: Object.fromEntries(roots.map((p: string) => [p, true])) }
      : {}),
    ...(Object.keys(filesystem).length ? { filesystem } : {}),
    network: { enabled: false },
  };
  return {
    kind:
      capture.public.baseline.kind === 'implicit'
        ? ('implicit-translated' as const)
        : ('legacy-translated' as const),
    profiles: { 'stroq-network-check': profile },
    selectedProfile: 'stroq-network-check',
  };
}
