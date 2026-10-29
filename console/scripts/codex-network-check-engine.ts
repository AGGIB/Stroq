import { createServer, type Server, type Socket } from 'node:net';
import {
  mkdtempSync,
  realpathSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  validateCodexNetworkGuardCheckPreparation,
  type CodexNetworkGuardCheckPreparation,
} from '../lib/codex-network-guard-check-private';
import {
  codexNetworkCheckOutcome,
  validateCodexNetworkCheckResult,
  type CodexNetworkCheckResult,
} from '../lib/codex-network-check';
import {
  active,
  runNetworkProcess,
  verifyNetworkNative,
  type NetworkRuntime,
  type NetworkEngineOptions,
  type NetworkScratch,
} from './codex-network-check-runtime';
import {
  canonicalJSON,
  decodeCanaryWire,
  getProfileCopySha,
  getSuiteSha,
  NETWORK_CHECK_CANARY_SOURCE,
  NETWORK_CHECK_MARKER,
  NETWORK_CHECK_MARKER_TEXT,
  NETWORK_CHECK_SCRATCH_PREFIX,
  networkCheckFail,
  projectNetworkChecks,
  serializeProfileCopy,
  validateNetworkCopy,
} from './codex-network-check-protocol';
export { verifyNetworkNative } from './codex-network-check-runtime';
export type { NetworkEngineOptions, NetworkScratch } from './codex-network-check-runtime';

interface OwnedScratch extends NetworkScratch {
  uid: number;
  markerWritten: boolean;
}
interface Listener {
  server: Server;
  sockets: Set<Socket>;
  count: number;
  failed: boolean;
}
const optionalFeatures =
  '\n[features]\nshell_snapshot=false\napps=false\nplugins=false\nremote_plugin=false\nskill_mcp_dependency_install=false\nnetwork_proxy=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[skills.bundled]\nenabled=false\n';
