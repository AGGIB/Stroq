import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_STRICT_MAX_WITHHELD, MAX_STRICT_MAX_WITHHELD } from './strict-limits.js';
import { MCP_PIN } from './pin-argument.js';
import {
  callControlError,
  callControlUuid,
  type McpCallControlBinding,
  type McpCallControlBindingInput,
} from './call-control-types.js';

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0');

async function canonicalMissing(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  const parent = dirname(absolute);
  if (parent === absolute) return callControlError('mcp-call-control-unavailable');
  return join(await canonicalMissing(parent), absolute.slice(parent.length + 1));
}

/** Read-only semantic identity, computed before pin preparation changes upstream paths. */
export async function createMcpCallControlBinding(
  input: McpCallControlBindingInput,
): Promise<McpCallControlBinding> {
  if (process.platform === 'win32') callControlError('mcp-call-control-unsupported');
  if (input.client === 'unknown') callControlError('mcp-call-control-unsupported');
  if (
    !callControlUuid(input.controlId) ||
    ![input.home, input.cwd, input.client, input.server, input.command].every(text) ||
    !Array.isArray(input.args) ||
    !input.args.every((arg) => typeof arg === 'string' && !arg.includes('\0')) ||
    !Array.isArray(input.passEnv) ||
    !input.passEnv.every(
      (name) => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
    ) ||
    new Set(input.passEnv).size !== input.passEnv.length ||
    ![input.strict, input.cloak, input.toolApproval].every(
      (flag) => flag === undefined || typeof flag === 'boolean',
    ) ||
    (input.toolApproval === true && (input.strict !== true || input.cloak === true)) ||
    (input.strictMaxWithheld !== undefined &&
      (input.strict !== true ||
        !Number.isInteger(input.strictMaxWithheld) ||
        input.strictMaxWithheld < 1 ||
        input.strictMaxWithheld > MAX_STRICT_MAX_WITHHELD)) ||
    (input.pin !== undefined && !MCP_PIN.test(input.pin))
  )
    callControlError('mcp-call-control-invalid');
  try {
    const home = await canonicalMissing(input.home);
    const cwd = await realpath(input.cwd);
    const directory = await lstat(cwd, { bigint: true });
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (directory.mode & 0o022n) !== 0n ||
      (process.getuid !== undefined && directory.uid !== BigInt(process.getuid()))
    )
      callControlError('mcp-call-control-unavailable');
    const environment = input.environment ?? process.env;
    const declared = [...input.passEnv!].sort().map((name) => {
      const value = environment[name];
      if (value !== undefined && (typeof value !== 'string' || value.includes('\0')))
        callControlError('mcp-call-control-invalid');
      return [name, value === undefined ? null : hash(value)];
    });
    return {
      home,
      controlId: input.controlId,
      invocationSha256: hash({
        schema: 'stroq-mcp-call-control-invocation/1',
        home,
        cwd: { path: cwd, dev: String(directory.dev), ino: String(directory.ino) },
        client: input.client,
        server: input.server,
        command: input.command,
        args: input.args,
        declared,
        strict: input.strict === true,
        cloak: input.cloak === true,
        toolApproval: input.toolApproval === true,
        strictMaxWithheld:
          input.strict === true ? (input.strictMaxWithheld ?? DEFAULT_STRICT_MAX_WITHHELD) : null,
        pin: input.pin ?? null,
      }),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('mcp-call-control-')) throw error;
    return callControlError('mcp-call-control-unavailable');
  }
}
