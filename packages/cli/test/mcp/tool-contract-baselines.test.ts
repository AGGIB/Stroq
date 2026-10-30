import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMcpToolContractBinding,
  createMcpToolContractsStore,
  type ToolContractRecord,
  type ToolContractSnapshot,
} from '../../src/mcp/tool-contracts.js';
import { encodeContractRecord } from '../../src/mcp/tool-contract-record.js';
import { readStateMacKeySync } from '../../src/state-mac.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const listing = (description: string) => ({
  tools: [{ name: 'notes:read', description, inputSchema: { type: 'object' } }],
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stroq-approved-baselines-'));
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
  let tick = Date.parse('2026-10-24T00:00:00.000Z');
  const store = createMcpToolContractsStore({ home, now: () => new Date(tick++) });
  const file = join(home, 'store', 'mcp-contracts', binding.id + '.json');
  return { root, home, binding, store, file };
}
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
async function approved(f: Awaited<ReturnType<typeof fixture>>, description: string) {
  return f.store.decide(request(await f.store.observe(f.binding, listing(description))));
}
/** A changed record signed with the home's own key, so that what is refused is its content. */
function signed(f: Awaited<ReturnType<typeof fixture>>, row: Record<string, unknown>): Buffer {
  const { mac: _mac, ...record } = row;
  return encodeContractRecord(
    record as unknown as ToolContractRecord,
    readStateMacKeySync(f.home)!,
  );
}
interface RetainedFixture {
  schema: string;
  approvedBaselines: {
    toolId: string;
    contractSha256: string;
    decidedAt: string;
    contract: { description: string };
    future?: boolean;
  }[];
}