const errorCodes = new Set([
  'invalid-input',
  'unsupported',
  'native-changed',
  'cancelled',
  'deadline-exceeded',
  'output-limit',
  'cleanup-failed',
  'listener-failed',
  'invalid-report',
]);
function newScratch(): OwnedScratch {
  const root = mkdtempSync(join(realpathSync(tmpdir()), NETWORK_CHECK_SCRATCH_PREFIX)),
    info = lstatSync(root);
  return {
    root,
    project: join(root, 'project'),
    home: join(root, 'home'),
    stroqHome: join(root, 'stroq-home'),
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    markerWritten: false,
  };
}
function markerMatches(s: OwnedScratch): boolean {
  let fd: number | undefined;
  try {
    const path = join(s.root, NETWORK_CHECK_MARKER),
      named = lstatSync(path);
    if (
      !named.isFile() ||
      named.nlink !== 1 ||
      named.size !== Buffer.byteLength(NETWORK_CHECK_MARKER_TEXT)
    )
      return false;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const pinned = fstatSync(fd),
      bytes = Buffer.alloc(named.size + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0),
      after = fstatSync(fd),
      current = lstatSync(path);
    return (
      length === named.size &&
      bytes.subarray(0, length).toString('utf8') === NETWORK_CHECK_MARKER_TEXT &&
      ['dev', 'ino', 'uid', 'mode', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every(
        (k) =>
          named[k as keyof typeof named] === pinned[k as keyof typeof pinned] &&
          pinned[k as keyof typeof pinned] === after[k as keyof typeof after] &&
          after[k as keyof typeof after] === current[k as keyof typeof current],
      )
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function removeScratch(s: OwnedScratch): void {
  let now;
  try {
    now = lstatSync(s.root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    return networkCheckFail('cleanup-failed');
  }
  if (
    !now.isDirectory() ||
    now.dev !== s.dev ||
    now.ino !== s.ino ||
    now.uid !== s.uid ||
    (now.mode & 0o777) !== 0o700 ||
    dirname(s.root) !== realpathSync(tmpdir()) ||
    !basename(s.root).startsWith(NETWORK_CHECK_SCRATCH_PREFIX) ||
    (s.markerWritten && !markerMatches(s))
  )
    return networkCheckFail('cleanup-failed');
  try {
    rmSync(s.root, { recursive: true, force: true });
  } catch {
    return networkCheckFail('cleanup-failed');
  }
  try {
    lstatSync(s.root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
  }
  return networkCheckFail('cleanup-failed');
}
function environment(s: OwnedScratch): NodeJS.ProcessEnv {
  return {
    HOME: s.home,
    USERPROFILE: s.home,
    CODEX_HOME: join(s.home, '.codex'),
    TMPDIR: join(s.root, 'tmp'),
    TEMP: join(s.root, 'tmp'),
    TMP: join(s.root, 'tmp'),
    XDG_CONFIG_HOME: join(s.root, 'config'),
    XDG_DATA_HOME: join(s.root, 'data'),
    XDG_CACHE_HOME: join(s.root, 'cache'),
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NO_COLOR: '1',
    NODE_DISABLE_COMPILE_CACHE: '1',
  };
}
function makeListener(): Listener {
  const sockets = new Set<Socket>(),
    state = { server: undefined as unknown as Server, sockets, count: 0, failed: false };
  state.server = createServer((socket) => {
    state.count++;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.end();
  });
  state.server.on('error', () => {
    state.failed = true;
  });
  return state;
}
async function listen(
  listener: Listener,
  target: { host: string; port: number } | string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(new Error('listener-failed'));
    listener.server.once('error', failed);
    listener.server.listen(target as any, () => {
      listener.server.off('error', failed);
      resolve();
    });
  });
}
async function closeListener(listener: Listener): Promise<void> {
  for (const socket of listener.sockets) socket.destroy();
  if (!listener.server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('cleanup-failed')), 1000);
    listener.server.close((error) => {
      clearTimeout(timeout);
      error ? reject(new Error('cleanup-failed')) : resolve();
    });
  });
}
function listenersHealthy(listeners: Listener[]): void {
  if (listeners.some((l) => l.failed || !l.server.listening))
    return networkCheckFail('listener-failed');
}
const counts = (listeners: Listener[]) => listeners.map((l) => l.count);
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Fixed local command only. Result is returned after owned children, listeners and scratch are gone. */
export async function runCodexNetworkCheckEngine(
  input: CodexNetworkGuardCheckPreparation,
  options: NetworkEngineOptions = {},
): Promise<CodexNetworkCheckResult> {
  if (!validateCodexNetworkGuardCheckPreparation(input)) return networkCheckFail('invalid-input');
  if (
    !validateNetworkCopy(input) ||
    Buffer.byteLength(canonicalJSON(input.profiles)) > 256 * 1024 ||
    (options.platform ?? process.platform) !== 'darwin'
  )
    return networkCheckFail('unsupported');
  const copy = JSON.parse(
    canonicalJSON({
      kind: input.kind,
      selectedProfile: input.selectedProfile,
      profiles: input.profiles,
      networkOff: true,
    }),
  );
  const native = JSON.parse(
    canonicalJSON(input.native),
  ) as CodexNetworkGuardCheckPreparation['native'];
  const copySha = getProfileCopySha(copy);
  const duration = options.deadlineMs ?? 12000;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 30000)
    return networkCheckFail('invalid-input');
  const runtime: NetworkRuntime = { options, deadline: Date.now() + duration };
  active(runtime);
  let scratch: OwnedScratch | undefined,
    result: CodexNetworkCheckResult | undefined,
    problem: unknown;
  const listeners: Listener[] = [];
  try {
    scratch = newScratch();
    // The supervisor receives the exclusive identity before marker/config/subdirectory writes.
    options.onScratch?.({
      root: scratch.root,
      project: scratch.project,
      home: scratch.home,
      stroqHome: scratch.stroqHome,
      dev: scratch.dev,
      ino: scratch.ino,
    });
    await options.fault?.('scratch-registered', { scratch });
    writeFileSync(join(scratch.root, NETWORK_CHECK_MARKER), NETWORK_CHECK_MARKER_TEXT, {
      flag: 'wx',
      mode: 0o600,
    });
    scratch.markerWritten = true;
    for (const dir of [
      scratch.project,
      scratch.home,
      scratch.stroqHome,
      ...['tmp', 'config', 'data', 'cache'].map((d) => join(scratch!.root, d)),
    ])
      mkdirSync(dir, { mode: 0o700 });
    mkdirSync(join(scratch.project, '.git'), { mode: 0o700 });
    mkdirSync(join(scratch.home, '.codex'), { mode: 0o700 });
    writeFileSync(
      join(scratch.home, '.codex', 'config.toml'),
      'cli_auth_credentials_store="file"\n' + serializeProfileCopy(copy) + optionalFeatures,
      { flag: 'wx', mode: 0o600 },
    );
    const socketPath = join(scratch.root, 's');
    if (Buffer.byteLength(socketPath) > 100) return networkCheckFail('unsupported');
    listeners.push(makeListener(), makeListener());
    await listen(listeners[0]!, { host: '127.0.0.1', port: 0 });
    await listen(listeners[1]!, socketPath);
    const address = listeners[0]!.server.address();
    if (!address || typeof address === 'string') return networkCheckFail('listener-failed');
    const env = environment(scratch),
      run = async (useNative: boolean) => {
        active(runtime);
        listenersHealthy(listeners);
        const nonce = randomBytes(32).toString('hex'),
          canary = ['-e', NETWORK_CHECK_CANARY_SOURCE, nonce, String(address.port), socketPath];
        const execution = useNative
          ? await runNetworkProcess(
              runtime,
              native.path,
              [
                'sandbox',
                '--permission-profile=' + copy.selectedProfile,
                '--cd=' + scratch!.project,
                '--',
                process.execPath,
                ...canary,
              ],
              scratch!.project,
              env,
            )
          : await runNetworkProcess(runtime, process.execPath, canary, scratch!.project, env);
        await drain();
        listenersHealthy(listeners);
        return { ...execution, wire: decodeCanaryWire(execution.stdout, nonce) };
      };
    options.onProgress?.('positive');
    const positiveRun = await run(false),
      positive = counts(listeners);
    if (positive.some((n) => n > 1)) return networkCheckFail('invalid-report');
    await options.fault?.('after-positive', { scratch });
    let nativeCode: number | null = null,
      nativeWire = null;
    if (
      positiveRun.code === 0 &&
      positiveRun.wire?.results.every((r) => r.code === 'allowed') &&
      positive.every((n) => n === 1)
    ) {
      options.onProgress?.('native');
      active(runtime);
      const verify =
        options.verifyNative ?? ((native) => verifyNetworkNative(native, undefined, runtime));
      await verify(native);
      active(runtime);
      const execution = await run(true);
      nativeCode = execution.code;
      nativeWire = execution.wire;
      await verify(native);
      active(runtime);
      await options.fault?.('after-native', { scratch });
    }
    const connections = counts(listeners).map((n, i) => n - positive[i]!);
    const checks = projectNetworkChecks(nativeWire, positive, connections);
    const base = { checks, nativeExitCode: nativeCode };
    result = {
      scope: 'isolated-permission-copy',
      outcome: codexNetworkCheckOutcome(base),
      nativeBinarySha256: native.sha256,
      profileCopySha256: copySha,
      suiteSha256: getSuiteSha(),
      nativeExitCode: nativeCode,
      cleanupConfirmed: true,
      checks,
      modelCalls: 0,
      providerCalls: 0,
    };
    if (!validateCodexNetworkCheckResult(result)) return networkCheckFail('invalid-report');
  } catch (e) {
    problem = e;
  } finally {
    try {
      options.onProgress?.('cleanup');
      await options.fault?.('before-cleanup', { scratch });
    } catch {
      problem = new Error('cleanup-failed');
    }
    for (const listener of listeners)
      try {
        await closeListener(listener);
      } catch {
        problem = new Error('cleanup-failed');
      }
    if (scratch)
      try {
        removeScratch(scratch);
      } catch {
        problem = new Error('cleanup-failed');
      }
  }
  if (problem)
    return networkCheckFail(
      errorCodes.has((problem as Error).message) ? (problem as Error).message : 'invalid-report',
    );
  if (!result) return networkCheckFail('invalid-report');
  return result;
}
