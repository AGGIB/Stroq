import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMcpToolContractBinding,
  createMcpToolContractsStore,
  type ToolContractSnapshot,
} from '../../src/mcp/tool-contracts.js';

/**
 * A signed record cannot be forged without the key, but an older record this home signed can be put
 * back: one from before an approval was revoked, say. Nothing a same-user process cannot write records
 * what the newest one was, so the check is per process: each record carries a `sequence` inside the
 * signed body, writers raise it, and a store remembers the highest it has accepted per binding for as
 * long as it lives. The proxy keeps one store for its whole run. A new store accepts the first valid
 * record it sees, older or not: that is the limit, and it is tested as such.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const listing = { tools: [{ name: 'notes:read', inputSchema: { type: 'object' } }] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stroq-contract-rollback-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  const runtimeEntry = join(root, 'runtime', 'cli.js');
  await mkdir(cwd);
  await mkdir(join(root, 'runtime'));
  await writeFile(runtimeEntry, '// inert runtime');
  const binding = await createMcpToolContractBinding({
    home,
    cwd,
    runtimeEntry,
    client: 'cursor',
    server: 'notes',
    command: 'node',
    args: ['server.js'],
    passEnv: [],
  });
  const file = join(home, 'store', 'mcp-contracts', binding.id + '.json');
  const store = () => createMcpToolContractsStore({ home });
  return { binding, file, store };
}
type Store = ReturnType<Awaited<ReturnType<typeof fixture>>['store']>;
function request(snapshot: ToolContractSnapshot, action: 'approve' | 'revoke') {
  const tool = snapshot.capture!.tools[0]!;
  return {
    bindingId: snapshot.binding.id,
    expectedRevision: snapshot.revision,
    expectedCaptureSha256: snapshot.capture!.sha256,
    toolId: tool.id,
    expectedContractSha256: tool.sha256,
    action,
  };
}
/** Whether `store` lets a call through, `false`, or the refusal it throws; the write runs only on true. */
async function lets(store: Store, f: Awaited<ReturnType<typeof fixture>>, capture: string) {
  let wrote = false;
  try {
    const passed = await store.withApproved(f.binding, capture, 'notes:read', () => {
      wrote = true;
    });
    expect(wrote).toBe(passed);
    return passed;
  } catch (error) {
    expect(wrote).toBe(false);
    return (error as Error).message;
  }
}

describe('a signed tool-contract record put back from before', () => {
  it('raises the sequence on every write and keeps it on a write that changes nothing', async () => {
    const f = await fixture();
    const s = f.store();
    const observed = await s.observe(f.binding, listing);
    expect(observed.sequence).toBe(1);
    const approved = await s.decide(request(observed, 'approve'));
    expect(approved.sequence).toBe(2);
    expect((await s.decide(request(approved, 'approve'))).sequence).toBe(2);
    expect((await s.observe(f.binding, listing)).sequence).toBe(2);
    await s.invalidate(f.binding);
    expect((await s.read(f.binding))!.sequence).toBe(3);
    expect((await s.observe(f.binding, listing)).sequence).toBe(4);
  });

  it('a running store accepts n, refuses a replayed n-1, and accepts n+1', async () => {
    const f = await fixture();
    const proxy = f.store();
    const reviewer = f.store();
    const observed = await reviewer.observe(f.binding, listing);
    const approved = await reviewer.decide(request(observed, 'approve'));
    const beforeRevoke = await readFile(f.file);
    const revoked = await reviewer.decide(request(approved, 'revoke'));
    const afterRevoke = await readFile(f.file);
    const capture = revoked.capture!.sha256;
    // The proxy has seen the revocation (n).
    expect(await lets(proxy, f, capture)).toBe(false);
    // A writer puts back the approval it kept (n-1): genuinely signed, but older than what was seen.
    await writeFile(f.file, beforeRevoke, { mode: 0o600 });
    expect(await lets(proxy, f, capture)).toBe('tool-contract-invalid');
    await expect(proxy.read(f.binding)).rejects.toThrow('tool-contract-invalid');
    await expect(proxy.observe(f.binding, listing)).rejects.toThrow('tool-contract-invalid');
    expect(await readFile(f.file)).toEqual(beforeRevoke);
    // The record it saw (n) reads again, and a newer one (n+1), a real approval, is accepted.
    await writeFile(f.file, afterRevoke, { mode: 0o600 });
    expect(await lets(proxy, f, capture)).toBe(false);
    const renewed = await reviewer.decide(request(revoked, 'approve'));
    expect(renewed.sequence).toBe(revoked.sequence + 1);
    expect(await lets(proxy, f, capture)).toBe(true);
  });

  it('a running store refuses a different record at the sequence it already saw', async () => {
    const f = await fixture();
    const proxy = f.store();
    const first = await f.store().observe(f.binding, listing);
    const firstBytes = await readFile(f.file);
    // The proxy has seen the first history of the file at sequence 1.
    expect((await proxy.read(f.binding))!.sequence).toBe(1);
    // The file is removed and another store, which never saw it, starts a second history at 1.
    await rm(f.file);
    const other = await f.store().observe(f.binding, {
      tools: [{ name: 'notes:write', inputSchema: { type: 'object' } }],
    });
    expect(other.sequence).toBe(first.sequence);
    await expect(proxy.read(f.binding)).rejects.toThrow('tool-contract-invalid');
    // The record it saw reads again.
    await writeFile(f.file, firstBytes, { mode: 0o600 });
    expect(await proxy.read(f.binding)).toEqual(first);
  });

  it('a fresh store accepts whatever valid record it first sees, even an older one (the limit)', async () => {
    const f = await fixture();
    const s = f.store();
    const approved = await s.decide(request(await s.observe(f.binding, listing), 'approve'));
    const beforeRevoke = await readFile(f.file);
    await s.decide(request(approved, 'revoke'));
    await writeFile(f.file, beforeRevoke, { mode: 0o600 });
    // A process that starts after the old file was put back has nothing to compare it with.
    expect(await lets(f.store(), f, approved.capture!.sha256)).toBe(true);
  });

  it('writes above what it has seen, even when the file has gone, so it accepts its own record', async () => {
    const f = await fixture();
    const s = f.store();
    const approved = await s.decide(request(await s.observe(f.binding, listing), 'approve'));
    await rm(f.file);
    const fresh = await s.observe(f.binding, listing);
    expect(fresh.sequence).toBe(approved.sequence + 1);
    expect(fresh.approvals).toEqual([]);
    expect(await s.read(f.binding)).toEqual(fresh);
  });
});
