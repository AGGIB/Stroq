import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CompiledRule } from '@stroq/core';
import { childEnv } from '../mcp/child-env.js';
import { entrypointOf } from '../mcp/entrypoint.js';
import { runMcpHandshake, type HandshakeResult, type McpToolRecord } from '../mcp/handshake.js';
import { killChildTree } from '../mcp/kill-child.js';
import { srtArgv, type SrtSettings } from '../run/sandbox.js';
import { binOnPath } from '../run/which.js';
import { confirm } from '../ui/prompt.js';
import { styleFor } from '../ui/style.js';
import type { Terminal } from '../ui/terminal.js';
import { toolIsSensitive } from './inspect/tool-spec.js';
import type { PassportLine, Tree } from './types.js';

export class McpProbeRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpProbeRefusalError';
  }
}

export interface ProbeLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly srtSettings: SrtSettings;
  readonly scratchDir: string;
  readonly entrypointFile: string;
}

export type ProbeLauncher = (
  spec: ProbeLaunchSpec,
) => Promise<ChildProcess | HandshakeResult> | ChildProcess | HandshakeResult;

export interface McpProbeOptions {
  readonly tree: Tree;
  readonly entrypoint?: string | undefined;
  readonly userHome?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly srtBin?: string | null | undefined;
  readonly terminal?: Terminal | undefined;
  readonly confirm?: (() => Promise<boolean> | boolean) | undefined;
  readonly launcher?: ProbeLauncher | undefined;
  readonly rules?: readonly CompiledRule[] | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxPages?: number | undefined;
  readonly maxTools?: number | undefined;
  readonly maxBytes?: number | undefined;
}

export interface McpProbeResult {
  readonly status: 'ok' | 'declined' | 'error';
  readonly entrypoint: string;
  readonly tools: readonly McpToolRecord[];
  readonly flagged: readonly string[];
  readonly error: string | null;
  readonly blindSpots: readonly string[];
  readonly lines: readonly PassportLine[];
  readonly signals: readonly { readonly ruleId: string; readonly file: string }[];
}

export function probeSandboxSettings(
  scratchDir: string,
  userHome: string,
  host: { realpath?: (path: string) => string; readdir?: (path: string) => string[] } = {},
): SrtSettings {
  const real = host.realpath ?? realpathSync;
  const readdir = host.readdir ?? readdirSync;

  let realHome: string;
  try {
    realHome = real(userHome);
  } catch {
    realHome = resolve(userHome);
  }

  let realNode: string;
  try {
    realNode = real(process.execPath);
  } catch {
    realNode = resolve(process.execPath);
  }

  // Which direct child of realHome is an ancestor of realNode, if any?
  let nodePrefixChild: string | null = null;
  const rel = relative(realHome, realNode);
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
    const firstSegment = rel.split(sep)[0];
    if (firstSegment) {
      nodePrefixChild = join(realHome, firstSegment);
    }
  }

  const denyRead: string[] = [];
  try {
    const children = readdir(realHome);
    for (const child of children) {
      const childPath = join(realHome, child);
      if (nodePrefixChild !== null && resolve(childPath) === resolve(nodePrefixChild)) {
        continue;
      }
      denyRead.push(childPath);
    }
  } catch {
    if (nodePrefixChild === null) {
      denyRead.push(realHome);
    }
  }

  return {
    filesystem: {
      denyRead,
      denyWrite: [],
      allowWrite: [scratchDir],
    },
    network: {
      allowedDomains: [],
      deniedDomains: [],
    },
  };
}

export function syntheticProbeEnv(scratchDir: string, plat: NodeJS.Platform): NodeJS.ProcessEnv {
  const baseEnv = childEnv([], process.env, plat);
  const env: NodeJS.ProcessEnv = { ...baseEnv };

  delete env['HOME'];
  delete env['USERPROFILE'];
  delete env['HOMEDRIVE'];
  delete env['HOMEPATH'];
  delete env['NODE_OPTIONS'];

  env['HOME'] = join(scratchDir, 'home');
  env['USERPROFILE'] = join(scratchDir, 'home');
  env['XDG_CONFIG_HOME'] = join(scratchDir, 'xdg', 'config');
  env['XDG_DATA_HOME'] = join(scratchDir, 'xdg', 'data');
  env['XDG_CACHE_HOME'] = join(scratchDir, 'xdg', 'cache');
  env['TMPDIR'] = join(scratchDir, 'tmp');
  env['TMP'] = join(scratchDir, 'tmp');
  env['TEMP'] = join(scratchDir, 'tmp');

  return env;
}

