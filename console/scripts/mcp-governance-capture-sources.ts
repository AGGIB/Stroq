import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';
import { parseJsonDocument } from '../../packages/cli/src/harden/json-doc.ts';
import type {
  McpGovernanceAgent,
  McpGovernanceCapture,
  McpGovernanceSource,
  McpGovernanceSourceRef,
} from '../lib/mcp-governance-types.ts';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import { discoverMcpSources } from './mcp-sources.ts';
import { governanceHash, governanceObject } from './mcp-governance-capture-policy.ts';
import type { McpGovernanceCaptureOptions } from './mcp-governance-capture.ts';

export type GovernanceGap = McpGovernanceCapture['gaps'][number];
export type GovernanceSource = {
  sourceId: McpGovernanceSource;
  agent: McpGovernanceAgent;
  scope: 'project' | 'user';
  root: any;
  file: string;
  format: 'json' | 'toml';
  unavailable?: true;
};
export type GovernanceRegistration = { name: string; entry: unknown; ref: McpGovernanceSourceRef };
export const governanceGap = (
  source: Pick<GovernanceSource, 'sourceId' | 'agent' | 'scope'> | null,
  code: GovernanceGap['code'],
): GovernanceGap => ({
  code,
  agent: source?.agent ?? null,
  scope: source?.scope ?? 'unknown',
  sourceId: source?.sourceId ?? null,
});
export async function canonicalGovernancePath(file: string): Promise<string> {
  if (!isAbsolute(file) || file.length > 4096 || /[\u0000-\u001f\u007f]/.test(file))
    throw Error('mcp-governance-unavailable');
  try {
    return await realpath(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(file) === file) throw error;
    return join(
      await canonicalGovernancePath(dirname(file)),
      resolve(file).slice(dirname(file).length + 1),
    );
  }
}
const inside = (root: string, file: string) => {
  const r = relative(root, file);
  return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r);
};
function document(bytes: Uint8Array, format: GovernanceSource['format']) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let doc: Record<string, unknown>;
  if (format === 'toml')
    doc = parse(text.replace(/^\uFEFF/, ''), {
      maxDepth: 32,
      unsafeKeyBehaviour: 'throw',
      integersAsBigInt: true,
    });
  else {
    const result = parseJsonDocument(text);
    if (!result.ok) throw Error('source-unavailable');
    doc = result.doc;
  }
  const pending: [unknown, number][] = [[doc, 0]];
  let count = 0;
  while (pending.length) {
    const [value, depth] = pending.pop()!;
    if (++count > 16384 || depth > 32) throw Error('source-limit');
    if (Array.isArray(value)) for (const v of value) pending.push([v, depth + 1]);
    else if (governanceObject(value))
      for (const v of Object.values(value)) pending.push([v, depth + 1]);
  }
  const entries = doc[format === 'toml' ? 'mcp_servers' : 'mcpServers'];
  if (entries !== undefined && !governanceObject(entries)) throw Error('source-unavailable');
  return governanceObject(entries) ? Object.entries(entries) : [];
}
export async function captureGovernanceRegistrations(options: McpGovernanceCaptureOptions) {
  const project = await rootIdentity(options.project),
    user = await rootIdentity(options.userHome),
    home = await canonicalGovernancePath(options.home);
  const sources: GovernanceSource[] = (
    await discoverMcpSources({
      project: project.path,
      userHome: user.path,
      platform: options.platform,
      environment: options.mcpEnvironment,
    })
  ).map((s) => ({
    sourceId:
      s.agent === 'windsurf'
        ? 'windsurf-user'
        : s.agent === 'claude-desktop'
          ? 'claude-desktop-user'
          : (s.source as McpGovernanceSource),
    agent: s.agent,
    scope: s.scope,
    root: s.root.path === project.path ? project : user,
    file: s.file,
    format: 'json',
    ...(s.applicability === 'configuration-unavailable' ||
    s.applicability === 'platform-unsupported'
      ? { unavailable: true as const }
      : {}),
  }));
  const gaps: GovernanceGap[] = [governanceGap(null, 'partial-capture')];
  const raw = options.codexEnvironment?.CODEX_HOME;
  let codexRoot = user,
    codeHome = join(user.path, '.codex'),
    unavailable = false;
  if (raw !== undefined && raw !== '') {
    try {
      if (
        typeof raw !== 'string' ||
        !isAbsolute(raw) ||
        raw.length > 4096 ||
        /[\u0000-\u001f\u007f]/.test(raw)
      )
        throw Error();
      codeHome = resolve(raw);
      if (!inside(user.path, codeHome)) {
        if ((await lstat(codeHome)).isSymbolicLink()) throw Error();
        codexRoot = await rootIdentity(codeHome);
        codeHome = codexRoot.path;
      }
    } catch {
      unavailable = true;
    }
  }
  sources.push({
    sourceId: 'codex-user',
    agent: 'codex',
    scope: 'user',
    root: codexRoot,
    file: join(codeHome, 'config.toml'),
    format: 'toml',
    ...(unavailable ? { unavailable: true as const } : {}),
  });
  sources.push({
    sourceId: 'codex-project',
    agent: 'codex',
    scope: 'project',
    root: project,
    file: join(project.path, '.codex/config.toml'),
    format: 'toml',
  });
  const pins: Record<string, unknown>[] = [],
    registrations: GovernanceRegistration[] = [];
  let count = 0;
  for (const source of sources.slice(0, 8)) {
    const locator = {
      sourceId: source.sourceId,
      agent: source.agent,
      scope: source.scope,
      root: source.root,
      file: source.file,
    };
    let snapshot;
    try {
      if (source.unavailable) throw Error();
      snapshot = await snapshotFile(source.root, source.file, 256 * 1024);
    } catch {
      pins.push({ ...locator, status: 'unavailable' });
      gaps.push(governanceGap(source, 'source-unavailable'));
      continue;
    }
    pins.push({
      ...locator,
      status: snapshot.bytes === null ? 'absent' : 'present',
      sha256: snapshot.sha256,
      fileMetadata: snapshot.file,
      directories: snapshot.directories,
    });
    if (snapshot.bytes === null) continue;
    let entries;
    try {
      entries = document(snapshot.bytes, source.format);
    } catch (error) {
      gaps.push(
        governanceGap(
          source,
          (error as Error).message === 'source-limit' ? 'source-limit' : 'source-unavailable',
        ),
      );
      continue;
    }
    const ref: McpGovernanceSourceRef = {
      id: `item-${governanceHash(locator).slice(0, 24)}`,
      sha: snapshot.sha256,
      agent: source.agent,
      scope: source.scope,
      label: `${source.agent === 'codex' ? 'Codex' : source.agent === 'cursor' ? 'Cursor' : source.agent === 'windsurf' ? 'Windsurf' : source.agent === 'claude-code' ? 'Claude Code' : 'Claude Desktop'} · ${source.scope}`,
      sourceId: source.sourceId,
    };
    for (const [name, entry] of entries) {
      if (++count > 128) {
        gaps.push(governanceGap(source, 'source-limit'));
        break;
      }
      registrations.push({ name, entry, ref });
    }
  }
  if (sources.length > 8) gaps.push(governanceGap(null, 'source-limit'));
  return { project, user, home, pins, registrations, gaps };
}