// The tool-contract store is POSIX-only (private modes, one owner, no group or other write): on Windows
// it refuses (`tool-contract-files.ts`), so there is nothing here to exercise.
describe.skipIf(process.platform === 'win32')('last explicitly approved MCP tool bodies', () => {
  it('keeps the approved body through pending observations, invalidation and revocation', async () => {
    const f = await fixture();
    const a = await approved(f, 'Approved A');
    expect(a.schema).toBe('stroq-mcp-tool-contracts/3');
    expect(a.approvedBaselines).toEqual([
      {
        toolId: a.capture!.tools[0]!.id,
        contractSha256: a.capture!.tools[0]!.sha256,
        decidedAt: a.history[0]!.at,
        contract: listing('Approved A').tools[0],
      },
    ]);
    const b = await f.store.observe(f.binding, listing('Pending B'));
    expect(b.approvedBaselines).toEqual(a.approvedBaselines);
    const c = await f.store.observe(f.binding, listing('Pending C'));
    expect(c.approvedBaselines).toEqual(a.approvedBaselines);
    await f.store.invalidate(f.binding);
    expect((await f.store.read(f.binding))!.approvedBaselines).toEqual(a.approvedBaselines);
    const fresh = await f.store.observe(f.binding, listing('Pending C'));
    const approvedC = await f.store.decide(request(fresh));
    expect(approvedC.approvedBaselines[0]!.contract).toEqual(listing('Pending C').tools[0]);
    expect(approvedC.approvedBaselines[0]!.decidedAt).toBe(approvedC.history.at(-1)!.at);
    expect(approvedC.approvedBaselines[0]!.decidedAt).not.toBe(a.approvedBaselines[0]!.decidedAt);
    const revokedC = await f.store.decide(request(approvedC, 'revoke'));
    expect(revokedC.approvedBaselines).toEqual(approvedC.approvedBaselines);
    expect(revokedC.approvals[0]!.approved).toBe(false);
    expect(
      await f.store.withApproved(f.binding, fresh.capture!.sha256, 'notes:read', () => {}),
    ).toBe(false);
    const d = await f.store.observe(f.binding, listing('Pending D'));
    expect(d.approvedBaselines).toEqual(approvedC.approvedBaselines);
  });

  it('does not invent a baseline for an observation or a revoke without any approval', async () => {
    const f = await fixture();
    await f.store.invalidate(f.binding);
    expect((await f.store.read(f.binding))!.approvedBaselines).toEqual([]);
    const observed = await f.store.observe(f.binding, listing('Unreviewed'));
    expect(observed.approvedBaselines).toEqual([]);
    const revoked = await f.store.decide(request(observed, 'revoke'));
    expect(revoked.approvedBaselines).toEqual([]);
  });

  // Records from before signing (versions 1 and 2) are read as absent: `tool-contract-mac.test.ts`.

  it('keeps the earlier approved version when the latest decision is a revoke of another version', async () => {
    const f = await fixture();
    const a = await approved(f, 'Approved A');
    const b = await f.store.observe(f.binding, listing('Never approved B'));
    await f.store.decide(request(b, 'revoke'));
    const read = (await createMcpToolContractsStore({ home: f.home }).read(f.binding))!;
    expect(read.approvedBaselines).toEqual(a.approvedBaselines);
    expect(read.approvedBaselines[0]!.contract).toEqual(listing('Approved A').tools[0]);
  });

  it('captures independent JSON without sharing caller or read snapshot mutations', async () => {
    const f = await fixture();
    const input = listing('Approved A');
    const a = await f.store.decide(request(await f.store.observe(f.binding, input)));
    input.tools[0]!.description = 'Caller mutation';
    (a.approvedBaselines[0]!.contract as { description: string }).description = 'Snapshot mutation';
    expect((await f.store.read(f.binding))!.approvedBaselines[0]!.contract).toEqual(
      listing('Approved A').tools[0],
    );
  });

  it('preserves bodies of tools absent from newer listings without using them as current authority', async () => {
    const f = await fixture();
    const a = await approved(f, 'Approved A');
    const empty = await f.store.observe(f.binding, { tools: [] });
    expect(empty.approvedBaselines).toEqual(a.approvedBaselines);
    expect(
      await f.store.withApproved(f.binding, empty.capture!.sha256, 'notes:read', () => {}),
    ).toBe(false);
    const other = await f.store.observe(f.binding, {
      tools: [
        { name: 'notes_read', description: 'Distinct raw name', inputSchema: { type: 'object' } },
      ],
    });
    const both = await f.store.decide(request(other));
    expect(both.approvedBaselines).toHaveLength(2);
    expect(new Set(both.approvedBaselines.map((baseline) => baseline.toolId)).size).toBe(2);
    expect(both.approvedBaselines[0]).toEqual(a.approvedBaselines[0]);
  });

  it('refuses stale runtime bytes without advancing the body baseline', async () => {
    const f = await fixture();
    const a = await approved(f, 'Approved A');
    const b = await f.store.observe(f.binding, listing('Pending B'));
    const before = await readFile(f.file);
    await writeFile(f.binding.runtime.entry, '// changed runtime');
    await expect(f.store.decide(request(b))).rejects.toThrow('tool-contract-stale');
    expect(await readFile(f.file)).toEqual(before);
    expect((await f.store.read(f.binding))!.approvedBaselines).toEqual(a.approvedBaselines);
  });

  it('refuses excess retained body bytes atomically without silently pruning an earlier approval', async () => {
    const f = await fixture();
    const large = (i: number) => ({
      tools: [
        { name: 'tool' + i, description: 'x'.repeat(64_000), inputSchema: { type: 'object' } },
      ],
    });
    for (let i = 0; i < 16; i++)
      await f.store.decide(request(await f.store.observe(f.binding, large(i))));
    const pending = await f.store.observe(f.binding, large(16));
    const before = await readFile(f.file);
    await expect(f.store.decide(request(pending))).rejects.toThrow('tool-contract-limit');
    expect(await readFile(f.file)).toEqual(before);
    const current = (await f.store.read(f.binding))!;
    expect(current.approvedBaselines).toHaveLength(16);
    expect(current.approvals).toHaveLength(16);
    expect(current.history).toHaveLength(16);
    expect(current.approvedBaselines[0]!.contract!.name).toBe('tool0');
    expect(current.capture!.tools[0]!.name).toBe('tool16');
  });

  it('never advances the baseline on a refused commit guard or a stale competing approval', async () => {
    const f = await fixture();
    const a = await approved(f, 'Approved A');
    const b = await f.store.observe(f.binding, listing('Pending B'));
    const before = await readFile(f.file);
    await expect(
      f.store.decide(request(b), {
        beforeCommit: async () => {
          throw new Error('tool-contract-stale');
        },
      }),
    ).rejects.toThrow('tool-contract-stale');
    expect(await readFile(f.file)).toEqual(before);
    expect((await f.store.read(f.binding))!.approvedBaselines).toEqual(a.approvedBaselines);
    const other = createMcpToolContractsStore({ home: f.home });
    const results = await Promise.allSettled([
      f.store.decide(request(b)),
      other.decide(request(b)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const current = (await f.store.read(f.binding))!;
    expect(current.approvedBaselines[0]!.contract).toEqual(listing('Pending B').tools[0]);
    expect(current.history).toHaveLength(2);
  });

  it.each([
    [
      'body',
      (row: RetainedFixture) => {
        row.approvedBaselines[0]!.contract.description = 'Forged';
      },
    ],
    [
      'hash',
      (row: RetainedFixture) => {
        row.approvedBaselines[0]!.contractSha256 = 'f'.repeat(64);
      },
    ],
    [
      'identity',
      (row: RetainedFixture) => {
        row.approvedBaselines[0]!.toolId = 'tool-' + 'f'.repeat(64);
      },
    ],
    [
      'time',
      (row: RetainedFixture) => {
        row.approvedBaselines[0]!.decidedAt = '2026-10-23T00:00:00.000Z';
      },
    ],
    [
      'missing',
      (row: RetainedFixture) => {
        row.approvedBaselines = [];
      },
    ],
    [
      'duplicate',
      (row: RetainedFixture) => {
        row.approvedBaselines.push(row.approvedBaselines[0]!);
      },
    ],
    [
      'unknown field',
      (row: RetainedFixture) => {
        row.approvedBaselines[0]!.future = true;
      },
    ],
    [
      'unknown version',
      (row: RetainedFixture) => {
        row.schema = 'stroq-mcp-tool-contracts/4';
      },
    ],
  ])('refuses a malformed retained %s without repairing or replacing it', async (_name, mutate) => {
    const f = await fixture();
    await approved(f, 'Approved A');
    const row = JSON.parse(await readFile(f.file, 'utf8'));
    mutate(row);
    // Signed with the home key: the record's content, not its signature, is what is refused here.
    const bytes = signed(f, row as unknown as Record<string, unknown>).toString('utf8');
    await writeFile(f.file, bytes);
    await expect(f.store.read(f.binding)).rejects.toThrow('tool-contract-invalid');
    await expect(f.store.observe(f.binding, listing('Pending B'))).rejects.toThrow(
      'tool-contract-invalid',
    );
    expect(await readFile(f.file, 'utf8')).toBe(bytes);
  });
});
