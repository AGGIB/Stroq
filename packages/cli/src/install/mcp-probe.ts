import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CompiledRule } from '@stroq/core';
import { assertWritableTree } from './store.js';
import { buildTree, treeDigest } from './tree.js';
import { entrypointOf } from '../mcp/entrypoint.js';
import { runMcpHandshake, type HandshakeResult, type McpToolRecord } from '../mcp/handshake.js';
import { killChildTree } from '../mcp/kill-child.js';
import { hasGlobSyntax, srtArgv, type SrtSettings } from '../run/sandbox.js';
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
  host: {
    realpath?: (path: string) => string;
    readdir?: (path: string) => string[];
    runtimeReads?: readonly string[];
  } = {},
): SrtSettings & { filesystem: SrtSettings['filesystem'] & { allowRead: readonly string[] } } {
  const real = host.realpath ?? realpathSync;
  // Fail closed when the runtime or home cannot be resolved.
  const realHome = real(userHome);
  const realNode = real(process.execPath);
  const runtimeReads = host.runtimeReads ?? [];
  if ([scratchDir, realHome, realNode, ...runtimeReads].some(hasGlobSyntax))
    throw new McpProbeRefusalError(
      'probe paths contain sandbox glob syntax; the server was not started',
    );
  return {
    filesystem: {
      denyRead: ['/', realHome],
      allowRead: [
        scratchDir,
        realNode,
        ...runtimeReads,
        '/bin',
        '/usr/bin',
        '/usr/lib',
        '/usr/lib64',
        '/lib',
        '/lib64',
        '/System/Library',
        '/Library/Apple/System/Library',
        '/dev/null',
        '/dev/urandom',
        '/dev/random',
        '/etc/ld.so.cache',
      ],
      // srt implicitly permits its shared temp directory; this probe uses private scratch instead.
      denyWrite: ['/tmp/claude', '/private/tmp/claude'],
      allowWrite: [scratchDir],
    },
    network: { allowedDomains: [], deniedDomains: ['*'] },
  };
}

/** Only the Linux seccomp helper enters the child namespace; never grant its package or home. */
export function probeRuntimeReads(srt: string, arch: string = process.arch): readonly string[] {
  if (arch !== 'x64' && arch !== 'arm64')
    throw new McpProbeRefusalError(
      'unsupported sandbox-runtime architecture; the server was not started',
    );
  let root = dirname(realpathSync(srt));
  for (let depth = 0; depth < 4; depth++) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (pkg.name === '@anthropic-ai/sandbox-runtime') {
        const helper = realpathSync(join(root, 'vendor', 'seccomp', arch, 'apply-seccomp'));
        if (!statSync(helper).isFile() || hasGlobSyntax(helper)) break;
        return [helper];
      }
    } catch {
      // Keep looking at the bounded set of parents of the trusted launcher.
    }
    root = dirname(root);
  }
  throw new McpProbeRefusalError(
    'cannot locate sandbox-runtime seccomp helper; the server was not started',
  );
}

export function syntheticProbeEnv(scratchDir: string, plat: NodeJS.Platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'SystemRoot', 'COMSPEC', 'PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }

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
  env['CLAUDE_CODE_TMPDIR'] = join(scratchDir, 'tmp');

  return env;
}

export async function probeMcpTree(options: McpProbeOptions): Promise<McpProbeResult> {
  const tree = buildTree(options.tree.entries, { complete: true });
  assertWritableTree(tree, treeDigest(tree));
  const entryFile = entrypointOf(tree, options.entrypoint);
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
    const dependencies = plat === 'linux' ? ['rg', 'bwrap', 'socat'] : ['rg'];
    const missing = dependencies.filter((binary) => binOnPath(binary, process.env, plat) === null);
    if (missing.length)
      throw new McpProbeRefusalError(
        `sandboxed probe is missing runtime dependencies: ${missing.join(', ')}; the server was not started`,
      );
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

  let spawnedChild: ChildProcess | null = null;
  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (spawnedChild) {
      try {
        if (process.platform !== 'win32' && spawnedChild.pid !== undefined) {
          try {
            process.kill(-spawnedChild.pid, 'SIGKILL');
          } catch {
            /* group already gone */
          }
        }
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
    mkdirSync(treeDir, { recursive: true, mode: 0o700 });
    mkdirSync(scratchHome, { recursive: true, mode: 0o700 });
    mkdirSync(scratchXdgConfig, { recursive: true, mode: 0o700 });
    mkdirSync(scratchXdgData, { recursive: true, mode: 0o700 });
    mkdirSync(scratchTmp, { recursive: true, mode: 0o700 });

    // Materialize verified tree into scratch/tree
    for (const entry of tree.entries) {
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
    const srtBin =
      options.srtBin !== undefined ? options.srtBin : binOnPath('srt', process.env, plat);
    const runtimeReads =
      plat === 'linux' && srtBin !== null && existsSync(srtBin) ? probeRuntimeReads(srtBin) : [];
    const settings = probeSandboxSettings(scratchDir, userHome, { runtimeReads });
    const settingsFile = join(scratchDir, 'srt-settings.json');
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

    const env = syntheticProbeEnv(scratchDir, plat);

    let handshakeResult: HandshakeResult;
    if (options.launcher === undefined) {
      const version = spawnSync(srtBin!, ['--version'], { env, encoding: 'utf8', timeout: 5000 });
      const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(version.stdout ?? '');
      if (
        version.status !== 0 ||
        !match ||
        (Number(match[1]) === 0 && Number(match[2]) === 0 && Number(match[3]) < 79)
      )
        throw new McpProbeRefusalError(
          'sandboxed probe requires srt >=0.0.79 with allowRead support; the server was not started',
        );
    }

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
        detached: true,
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
