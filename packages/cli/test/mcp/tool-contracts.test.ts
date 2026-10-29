import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  chmod,
  stat,
  rename,
  symlink,
} from 'node:fs/promises';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMcpToolContractBinding,
  createMcpToolContractsStore,
  parseToolContractJson,
  canonicalizeToolsList,
  type ToolContractRecord,
} from '../../src/mcp/tool-contracts.js';
import { encodeContractRecord } from '../../src/mcp/tool-contract-record.js';
import { readStateMacKeySync } from '../../src/state-mac.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stroq-contracts-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  const runtimeEntry = join(root, 'runtime', 'cli.js');
  await mkdir(cwd);
  await mkdir(join(root, 'runtime'));
  await writeFile(runtimeEntry, '// inert fixture');
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
  return { root, home, cwd, binding, store: createMcpToolContractsStore({ home }) };
}
async function approve(f: Awaited<ReturnType<typeof fixture>>) {
  const snap = await f.store.observe(f.binding, listing());
  const tool = snap.capture!.tools[0]!;
  const request = {
    bindingId: f.binding.id,
    expectedRevision: snap.revision,
    expectedCaptureSha256: snap.capture!.sha256,
    toolId: tool.id,
    expectedContractSha256: tool.sha256,
    action: 'approve' as const,
  };
  return { snap: await f.store.decide(request), tool, request };
}
/** A changed record signed with the home's own key, so that what a test checks is its content. */
function signed(home: string, row: Record<string, unknown>): Buffer {
  const { mac: _mac, ...record } = row;
  return encodeContractRecord(record as unknown as ToolContractRecord, readStateMacKeySync(home)!);
}
const listing = (description = 'Read notes') => ({
  tools: [{ name: 'read:notes', description, inputSchema: { type: 'object', properties: {} } }],
});
describe('exact MCP tool contract authority', () => {
  it('keeps reads absent and requires explicit exact approval before discovery or dispatch', async () => {
    const f = await fixture();
    expect(await f.store.read(f.binding)).toBeNull();
    expect(await f.store.list()).toEqual({ records: [], limited: false });
    await expect(readdir(f.home)).rejects.toMatchObject({ code: 'ENOENT' });
    const snap = await f.store.observe(f.binding, listing());
    const tool = snap.capture!.tools[0]!;
    let sent = 0;
    expect(
      await f.store.withApproved(f.binding, snap.capture!.sha256, tool.name, () => {
        sent++;
      }),
    ).toBe(false);
    const approved = await f.store.decide({
      bindingId: f.binding.id,
      expectedRevision: snap.revision,
      expectedCaptureSha256: snap.capture!.sha256,
      toolId: tool.id,
      expectedContractSha256: tool.sha256,
      action: 'approve',
    });
    expect(
      await f.store.withApproved(f.binding, snap.capture!.sha256, null, () => {
        sent++;
      }),
    ).toBe(true);
    expect(sent).toBe(1);
    expect(approved.history).toHaveLength(1);
    const changed = await f.store.observe(f.binding, listing('Now deletes notes'));
    expect(
      await f.store.withApproved(f.binding, changed.capture!.sha256, tool.name, () => {
        sent++;
      }),
    ).toBe(false);
    await expect(
      f.store.decide({
        bindingId: f.binding.id,
        expectedRevision: snap.revision,
        expectedCaptureSha256: snap.capture!.sha256,
        toolId: tool.id,
        expectedContractSha256: tool.sha256,
        action: 'approve',
      }),
    ).rejects.toThrow('tool-contract-stale');
    expect(sent).toBe(1);
  });
  it('rejects raw duplicates, lossy numbers, pagination, duplicates and unknown tool fields', () => {
    for (const raw of ['{"a":1,"\\u0061":2}', '{"n":9007199254740993}', '{"n":1e-999}', '{"n":-0}'])
      expect(() => parseToolContractJson(raw)).toThrow('tool-contract-invalid');
    expect(() => canonicalizeToolsList({ ...listing(), nextCursor: '' })).toThrow(
      'tool-contract-unsupported',
    );
    expect(() =>
      canonicalizeToolsList({ tools: [listing().tools[0], listing().tools[0]] }),
    ).toThrow('tool-contract-invalid');
    expect(() =>
      canonicalizeToolsList({ tools: [{ ...listing().tools[0], futureField: true }] }),
    ).toThrow('tool-contract-unsupported');
  });
  it('hashes every supported tool field with stable key order and exact names', () => {
    const a = canonicalizeToolsList(listing());
    const b = canonicalizeToolsList({
      tools: [
        {
          inputSchema: { properties: {}, type: 'object' },
          description: 'Read notes',
          name: 'read:notes',
        },
      ],
    });
    expect(a.sha256).toBe(b.sha256);
    expect(
      canonicalizeToolsList({
        tools: [{ ...listing().tools[0], annotations: { readOnlyHint: true } }],
      }).sha256,
    ).not.toBe(a.sha256);
    expect(
      canonicalizeToolsList({ tools: [{ ...listing().tools[0], name: 'read_notes' }] }).tools[0]!
        .id,
    ).not.toBe(a.tools[0]!.id);
    for (const fields of [
      { title: 'Read note' },
      { outputSchema: { type: 'object' } },
      { _meta: { version: '2' } },
      { execution: { taskSupport: 'optional' } },
      { icons: [{ src: 'https://never-fetch.invalid/icon.png' }] },
    ])
      expect(
        canonicalizeToolsList({ tools: [{ ...listing().tools[0], ...fields }] }).sha256,
      ).not.toBe(a.sha256);
  });
  it('never replaces a malformed retained record', async () => {
    const f = await fixture();
    await f.store.observe(f.binding, listing());
    const file = join(f.home, 'store', 'mcp-contracts', f.binding.id + '.json');
    await writeFile(file, '{"schema":1,"schema":2}', { mode: 0o600 });
    await expect(f.store.observe(f.binding, listing())).rejects.toThrow('tool-contract-invalid');
    expect(await readFile(file, 'utf8')).toBe('{"schema":1,"schema":2}');
  });
  it('refuses unsupported numeric-key serialization before publishing any authority', async () => {
    const f = await fixture();
    await expect(
      f.store.observe(f.binding, {
        tools: [
          { name: 'numeric', inputSchema: { type: 'object', properties: { '2': {}, '10': {} } } },
        ],
      }),
    ).rejects.toThrow(/tool-contract-/);
    await expect(
      readFile(join(f.home, 'store', 'mcp-contracts', f.binding.id + '.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses malformed Unicode and control object keys before publishing authority', async () => {
    const f = await fixture();
    for (const key of ['\ud800', '\udc00', '\ufffd', 'field\u0000value']) {
      await expect(
        f.store.observe(f.binding, {
          tools: [{ name: 'bad-key', inputSchema: { type: 'object', properties: { [key]: {} } } }],
        }),
      ).rejects.toThrow('tool-contract-invalid');
    }
    await expect(
      readFile(join(f.home, 'store', 'mcp-contracts', f.binding.id + '.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('invalidates a complete listing without silently approving its replacement', async () => {
    const f = await fixture();
    const { snap, tool } = await approve(f);
    await f.store.invalidate(f.binding, 'untrusted detail must never persist');
    expect((await f.store.read(f.binding))!.observation).toBe('invalidated');
    expect(await f.store.withApproved(f.binding, snap.capture!.sha256, tool.name, () => {})).toBe(
      false,
    );
    const again = await f.store.observe(f.binding, listing());
    expect(await f.store.withApproved(f.binding, again.capture!.sha256, tool.name, () => {})).toBe(
      true,
    );
    expect(JSON.stringify(await f.store.list())).not.toContain('untrusted detail');
  });
  it('serializes competing exact decisions and honors revocation in another store instance', async () => {
    const f = await fixture();
    const { snap, tool } = await approve(f);
    const other = createMcpToolContractsStore({ home: f.home });
    const request = {
      bindingId: f.binding.id,
      expectedRevision: snap.revision,
      expectedCaptureSha256: snap.capture!.sha256,
      toolId: tool.id,
      expectedContractSha256: tool.sha256,
      action: 'revoke' as const,
    };
    const outcomes = await Promise.allSettled([f.store.decide(request), other.decide(request)]);
    expect(outcomes.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((v) => v.status === 'rejected')).toHaveLength(1);
    expect(
      await other.withApproved(f.binding, snap.capture!.sha256, tool.name, () => {
        throw new Error('must not send');
      }),
    ).toBe(false);
  });
  it('keeps identical observations byte-stable and private across restart', async () => {
    const f = await fixture();
    const { snap } = await approve(f);
    const file = join(f.home, 'store', 'mcp-contracts', f.binding.id + '.json');
    const before = await stat(file);
    const again = await f.store.observe(f.binding, listing());
    expect(again.revision).toBe(snap.revision);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.home, 'store', 'mcp-contracts'))).mode & 0o777).toBe(0o700);
    expect((await createMcpToolContractsStore({ home: f.home }).read(f.binding))!.revision).toBe(
      snap.revision,
    );
  });
  it('refuses permissive files, symlinks and directory replacement without repairing them', async () => {
    const f = await fixture();
    const { snap, tool } = await approve(f);
    const file = join(f.home, 'store', 'mcp-contracts', f.binding.id + '.json');
    await chmod(file, 0o644);
    await expect(
      f.store.withApproved(f.binding, snap.capture!.sha256, tool.name, () => {}),
    ).rejects.toThrow('tool-contract-unavailable');
    await chmod(file, 0o600);
    await rename(file, file + '.saved');
    await symlink(file + '.saved', file);
    await expect(f.store.read(f.binding)).rejects.toThrow('tool-contract-unavailable');
    await rm(file);
    await rename(file + '.saved', file);
    await rename(f.cwd, f.cwd + '.old');
    await mkdir(f.cwd);
    await expect(
      f.store.withApproved(f.binding, snap.capture!.sha256, tool.name, () => {}),
    ).rejects.toThrow('tool-contract-stale');
  });
  it('binds exact invocation, declared environment values and raw server/tool tuples', async () => {
    const f = await fixture();
    const base = {
      home: f.home,
      cwd: f.cwd,
      runtimeEntry: f.binding.runtime.entry,
      client: 'cursor',
      server: 'notes',
      command: 'node',
      args: ['server.js'],
      passEnv: ['KEY'],
      environment: { KEY: 'private-value' },
    };
    const a = await createMcpToolContractBinding(base);
    const b = await createMcpToolContractBinding({ ...base, environment: { KEY: 'other-value' } });
    expect(a.id).not.toBe(b.id);
    expect(JSON.stringify(a)).not.toContain('private-value');
    expect((await createMcpToolContractBinding({ ...base, args: ['other.js'] })).id).not.toBe(a.id);
    await expect(createMcpToolContractBinding({ ...base, passEnv: null })).rejects.toThrow(
      'tool-contract-unsupported',
    );
    const left = await f.store.observe(a, {
      tools: [{ name: 'x:y', inputSchema: { type: 'object' } }],
    });
    const otherBinding = await createMcpToolContractBinding({ ...base, server: 'notes:x' });
    const right = await f.store.observe(otherBinding, {
      tools: [{ name: 'y', inputSchema: { type: 'object' } }],
    });
    expect(left.capture!.tools[0]!.id).not.toBe(right.capture!.tools[0]!.id);
  });
  it('refuses incomplete and hostile contracts and raw malformed UTF-8 without executing getters', () => {
    expect(() =>
      parseToolContractJson(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])),
    ).toThrow('tool-contract-invalid');
    expect(() => parseToolContractJson('{"x":"\\ufffd"}')).toThrow('tool-contract-invalid');
    expect(() =>
      canonicalizeToolsList({ ...listing(), _meta: { instructions: 'do not show' } }),
    ).toThrow('tool-contract-unsupported');
    expect(() =>
      canonicalizeToolsList({
        tools: [{ name: 'x', inputSchema: { type: 'object' }, description: 'a'.repeat(66000) }],
      }),
    ).toThrow('tool-contract-limit');
    expect(() =>
      canonicalizeToolsList({
        tools: Array.from({ length: 257 }, (_, i) => ({
          name: 'x' + i,
          inputSchema: { type: 'object' },
        })),
      }),
    ).toThrow('tool-contract-limit');
    let invoked = false;
    expect(() =>
      canonicalizeToolsList({
        get tools() {
          invoked = true;
          return [];
        },
      }),
    ).toThrow('tool-contract-invalid');
    expect(invoked).toBe(false);
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => canonicalizeToolsList({ tools: sparse })).toThrow('tool-contract-invalid');
  });
  it('refuses an approved call and decision after adjacent runtime bytes change', async () => {
    const f = await fixture();
    const { snap, tool } = await approve(f);
    await writeFile(f.binding.runtime.entry, '// changed runtime graph');
    await expect(
      f.store.withApproved(f.binding, snap.capture!.sha256, tool.name, () => {
        throw new Error('must not dispatch');
      }),
    ).rejects.toThrow('tool-contract-stale');
    await expect(f.store.observe(f.binding, listing())).rejects.toThrow('tool-contract-stale');
    await expect(
      f.store.decide({
        bindingId: f.binding.id,
        expectedRevision: snap.revision,
        expectedCaptureSha256: snap.capture!.sha256,
        toolId: tool.id,
        expectedContractSha256: tool.sha256,
        action: 'revoke',
      }),
    ).rejects.toThrow('tool-contract-stale');
    expect((await f.store.read(f.binding))!.revision).toBe(snap.revision);
  });
  it('retains complete deep captures and refuses unknown retained approval metadata', async () => {
    const f = await fixture();
    let nested: unknown = { type: 'string' };
    for (let i = 0; i < 18; i++) nested = { nested };
    const snap = await f.store.observe(f.binding, {
      tools: [{ name: 'deep', inputSchema: { type: 'object', properties: { deep: nested } } }],
    });
    expect((await f.store.read(f.binding))!.capture!.sha256).toBe(snap.capture!.sha256);
    const file = join(f.home, 'store', 'mcp-contracts', f.binding.id + '.json');
    const row = JSON.parse(await readFile(file, 'utf8'));
    row.futureAuthority = true;
    await writeFile(file, signed(f.home, row));
    await expect(f.store.list()).rejects.toThrow('tool-contract-invalid');
  });
  it('fails closed at the binding cap without evicting any existing approval', async () => {
    const f = await fixture();
    const { snap } = await approve(f);
    for (let i = 1; i < 64; i++) {
      const binding = await createMcpToolContractBinding({
        home: f.home,
        cwd: f.cwd,
        runtimeEntry: f.binding.runtime.entry,
        client: 'cursor',
        server: 'fixture' + i,
        command: 'node',
        args: ['server.js'],
        passEnv: [],
      });
      await f.store.observe(binding, { tools: [] });
    }
    const extra = await createMcpToolContractBinding({
      home: f.home,
      cwd: f.cwd,
      runtimeEntry: f.binding.runtime.entry,
      client: 'cursor',
      server: 'fixture-extra',
      command: 'node',
      args: ['server.js'],
      passEnv: [],
    });
    await expect(f.store.observe(extra, { tools: [] })).rejects.toThrow('tool-contract-limit');
    expect((await f.store.list()).records).toHaveLength(64);
    expect((await f.store.read(f.binding))!.revision).toBe(snap.revision);
  });
  it('refuses full decision history without losing or replacing it', async () => {
    const f = await fixture();
    const { snap, tool } = await approve(f);
    const file = join(f.home, 'store', 'mcp-contracts', f.binding.id + '.json');
    const row = JSON.parse(await readFile(file, 'utf8'));
    const at = row.approvals[0].decidedAt;
    row.history = Array.from({ length: 1024 }, (_, i) => ({
      action: i % 2 === 0 ? 'approve' : 'revoke',
      toolId: tool.id,
      contractSha256: tool.sha256,
      at,
    }));
    row.approvals[0].approved = false;
    row.sequence += 1;
    await writeFile(file, signed(f.home, row));
    const current = (await f.store.read(f.binding))!;
    const bytes = await readFile(file);
    await expect(
      f.store.decide({
        bindingId: f.binding.id,
        expectedRevision: current.revision,
        expectedCaptureSha256: snap.capture!.sha256,
        toolId: tool.id,
        expectedContractSha256: tool.sha256,
        action: 'approve',
      }),
    ).rejects.toThrow('tool-contract-limit');
    expect(await readFile(file)).toEqual(bytes);
  });
  it('retains an initial incomplete observation without inventing a complete empty capture', async () => {
    const f = await fixture();
    expect(await f.store.read(f.binding)).toBeNull();
    await f.store.invalidate(f.binding, 'listing-incomplete');
    const initial = await f.store.read(f.binding);
    expect(initial?.observation).toBe('invalidated');
    expect(initial?.capture).toBeNull();
    expect(initial?.approvals).toEqual([]);
    expect(initial?.history).toEqual([]);
    expect((await f.store.list()).records).toHaveLength(1);
    let writes = 0;
    expect(
      await f.store.withApproved(f.binding, 'a'.repeat(64), null, () => {
        writes++;
      }),
    ).toBe(false);
    expect(writes).toBe(0);
    const complete = await f.store.observe(f.binding, { tools: [] });
    expect(complete.observation).toBe('complete');
    expect(complete.capture?.tools).toEqual([]);
    expect(complete.revision).not.toBe(initial?.revision);
  });
  it('runs the trusted commit guard after staging and preserves authority when it refuses', async () => {
    const f = await fixture();
    const snap = await f.store.observe(f.binding, {
      tools: [{ name: 'read', inputSchema: { type: 'object' } }],
    });
    const tool = snap.capture!.tools[0]!;
    const directory = join(f.home, 'store', 'mcp-contracts');
    const file = join(directory, f.binding.id + '.json');
    const before = await readFile(file);
    let guarded = false;
    await expect(
      f.store.decide(
        {
          bindingId: f.binding.id,
          expectedRevision: snap.revision,
          expectedCaptureSha256: snap.capture!.sha256,
          toolId: tool.id,
          expectedContractSha256: tool.sha256,
          action: 'approve',
        },
        {
          beforeCommit: async () => {
            guarded = true;
            expect((await readdir(directory)).some((name) => name.startsWith('.stage-'))).toBe(
              true,
            );
            throw new Error('tool-contract-stale');
          },
        },
      ),
    ).rejects.toThrow('tool-contract-stale');
    expect(guarded).toBe(true);
    expect(await readFile(file)).toEqual(before);
    expect((await readdir(directory)).some((name) => name.startsWith('.stage-'))).toBe(false);
    expect((await f.store.read(f.binding))!.revision).toBe(snap.revision);
  });
  it('linearizes a real second-process revoke after the synchronous dispatch callback', async () => {
    const f = await fixture();
    const { snap, tool } = await approve(f);
    const go = join(f.root, 'go');
    const attempted = join(f.root, 'attempted');
    const revoked = join(f.root, 'revoked');
    const request = {
      bindingId: f.binding.id,
      expectedRevision: snap.revision,
      expectedCaptureSha256: snap.capture!.sha256,
      toolId: tool.id,
      expectedContractSha256: tool.sha256,
      action: 'revoke',
    };
    const script = `import {createMcpToolContractsStore} from ${JSON.stringify(new URL('../../src/mcp/tool-contracts.ts', import.meta.url).href)};import{existsSync,writeFileSync}from'node:fs';import{setTimeout as delay}from'node:timers/promises';process.stdout.write('ready\\n');while(!existsSync(${JSON.stringify(go)}))await delay(5);writeFileSync(${JSON.stringify(attempted)},'1');await createMcpToolContractsStore({home:${JSON.stringify(f.home)}}).decide(${JSON.stringify(request)});writeFileSync(${JSON.stringify(revoked)},'1');`;
    const child = spawn(
      process.execPath,
      [
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        '--input-type=module',
        '--eval',
        script,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (v) => {
      stderr += String(v);
    });
    try {
      await Promise.race([
        once(child.stdout, 'data'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('child not ready ' + stderr)), 5000),
        ),
      ]);
      const exited = once(child, 'exit');
      expect(
        await f.store.withApproved(f.binding, snap.capture!.sha256, tool.name, () => {
          writeFileSync(go, '1');
          const deadline = Date.now() + 2000;
          while (!existsSync(attempted) && Date.now() < deadline)
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          expect(existsSync(attempted)).toBe(true);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          expect(existsSync(revoked)).toBe(false);
          expect(
            JSON.parse(
              readFileSync(join(f.home, 'store', 'mcp-contracts', f.binding.id + '.json'), 'utf8'),
            ).approvals[0].approved,
          ).toBe(true);
        }),
      ).toBe(true);
      expect((await exited)[0], stderr).toBe(0);
      expect(existsSync(revoked)).toBe(true);
      expect(await f.store.withApproved(f.binding, snap.capture!.sha256, tool.name, () => {})).toBe(
        false,
      );
    } finally {
      child.kill('SIGKILL');
    }
  }, 10000);
});