export async function probeMcpTree(options: McpProbeOptions): Promise<McpProbeResult> {
  const entryFile = entrypointOf(options.tree, options.entrypoint);
  const plat = options.platform ?? process.platform;
  const userHome = options.userHome ?? homedir();

  // Validate execution platform and srt availability when launcher is not injected
  if (options.launcher === undefined) {
    if (plat !== 'darwin' && plat !== 'linux') {
      throw new McpProbeRefusalError(
        'sandboxed probe requires srt on macOS or Linux; Windows is not supported',
      );
    }

    const srt = options.srtBin !== undefined ? options.srtBin : binOnPath('srt', process.env, plat);
    if (srt === null) {
      throw new McpProbeRefusalError(
        'sandboxed probe requires srt on PATH; install it with: npm install -g @anthropic-ai/sandbox-runtime',
      );
    }
  }

  // Confirmation
  if (options.confirm !== undefined) {
    const ok = await options.confirm();
    if (!ok) {
      return {
        status: 'declined',
        entrypoint: entryFile,
        tools: [],
        flagged: [],
        error: null,
        blindSpots: ['probe declined; capabilities not observed'],
        lines: [],
        signals: [],
      };
    }
  } else if (options.terminal !== undefined) {
    options.terminal.write(`  Will execute: node ${entryFile} (sandboxed with srt)\n`);
    const ok =
      options.terminal.interactive &&
      (await confirm(
        options.terminal,
        styleFor(options.terminal),
        'Probe this MCP server in a sandbox?',
        false,
      ));
    if (!ok) {
      return {
        status: 'declined',
        entrypoint: entryFile,
        tools: [],
        flagged: [],
        error: null,
        blindSpots: ['probe declined; capabilities not observed'],
        lines: [],
        signals: [],
      };
    }
  } else {
    // Non-interactive without explicit confirmation is declined
    return {
      status: 'declined',
      entrypoint: entryFile,
      tools: [],
      flagged: [],
      error: null,
      blindSpots: ['probe declined; capabilities not observed'],
      lines: [],
      signals: [],
    };
  }

  // Setup scratch directory
  const scratchDir = mkdtempSync(join(tmpdir(), 'stroq-mcp-probe-'));
  const treeDir = join(scratchDir, 'tree');
  const scratchHome = join(scratchDir, 'home');
  const scratchXdgConfig = join(scratchDir, 'xdg', 'config');
  const scratchXdgData = join(scratchDir, 'xdg', 'data');
  const scratchTmp = join(scratchDir, 'tmp');

  mkdirSync(treeDir, { recursive: true, mode: 0o700 });
  mkdirSync(scratchHome, { recursive: true, mode: 0o700 });
  mkdirSync(scratchXdgConfig, { recursive: true, mode: 0o700 });
  mkdirSync(scratchXdgData, { recursive: true, mode: 0o700 });
  mkdirSync(scratchTmp, { recursive: true, mode: 0o700 });

  // Materialize verified tree into scratch/tree
  for (const entry of options.tree.entries) {
    if (entry.kind === 'file') {
      const target = join(treeDir, ...entry.path.split('/'));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, entry.bytes ?? Buffer.from(''), {
        mode: entry.exec ? 0o700 : 0o600,
        flag: 'wx',
      });
    }
  }

  const entrypointAbs = join(treeDir, ...entryFile.split('/'));
  const settings = probeSandboxSettings(scratchDir, userHome);
  const settingsFile = join(scratchDir, 'srt-settings.json');
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

  const env = syntheticProbeEnv(scratchDir, plat);

  let spawnedChild: ChildProcess | null = null;
  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (spawnedChild) {
      try {
        killChildTree(spawnedChild, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(scratchDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* ignore */
    }
  };

  const onSignal = (): void => {
    cleanup();
    process.exit(130);
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('exit', cleanup);

  try {
    let handshakeResult: HandshakeResult;
    const srtBin =
      options.srtBin !== undefined ? options.srtBin : binOnPath('srt', process.env, plat);

    if (options.launcher !== undefined) {
      const launched = await options.launcher({
        command: srtBin ?? 'srt',
        args: srtArgv(settingsFile, process.execPath, [entrypointAbs]),
        env,
        cwd: treeDir,
        srtSettings: settings,
        scratchDir,
        entrypointFile: entryFile,
      });

      if ('tools' in launched) {
        handshakeResult = launched;
      } else {
        spawnedChild = launched as ChildProcess;
        handshakeResult = await runMcpHandshake(spawnedChild, {
          timeoutMs: options.timeoutMs,
          maxPages: options.maxPages,
          maxTools: options.maxTools,
          maxBytes: options.maxBytes,
          rules: options.rules,
        });
      }
    } else {
      spawnedChild = spawn(srtBin!, srtArgv(settingsFile, process.execPath, [entrypointAbs]), {
        cwd: treeDir,
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      handshakeResult = await runMcpHandshake(spawnedChild, {
        timeoutMs: options.timeoutMs,
        maxPages: options.maxPages,
        maxTools: options.maxTools,
        maxBytes: options.maxBytes,
        rules: options.rules,
      });
    }

    const lines: PassportLine[] = [];
    const signals: { ruleId: string; file: string }[] = [];
    const blindSpots: string[] = [];

    for (const tool of handshakeResult.tools) {
      lines.push({
        kind: 'tool',
        subject: tool.name,
        basis: 'observed',
        sensitive: toolIsSensitive(tool.name),
        where: [{ file: entryFile, line: null }],
        detector: 'mcp-probe',
      });
    }

    const seenRules = new Set<string>();
    for (const match of handshakeResult.matches) {
      if (!seenRules.has(match.ruleId)) {
        seenRules.add(match.ruleId);
        signals.push({ ruleId: match.ruleId, file: entryFile });
        lines.push({
          kind: 'signal',
          subject: match.ruleId,
          basis: 'observed',
          sensitive: true,
          where: [{ file: entryFile, line: null }],
          detector: 'mcp-probe; a signal to look at, not a verdict',
        });
      }
    }

    if (handshakeResult.incompleteReason !== null) {
      blindSpots.push(handshakeResult.incompleteReason);
    }
    if (handshakeResult.error !== null) {
      blindSpots.push(handshakeResult.error);
    }
    if (handshakeResult.error !== null || handshakeResult.incompleteReason !== null) {
      signals.push({ ruleId: 'reading-failed:mcp-probe', file: entryFile });
    }

    return {
      status: handshakeResult.error ? 'error' : 'ok',
      entrypoint: entryFile,
      tools: handshakeResult.tools,
      flagged: handshakeResult.flagged,
      error: handshakeResult.error,
      blindSpots,
      lines,
      signals,
    };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('exit', cleanup);
    cleanup();
  }
}
