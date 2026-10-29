import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableStringify } from '@stroq/core';
import {
  createMcpToolContractBinding,
  createMcpToolContractsStore,
  type ToolContractRecord,
  type ToolContractSnapshot,
} from '../../src/mcp/tool-contracts.js';
import { encodeContractRecord } from '../../src/mcp/tool-contract-record.js';
import { readStateMacKeySync } from '../../src/state-mac.js';

/**
 * The tool-contract record is the approval the proxy checks before every upstream call. It is signed
 * under the home's state key, so a process that can write `store/mcp-contracts/` but does not hold the
 * key cannot approve a tool by rewriting the file. Every home here is a fresh temporary folder.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const listing = (description = 'Read notes') => ({
  tools: [{ name: 'notes:read', description, inputSchema: { type: 'object' } }],
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stroq-contract-mac-'));
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
  const store = createMcpToolContractsStore({ home });
  const file = join(home, 'store', 'mcp-contracts', binding.id + '.json');
  return { home, binding, store, file, key: join(home, 'keys', 'state-mac.key') };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function request(snapshot: ToolContractSnapshot, action: 'approve' | 'revoke' = 'approve') {
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
const recordOf = ({ revision: _revision, ...record }: ToolContractSnapshot): ToolContractRecord =>
  record;
/** What an approval of the pending tool looks like, made by hand rather than by `decide`. */
function forgedApproval(pending: ToolContractSnapshot): ToolContractRecord {
  const tool = pending.capture!.tools[0]!;
  const at = '2026-10-27T00:00:00.000Z';
  return {
    ...recordOf(pending),
    approvals: [{ toolId: tool.id, contractSha256: tool.sha256, approved: true, decidedAt: at }],
    history: [{ action: 'approve', toolId: tool.id, contractSha256: tool.sha256, at }],
    approvedBaselines: [
      { toolId: tool.id, contractSha256: tool.sha256, decidedAt: at, contract: tool.contract },
    ],
  };
}
/** Whether the store lets a call through for the pending capture, and whether it ran the write. */
async function lets(f: Fixture, snapshot: ToolContractSnapshot): Promise<boolean | string> {
  let wrote = false;
  try {
    const passed = await f.store.withApproved(
      f.binding,
      snapshot.capture!.sha256,
      'notes:read',
      () => {
        wrote = true;
      },
    );
    expect(wrote).toBe(passed);
    return passed;
  } catch (error) {
    expect(wrote).toBe(false);
    return (error as Error).message;
  }
}

