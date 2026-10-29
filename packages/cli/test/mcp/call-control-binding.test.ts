import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpCallControlBinding } from '../../src/mcp/call-control-binding.js';

let root: string;
const control = '11111111-2222-4333-8444-555555555555';
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-call-binding-')));
  await mkdir(join(root, 'project'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const input = () => ({
  home: join(root, '.stroq'),
  cwd: join(root, 'project'),
  controlId: control,
  client: 'cursor',
  server: 'fixture',
  command: 'inert-server',
  args: ['--value', 'PRIVATE_ARG'],
  passEnv: ['TOKEN'],
  environment: { TOKEN: 'PRIVATE_VALUE', UNDECLARED: 'unused' },
});
describe('MCP call-control invocation binding', () => {
  it('is read-only and hashes only canonical declared invocation without retaining source values', async () => {
    const a = await createMcpCallControlBinding(input());
    expect(a).toMatchObject({ home: join(root, '.stroq'), controlId: control });
    expect(a.invocationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(a)).not.toMatch(/PRIVATE_ARG|PRIVATE_VALUE|UNDECLARED/);
    const b = await createMcpCallControlBinding({
      ...input(),
      environment: { TOKEN: 'PRIVATE_VALUE', UNDECLARED: 'changed' },
    });
    expect(b).toEqual(a);
    await expect(realpath(join(root, '.stroq'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('changes with source identity, mode, declared environment and original upstream invocation', async () => {
    const a = await createMcpCallControlBinding(input());
    for (const change of [
      { server: 'other' },
      { client: 'other' },
      { command: 'other' },
      { args: ['different'] },
      { environment: { TOKEN: 'changed' } },
      { strict: true },
      { cloak: true },
      { pin: `sha256:${'a'.repeat(64)}` },
      { strict: true, toolApproval: true },
    ])
      expect(
        (await createMcpCallControlBinding({ ...input(), ...change })).invocationSha256,
      ).not.toBe(a.invocationSha256);
    await rename(join(root, 'project'), join(root, 'old-project'));
    await mkdir(join(root, 'project'));
    expect((await createMcpCallControlBinding(input())).invocationSha256).not.toBe(
      a.invocationSha256,
    );
  });
  it('does not include the control UUID in invocation semantics and normalizes declared names', async () => {
    const a = await createMcpCallControlBinding({
      ...input(),
      passEnv: ['B', 'A'],
      environment: { A: 'a', B: 'b' },
    });
    const b = await createMcpCallControlBinding({
      ...input(),
      controlId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      passEnv: ['A', 'B'],
      environment: { B: 'b', A: 'a' },
    });
    expect(b.invocationSha256).toBe(a.invocationSha256);
  });
  it('preserves an explicit empty upstream argument while refusing an unknown client context', async () => {
    expect(
      (await createMcpCallControlBinding({ ...input(), args: [''] })).invocationSha256,
    ).toMatch(/^[a-f0-9]{64}$/);
    await expect(createMcpCallControlBinding({ ...input(), client: 'unknown' })).rejects.toThrow(
      'mcp-call-control-unsupported',
    );
  });
  it('refuses ambiguous environment and invalid identities or mode combinations', async () => {
    for (const change of [
      { passEnv: null },
      { passEnv: ['TOKEN', 'TOKEN'] },
      { passEnv: ['BAD-NAME'] },
      { controlId: '../outside' },
      { strict: false, toolApproval: true },
      { strict: true, toolApproval: true, cloak: true },
      { strictMaxWithheld: 1 },
      { strict: true, strictMaxWithheld: 0 },
      { args: ['bad\u0000arg'] },
    ])
      await expect(createMcpCallControlBinding({ ...input(), ...change })).rejects.toThrow(
        /mcp-call-control-(?:invalid|unsupported)/,
      );
  });
});
