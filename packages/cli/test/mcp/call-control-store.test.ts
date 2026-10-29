import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { createMcpCallControlsStore } from '../../src/mcp/call-control-store.js';
import { encodeCallControlState } from '../../src/mcp/call-control-state.js';
import {
  readCallControlAuthoritySync,
  withCallControlLease,
} from '../../src/mcp/call-control-files.js';
import type {
  McpCallControlDecision,
  McpCallControlSnapshot,
} from '../../src/mcp/call-control-types.js';

let fixture: string;
let home: string;
const invocation = 'a'.repeat(64);
const drift = 'b'.repeat(64);
const controlId = '11111111-1111-4111-8111-111111111111';
const time = new Date('2026-10-26T12:00:00.000Z');
const decision = (
  state: McpCallControlSnapshot,
  action: McpCallControlDecision['action'],
  sha = invocation,
): McpCallControlDecision => ({
  controlId,
  invocationSha256: sha,
  action,
  operationId: randomUUID(),
  expectedRevision: state.revision,
  expectedEventId: state.controls.find((c) => c.controlId === controlId)?.eventId ?? null,
});
const store = () => createMcpCallControlsStore({ home, now: () => time });
const configure = async () => {
  const s = store();
  return s.decide(decision(await s.read(), 'configure-paused'));
};
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'stroq-call-control-'));
  home = join(fixture, 'home');
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