describe('signed MCP tool-contract records', () => {
  it('signs every record under a private home key and reads its own records back', async () => {
    const f = await fixture();
    const pending = await f.store.observe(f.binding, listing());
    const approved = await f.store.decide(request(pending));
    const row = JSON.parse(await readFile(f.file, 'utf8'));
    expect(row.schema).toBe('stroq-mcp-tool-contracts/3');
    expect(row.mac).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(f.key)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.home, 'keys'))).mode & 0o777).toBe(0o700);
    const again = createMcpToolContractsStore({ home: f.home });
    expect(await again.read(f.binding)).toEqual(approved);
    expect((await again.list()).records).toEqual([approved]);
    expect(await lets(f, approved)).toBe(true);
    // The snapshot is the record; the signature is a property of the file, not of the record.
    expect(approved).not.toHaveProperty('mac');
  });

  it('refuses an approval written with a plain digest where the signature goes, and keeps the file', async () => {
    const f = await fixture();
    const pending = await f.store.observe(f.binding, listing());
    const forged = forgedApproval(pending);
    const digest = createHash('sha256').update(stableStringify(forged)).digest('hex');
    const bytes = stableStringify({ ...forged, mac: digest }) + '\n';
    await writeFile(f.file, bytes, { mode: 0o600 });
    expect(await lets(f, pending)).toBe('tool-contract-invalid');
    await expect(f.store.read(f.binding)).rejects.toThrow('tool-contract-invalid');
    await expect(f.store.list()).rejects.toThrow('tool-contract-invalid');
    await expect(f.store.observe(f.binding, listing())).rejects.toThrow('tool-contract-invalid');
    await expect(f.store.invalidate(f.binding)).rejects.toThrow('tool-contract-invalid');
    // A forgery is evidence: it is never replaced or repaired by a later listing.
    expect(await readFile(f.file, 'utf8')).toBe(bytes);
  });

  it('refuses an approval signed with a key of its own', async () => {
    const f = await fixture();
    const pending = await f.store.observe(f.binding, listing());
    await writeFile(f.file, encodeContractRecord(forgedApproval(pending), randomBytes(32)), {
      mode: 0o600,
    });
    expect(await lets(f, pending)).toBe('tool-contract-invalid');
    await expect(f.store.read(f.binding)).rejects.toThrow('tool-contract-invalid');
  });

  it('accepts the same approval when the home key signed it, so the check is the key and not the shape', async () => {
    const f = await fixture();
    const pending = await f.store.observe(f.binding, listing());
    const key = readStateMacKeySync(f.home)!;
    // A writer that holds the key raises the sequence, as every write does.
    const signed = { ...forgedApproval(pending), sequence: pending.sequence + 1 };
    await writeFile(f.file, encodeContractRecord(signed, key), { mode: 0o600 });
    expect(await lets(f, pending)).toBe(true);
  });

  it('refuses a signed record when the home key is missing or not private', async () => {
    const f = await fixture();
    const approved = await f.store.decide(request(await f.store.observe(f.binding, listing())));
    const key = await readFile(f.key);
    await chmod(f.key, 0o644);
    expect(await lets(f, approved)).toBe('tool-contract-unavailable');
    await expect(f.store.read(f.binding)).rejects.toThrow('tool-contract-unavailable');
    await rm(f.key);
    expect(await lets(f, approved)).toBe('tool-contract-invalid');
    await expect(f.store.read(f.binding)).rejects.toThrow('tool-contract-invalid');
    // No writer makes a new key over records it cannot check, for this binding or another one.
    await expect(f.store.observe(f.binding, listing('Changed'))).rejects.toThrow(
      'tool-contract-invalid',
    );
    const other = await createMcpToolContractBinding({
      home: f.home,
      cwd: f.binding.cwd,
      runtimeEntry: f.binding.runtime.entry,
      client: 'cursor',
      server: 'other',
      command: 'node',
      args: ['server.js'],
      passEnv: [],
    });
    await expect(f.store.observe(other, listing())).rejects.toThrow('tool-contract-invalid');
    await expect(stat(f.key)).rejects.toThrow();
    await writeFile(f.key, key, { mode: 0o600 });
    expect(await f.store.read(f.binding)).toEqual(approved);
    expect(await lets(f, approved)).toBe(true);
  });

  it.each(['stroq-mcp-tool-contracts/2', 'stroq-mcp-tool-contracts/1'])(
    'reads an unsigned %s record as absent, so its approvals are not used and the next listing replaces it',
    async (schema) => {
      const f = await fixture();
      const approved = await f.store.decide(request(await f.store.observe(f.binding, listing())));
      const { mac: _mac, ...row } = JSON.parse(await readFile(f.file, 'utf8'));
      const old = {
        ...row,
        schema,
        ...(schema.endsWith('/1') ? { approvedBaselines: undefined } : {}),
      };
      await writeFile(f.file, stableStringify(old) + '\n', { mode: 0o600 });
      expect(await f.store.read(f.binding)).toBeNull();
      expect((await f.store.list()).records).toEqual([]);
      expect(await lets(f, approved)).toBe(false);
      await expect(f.store.decide(request(approved, 'revoke'))).rejects.toThrow(
        'tool-contract-stale',
      );
      // The next listing writes a signed record with no approval in it: each tool is approved again.
      const fresh = await f.store.observe(f.binding, listing());
      expect(fresh.schema).toBe('stroq-mcp-tool-contracts/3');
      expect(fresh.approvals).toEqual([]);
      expect(fresh.history).toEqual([]);
      expect(fresh.approvedBaselines).toEqual([]);
      expect(await lets(f, fresh)).toBe(false);
      const renewed = await f.store.decide(request(fresh));
      expect(await lets(f, renewed)).toBe(true);
    },
  );

  it('replaces an unsigned record on invalidation too, without carrying its approvals', async () => {
    const f = await fixture();
    await f.store.decide(request(await f.store.observe(f.binding, listing())));
    const { mac: _mac, ...row } = JSON.parse(await readFile(f.file, 'utf8'));
    await writeFile(
      f.file,
      stableStringify({ ...row, schema: 'stroq-mcp-tool-contracts/2' }) + '\n',
      { mode: 0o600 },
    );
    await f.store.invalidate(f.binding);
    const after = (await f.store.read(f.binding))!;
    expect(after.observation).toBe('invalidated');
    expect(after.capture).toBeNull();
    expect(after.approvals).toEqual([]);
    expect(after.approvedBaselines).toEqual([]);
  });
});
