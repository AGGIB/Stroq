import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  createMcpCallControlBinding,
  createMcpCallControlsStore,
  type McpCallControlSnapshot,
} from '../../packages/cli/src/mcp/call-control.ts';
import { parseMcpArgv } from '../../packages/cli/src/commands/mcp.ts';
import { wrapperIndex } from '../../packages/cli/src/commands/mcp-config.ts';
import {
  isObject,
  serializeJson,
  setAt,
  parseJsonDocument,
  deepEqual,
  removeAt,
} from '../../packages/cli/src/harden/json-doc.ts';
import type {
  McpCallControlInspection,
  McpCallControlSelection,
} from '../lib/mcp-call-controls.ts';
import {
  discoverMcpSources,
  readMcpSource,
  mcpArtifactId,
  mcpEntryMetadata,
  type McpSource,
} from './mcp-sources.ts';
import { context } from './mcp-containment-operations.ts';
import { publicArtifact, type Context } from './mcp-containment-vault.ts';
import { hash, MAX_CONFIG } from './mcp-containment-files.mjs';
import { callControlProxy } from './mcp-call-control-proxy.ts';
import { readMcpCallControlObservation } from './mcp-call-control-observation.ts';
import type { ProxyRuntime } from './mcp-containment-proxy.ts';
export type CallControlOptions = {
  project: string;
  userHome: string;
  home: string;
  cli: string;
  platform: NodeJS.Platform;
  mcpEnvironment: Readonly<Record<string, string | undefined>>;
  runtimeDigest: () => Promise<string>;
  now?: () => number;
  fault?: string | null;
};
export type CallControlRow = {
  source: McpSource;
  capture: Awaited<ReturnType<typeof readMcpSource>>;
  name: string;
  entry: unknown;
  id: string;
  sha256: string | null;
  controlId: string | null;
};
export const callControlFailure = (reason: string): never => {
  throw new Error(reason);
};
export async function canonicalCallControlPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const parent = dirname(resolve(path));
    if (parent === path) throw e;
    return join(await canonicalCallControlPath(parent), resolve(path).slice(parent.length + 1));
  }
}
export async function callControlContext(options: CallControlOptions) {
  const home = await canonicalCallControlPath(options.home),
    ctx = await context(
      options.project,
      options.userHome,
      options.platform,
      Date.now() + 10000,
      options.mcpEnvironment,
    );
  return { ctx, home, contextId: `context-${hash(JSON.stringify([home, ctx.user.path]))}` };
}
/** One bounded capture of fixed sources. Missing sources are ordinary; unreadable sources retain uncertainty. */
export async function readMcpCallControlRegistrations(options: CallControlOptions) {
  const { ctx, home, contextId } = await callControlContext(options),
    rows: CallControlRow[] = [],
    gaps = new Set<'source-unavailable' | 'source-limit'>();
  let count = 0;
  for (const source of await discoverMcpSources({
    project: ctx.project.path,
    userHome: ctx.user.path,
    platform: options.platform,
    environment: options.mcpEnvironment,
    deadline: ctx.deadline,
  })) {
    let capture;
    try {
      capture = await readMcpSource(source);
    } catch (e) {
      if ((e as Error).message !== 'mcp-source-missing' && source.applicability === 'supported')
        gaps.add('source-unavailable');
      continue;
    }
    if (!isObject(capture.doc.mcpServers)) continue;
    for (const [name, entry] of Object.entries(capture.doc.mcpServers)) {
      if (++count > 128) {
        gaps.add('source-limit');
        break;
      }
      let controlId: string | null = null;
      if (isObject(entry) && Array.isArray(entry.args)) {
        const at = wrapperIndex(entry.args);
        if (at !== null && entry.args.every((x) => typeof x === 'string')) {
          const parsed = parseMcpArgv(entry.args.slice(at + 1));
          if (parsed.ok) controlId = parsed.invocation.callControlId ?? null;
        }
      }
      rows.push({
        source,
        capture,
        name,
        entry,
        id: mcpArtifactId(source, name),
        sha256: mcpEntryMetadata(entry).sha256,
        controlId,
      });
    }
    if (count > 128) break;
  }
  let snapshot: McpCallControlSnapshot | null = null;
  try {
    snapshot = await createMcpCallControlsStore({ home }).read();
  } catch {}
  return { ctx, home, contextId, rows, gaps: [...gaps], snapshot };
}
export type RegistrationScan = Awaited<ReturnType<typeof readMcpCallControlRegistrations>>;
export type SelectedCallControl = {
  scan: RegistrationScan;
  row: CallControlRow;
  runtime: ProxyRuntime;
  proxy: ReturnType<typeof callControlProxy>;
  binding: Awaited<ReturnType<typeof createMcpCallControlBinding>>;
  inspection: McpCallControlInspection;
};
const emptyObservation = () => ({
  status: 'unobserved' as const,
  at: null,
  eventId: null,
  invocationSha256: null,
  reason: null,
});
export async function selectMcpCallControl(
  options: CallControlOptions,
  input: McpCallControlSelection,
  setupId?: string,
  captured?: {
    scan: RegistrationScan;
    fingerprint: string;
    observations: ReadonlyMap<string, McpCallControlInspection['observation']>;
  },
): Promise<SelectedCallControl> {
  const scan = captured?.scan ?? (await readMcpCallControlRegistrations(options)),
    matches = scan.rows.filter((r) => r.id === input.id);
  if (matches.length !== 1 || matches[0].sha256 !== input.expectedSha256)
    callControlFailure('mcp-call-control-stale');
  const row = matches[0],
    artifact = publicArtifact(row.source, row.name, row.sha256!);
  let fingerprint: string;
  try {
    fingerprint = captured ? captured.fingerprint : await options.runtimeDigest();
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error();
  } catch {
    fingerprint = '';
  }
  const runtime: ProxyRuntime = {
    command: process.execPath,
    entry: options.cli,
    home: scan.home,
    userHome: scan.ctx.user.path,
    fingerprint,
  };
  const inspection: McpCallControlInspection = {
    schema: 'stroq-mcp-call-control/1',
    workspaceId: scan.ctx.workspaceId,
    proxyWorkspaceId: null,
    contextId: scan.contextId,
    checkedAt: new Date((options.now ?? Date.now)()).toISOString(),
    artifact,
    capability: 'unsupported',
    reason: 'unsupported-wrapper',
    configuration: row.controlId ? 'controlled' : 'plain',
    modes: { strict: false, toolApproval: false, cloak: false, pinned: false },
    controlId: row.controlId,
    invocationSha256: null,
    revision: scan.snapshot?.revision ?? null,
    current: scan.snapshot?.controls.find((c) => c.controlId === row.controlId) ?? null,
    observation: emptyObservation(),
    hostEnforcement: false,
  };
  let proxy: ReturnType<typeof callControlProxy> | null = null,
    binding: SelectedCallControl['binding'] | null = null;
  try {
    if (row.source.applicability !== 'supported' || !['darwin', 'linux'].includes(options.platform))
      throw new Error();
    proxy = callControlProxy(
      row.entry,
      row.name,
      row.source.agent,
      runtime,
      scan.ctx.project.path,
      row.controlId ?? setupId ?? randomUUID(),
    );
    inspection.configuration = proxy.configuration;
    inspection.modes = {
      strict: proxy.invocation.strict === true,
      toolApproval: proxy.invocation.toolApproval === true,
      cloak: proxy.invocation.cloak,
      pinned: proxy.invocation.pin !== undefined,
    };
    binding = await createMcpCallControlBinding({
      ...proxy.invocation,
      home: scan.home,
      controlId: proxy.invocation.callControlId!,
      cwd: proxy.invocation.cwd!,
      environment: proxy.entry.env as Record<string, string>,
    });
    inspection.proxyWorkspaceId = `workspace-${hash(await realpath(proxy.invocation.cwd!)).slice(0, 24)}`;
    inspection.invocationSha256 = binding.invocationSha256;
    inspection.capability = row.controlId ? 'supported' : 'setup-required';
    inspection.reason = null;
    // Adding a flag changes a confirmed pin's complete launch. This setup cannot
    // reconfirm that independent gate without replacing its durable control slot.
    if (!row.controlId && proxy.invocation.pin !== undefined) {
      inspection.capability = 'unsupported';
      inspection.reason = 'unsupported-wrapper';
    }
  } catch {}
  if (!fingerprint) {
    inspection.capability = 'unavailable';
    inspection.reason = 'runtime-unavailable';
  } else if (!scan.snapshot) {
    inspection.capability = 'unavailable';
    inspection.reason = 'storage-unavailable';
  } else if (scan.gaps.length) {
    inspection.capability = 'unavailable';
    inspection.reason = scan.gaps[0];
  } else if (row.controlId && scan.rows.filter((r) => r.controlId === row.controlId).length !== 1) {
    inspection.capability = 'ambiguous';
    inspection.reason = 'duplicate-control';
  } else if (
    row.controlId &&
    (!inspection.current || inspection.current.invocationSha256 !== inspection.invocationSha256)
  ) {
    inspection.capability = 'drifted';
    inspection.reason = 'invocation-drift';
  }
  inspection.observation = captured
    ? (captured.observations.get(inspection.controlId ?? '') ?? emptyObservation())
    : await readMcpCallControlObservation(
        scan.home,
        inspection.current,
        (options.now ?? Date.now)(),
      );
  // Null private values are retained only for unsupported inspection, never used by mutation.
  return { scan, row, runtime, proxy: proxy!, binding: binding!, inspection };
}
export function callControlCandidate(selected: SelectedCallControl) {
  const { row, proxy } = selected;
  if (!proxy || !isObject(row.capture.doc.mcpServers))
    return callControlFailure('mcp-call-control-unsupported');
  const candidate = Buffer.from(
    serializeJson(
      setAt(row.capture.doc, ['mcpServers', row.name], proxy.entry as never),
      row.capture.layout,
    ),
  );
  if (!candidate.length || candidate.length > MAX_CONFIG)
    return callControlFailure('mcp-call-control-limit');
  const parsed = parseJsonDocument(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(candidate),
  );
  if (
    !parsed.ok ||
    !isObject(parsed.doc.mcpServers) ||
    !deepEqual(parsed.doc.mcpServers[row.name], proxy.entry) ||
    !deepEqual(
      removeAt(parsed.doc, ['mcpServers', row.name]),
      removeAt(row.capture.doc, ['mcpServers', row.name]),
    )
  )
    return callControlFailure('mcp-call-control-unavailable');
  return candidate;
}
