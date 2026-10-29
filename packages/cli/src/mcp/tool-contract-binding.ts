import { realpath, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { canonicalContractPath } from './tool-contract-files.js';
import {
  contractError,
  TOOL_CONTRACT_ERRORS,
  type ToolContractBinding,
} from './tool-contract-types.js';
import {
  contractHash,
  contractRecord,
  contractSha,
  exactContractKeys,
} from './tool-contract-canonical.js';
import { hashToolContractRuntime } from './tool-contract-runtime.js';
import { DEFAULT_STRICT_MAX_WITHHELD } from './strict-limits.js';

export interface ToolContractBindingInput {
  readonly home: string;
  readonly cwd: string;
  readonly client: string;
  readonly server: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly passEnv: readonly string[] | null;
  readonly strictMaxWithheld?: number;
  readonly pin?: string;
  readonly runtimeEntry: string;
  readonly runtimeSha256?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly launch?: { readonly command: string; readonly argv: readonly string[] };
}
const text = (v: unknown, max = 8192): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\u0000');
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length <= 512 &&
  v.every((s) => typeof s === 'string' && s.length <= 8192 && !s.includes('\u0000'));
const fields = [
  'schema',
  'id',
  'home',
  'cwd',
  'cwdIdentity',
  'client',
  'server',
  'command',
  'args',
  'passEnv',
  'envSha256',
  'strictMaxWithheld',
  'pin',
  'runtime',
  'launch',
];
export function validateToolContractBinding(v: unknown): v is ToolContractBinding {
  if (
    !contractRecord(v) ||
    Object.keys(v).length !== fields.length ||
    !exactContractKeys(v, fields) ||
    v.schema !== 'stroq-mcp-tool-binding/1'
  )
    return false;
  if (
    !text(v.home) ||
    !isAbsolute(v.home) ||
    !text(v.cwd) ||
    !isAbsolute(v.cwd) ||
    !text(v.client, 128) ||
    !text(v.server, 128) ||
    !text(v.command) ||
    !strings(v.args) ||
    !strings(v.passEnv) ||
    !v.passEnv.every((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) ||
    new Set(v.passEnv).size !== v.passEnv.length ||
    !contractHash(v.envSha256)
  )
    return false;
  if (
    !contractRecord(v.cwdIdentity) ||
    Object.keys(v.cwdIdentity).length !== 2 ||
    !exactContractKeys(v.cwdIdentity, ['dev', 'ino']) ||
    typeof v.cwdIdentity.dev !== 'string' ||
    !/^\d+$/.test(v.cwdIdentity.dev) ||
    typeof v.cwdIdentity.ino !== 'string' ||
    !/^\d+$/.test(v.cwdIdentity.ino)
  )
    return false;
  if (
    !Number.isSafeInteger(v.strictMaxWithheld) ||
    (v.strictMaxWithheld as number) < 1 ||
    (v.strictMaxWithheld as number) > 10000 ||
    (v.pin !== null && !text(v.pin, 512))
  )
    return false;
  if (
    !contractRecord(v.runtime) ||
    Object.keys(v.runtime).length !== 2 ||
    !exactContractKeys(v.runtime, ['entry', 'sha256']) ||
    !text(v.runtime.entry) ||
    !isAbsolute(v.runtime.entry) ||
    !contractHash(v.runtime.sha256)
  )
    return false;
  if (
    v.launch !== null &&
    (!contractRecord(v.launch) ||
      Object.keys(v.launch).length !== 2 ||
      !exactContractKeys(v.launch, ['command', 'argv']) ||
      !text(v.launch.command) ||
      !strings(v.launch.argv))
  )
    return false;
  const { id, ...body } = v;
  return id === 'binding-' + contractSha('stroq-mcp-tool-binding/1', body);
}
export async function createMcpToolContractBinding(
  input: ToolContractBindingInput,
): Promise<ToolContractBinding> {
  if (input.passEnv === null) contractError('tool-contract-unsupported');
  try {
    const home = await canonicalContractPath(input.home);
    const cwd = await realpath(input.cwd);
    const entry = await realpath(input.runtimeEntry);
    const cwdStat = await lstat(cwd, { bigint: true });
    if (
      !cwdStat.isDirectory() ||
      cwdStat.isSymbolicLink() ||
      (process.getuid && cwdStat.uid !== BigInt(process.getuid()))
    )
      contractError('tool-contract-unavailable');
    const cwdIdentity = { dev: String(cwdStat.dev), ino: String(cwdStat.ino) };
    const names = [...input.passEnv].sort();
    const environment = input.environment ?? process.env;
    const body = {
      schema: 'stroq-mcp-tool-binding/1' as const,
      home,
      cwd,
      cwdIdentity,
      client: input.client,
      server: input.server,
      command: input.command,
      args: [...input.args],
      passEnv: names,
      envSha256: contractSha(
        'stroq-mcp-tool-environment/1',
        names.map((name) => [name, environment[name] ?? null]),
      ),
      strictMaxWithheld: input.strictMaxWithheld ?? DEFAULT_STRICT_MAX_WITHHELD,
      pin: input.pin ?? null,
      runtime: { entry, sha256: input.runtimeSha256 ?? (await hashToolContractRuntime(entry)) },
      launch: input.launch ? { command: input.launch.command, argv: [...input.launch.argv] } : null,
    };
    const binding = { ...body, id: 'binding-' + contractSha('stroq-mcp-tool-binding/1', body) };
    if (!validateToolContractBinding(binding)) contractError('tool-contract-invalid');
    return binding;
  } catch (e) {
    if (e instanceof Error && TOOL_CONTRACT_ERRORS.some((code) => code === e.message)) throw e;
    return contractError('tool-contract-unavailable');
  }
}
export async function assertToolContractWorkspace(binding: ToolContractBinding): Promise<void> {
  try {
    const s = await lstat(binding.cwd, { bigint: true });
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      String(s.dev) !== binding.cwdIdentity.dev ||
      String(s.ino) !== binding.cwdIdentity.ino ||
      (await realpath(binding.cwd)) !== binding.cwd
    )
      contractError('tool-contract-stale');
  } catch {
    contractError('tool-contract-stale');
  }
}