// The native call-control store is POSIX-only: on Windows it refuses with `mcp-call-control-unsupported`
// (`call-control-files.ts`), so there is nothing here to exercise.
describe.skipIf(process.platform === 'win32')('native MCP call authority', () => {
  it('reads absence without creating home or taking a lease', async () => {
    expect(await store().read()).toMatchObject({
      history: 'missing',
      events: [],
      controls: [],
      revision: null,
    });
    expect(readCallControlAuthoritySync(home)).toEqual(await store().read());
    await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(withCallControlLease(home, false, async () => true)).rejects.toThrow(
      'mcp-call-control-unavailable',
    );
    await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('configures paused, resumes exact invocation, and pauses a drifted connection without rebinding', async () => {
    let { state } = await configure();
    expect(state.controls[0]).toMatchObject({ mode: 'paused', invocationSha256: invocation });
    expect((await lstat(home)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(home, 'mcp-call-controls/history.json'))).mode & 0o777).toBe(0o600);
    ({ state } = await store().decide(decision(state, 'resume')));
    ({ state } = await store().decide(decision(state, 'pause', drift)));
    expect(state.controls[0]).toMatchObject({ mode: 'paused', invocationSha256: invocation });
    await expect(store().decide(decision(state, 'resume', drift))).rejects.toThrow(
      'mcp-call-control-stale',
    );
    ({ state } = await store().decide(decision(state, 'rebind-paused', drift)));
    ({ state } = await store().decide(decision(state, 'resume', drift)));
    expect(readCallControlAuthoritySync(home)).toEqual(state);
    expect(state.controls[0]).toMatchObject({ mode: 'enabled', invocationSha256: drift });
  });
  it('refuses stale whole-file CAS, duplicate IDs, and duplicate current actions', async () => {
    const { state, event } = await configure();
    const resume = decision(state, 'resume');
    const next = await store().decide(resume);
    await expect(store().decide(decision(state, 'resume'))).rejects.toThrow(
      'mcp-call-control-stale',
    );
    await expect(
      store().decide({ ...decision(next.state, 'pause'), operationId: event.id }),
    ).rejects.toThrow('mcp-call-control-stale');
    await expect(store().decide(decision(next.state, 'resume'))).rejects.toThrow(
      'mcp-call-control-stale',
    );
  });
  it('rejects backwards write clocks while retaining readable authority', async () => {
    const { state } = await configure();
    await expect(
      createMcpCallControlsStore({ home, now: () => new Date(time.getTime() - 1) }).decide(
        decision(state, 'resume'),
      ),
    ).rejects.toThrow('mcp-call-control-stale');
    expect(await store().read()).toEqual(state);
  });
  it('refuses duplicate, noncanonical and unknown JSON fields without repairing it', async () => {
    await configure();
    const path = join(home, 'mcp-call-controls/history.json');
    const original = await readFile(path, 'utf8');
    for (const raw of [
      original.replace('{', '{"schema":"x",'),
      original + '\n',
      original.replace('{', '{"unknown":true,'),
    ]) {
      await writeFile(path, raw, { mode: 0o600 });
      await expect(store().read()).rejects.toThrow('mcp-call-control-invalid');
      expect(await readFile(path, 'utf8')).toBe(raw);
    }
  });
  it('refuses a history rewritten without the home key, so a plain file write cannot resume a pause', async () => {
    const { state } = await configure();
    const path = join(home, 'mcp-call-controls/history.json');
    const signed = await readFile(path);
    // A forger who recomputes the old plain digest, as anyone could, is refused.
    await writeFile(path, encodeCallControlState(state.events, state.homeBinding!), {
      mode: 0o600,
    });
    await expect(store().read()).rejects.toThrow('mcp-call-control-invalid');
    // So is one who signs with a key of their own.
    await writeFile(
      path,
      encodeCallControlState(state.events, state.homeBinding!, randomBytes(32)),
      {
        mode: 0o600,
      },
    );
    await expect(store().read()).rejects.toThrow('mcp-call-control-invalid');
    await writeFile(path, signed, { mode: 0o600 });
    expect(await store().read()).toEqual(state);
  });
  it('refuses a history when the home key is missing or not private', async () => {
    await configure();
    const key = join(home, 'keys/state-mac.key');
    const bytes = await readFile(key);
    await chmod(key, 0o644);
    await expect(store().read()).rejects.toThrow();
    await rm(key);
    await expect(store().read()).rejects.toThrow('mcp-call-control-invalid');
    await writeFile(key, bytes, { mode: 0o600 });
    await expect(store().read()).resolves.toBeTruthy();
  });
  it('refuses symlink authorities and copied home identities', async () => {
    await configure();
    const path = join(home, 'mcp-call-controls/history.json');
    const raw = await readFile(path);
    await rename(path, join(fixture, 'moved'));
    await symlink(join(fixture, 'moved'), path);
    await expect(store().read()).rejects.toThrow('mcp-call-control-unavailable');
    await rm(path);
    await writeFile(path, raw, { mode: 0o600 });
    const replacement = join(fixture, 'replacement');
    await rename(home, replacement);
    await mkdir(join(home, 'mcp-call-controls'), { recursive: true, mode: 0o700 });
    await writeFile(path, raw, { mode: 0o600 });
    await expect(store().read()).rejects.toThrow('mcp-call-control-unavailable');
  });
  it('does not scan or remove stages during passive reads; writers enforce stage quota', async () => {
    const { state } = await configure();
    const dir = join(home, 'mcp-call-controls');
    for (let i = 0; i < 32; i++)
      await writeFile(join(dir, '.stage-' + randomUUID()), '', { mode: 0o600 });
    expect(await store().read()).toEqual(state);
    await expect(store().decide(decision(state, 'resume'))).rejects.toThrow(
      'mcp-call-control-limit',
    );
    expect((await readdir(dir)).filter((n) => n.startsWith('.stage-'))).toHaveLength(32);
  });

  it('rechecks physical quota after an awaited commit guard', async () => {
    const { state } = await configure();
    const dir = join(home, 'mcp-call-controls');
    await expect(
      store().decide(decision(state, 'resume'), {
        beforeCommit: async () => {
          await writeFile(join(dir, '.stage-' + randomUUID()), Buffer.alloc(1024 * 1024), {
            mode: 0o600,
          });
        },
      }),
    ).rejects.toThrow('mcp-call-control-limit');
    expect(await store().read()).toEqual(state);
    expect((await readdir(dir)).filter((n) => n.startsWith('.stage-'))).toHaveLength(1);
  });
  it('recovers only verified dead local lease owners during admission', async () => {
    const { state } = await configure();
    const lock = join(home, 'mcp-call-controls/.lock');
    await mkdir(lock, { mode: 0o700 });
    const owner = join(lock, 'owner.json');
    await writeFile(
      owner,
      JSON.stringify({ pid: 2147483647, host: hostname(), token: randomUUID() }),
      { mode: 0o600 },
    );
    expect(await store().read()).toEqual(state);
    expect(await readFile(owner, 'utf8')).toContain('2147483647');
    await withCallControlLease(home, false, async (lease) => lease.assertCurrent());
    await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(lock, { mode: 0o700 });
    await writeFile(owner, '{}', { mode: 0o600 });
    await expect(withCallControlLease(home, false, async () => true, 5)).rejects.toThrow(
      'mcp-call-control-busy',
    );
    expect(await readFile(owner, 'utf8')).toBe('{}');
  });
  it('rechecks authority and lease after asynchronous commit guards', async () => {
    const { state } = await configure();
    const path = join(home, 'mcp-call-controls/history.json');
    await expect(
      store().decide(decision(state, 'resume'), {
        beforeCommit: async () => {
          await chmod(path, 0o644);
        },
      }),
    ).rejects.toThrow('mcp-call-control-unavailable');
    await chmod(path, 0o600);
    expect((await store().read()).controls[0]?.mode).toBe('paused');
  });
  it('serializes dispatch and writers, and detects replaced lock ownership', async () => {
    await configure();
    await withCallControlLease(home, false, async (lease) => {
      lease.assertCurrentSync();
      await expect(withCallControlLease(home, false, async () => false, 5)).rejects.toThrow(
        'mcp-call-control-busy',
      );
      const owner = join(home, 'mcp-call-controls/.lock/owner.json');
      await writeFile(owner, '{}', { mode: 0o600 });
      expect(() => lease.assertCurrentSync()).toThrow('mcp-call-control-unavailable');
    }).catch((error) => expect(error.message).toBe('mcp-call-control-unavailable'));
  });
  it.each(['before-publish', 'after-publish', 'before-readback'] as const)(
    'has conservative fault outcome at %s',
    async (stage) => {
      const { state } = await configure();
      const input = decision(state, 'resume');
      const s = createMcpCallControlsStore({
        home,
        now: () => time,
        fault: (point) => {
          if (point === stage) throw Error('injected');
        },
      });
      await expect(s.decide(input)).rejects.toThrow(
        stage === 'before-publish'
          ? 'mcp-call-control-unavailable'
          : 'mcp-call-control-write-unconfirmed',
      );
      const read = await store().read();
      expect(read.events.some((e) => e.id === input.operationId)).toBe(stage !== 'before-publish');
      expect(
        (await readdir(join(home, 'mcp-call-controls'))).some((n) => n.startsWith('.stage-')),
      ).toBe(false);
    },
  );
});
