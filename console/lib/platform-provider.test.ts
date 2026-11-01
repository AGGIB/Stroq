import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Runs the real PlatformProvider with a small slot-based hook runtime, so state, effects and the
 * transport stubs behave as they do in the browser without a DOM.
 */
const rt = vi.hoisted(() => {
  const s = {
    slots: [] as any[],
    cursor: 0,
    dirty: false,
    effects: [] as Array<() => void>,
  };
  const same = (a: any[] | undefined, b: any[]) =>
    !!a && a.length === b.length && b.every((v, i) => Object.is(v, a[i]));
  const react = {
    createContext: () => ({ Provider: 'provider' }),
    useContext: () => null,
    useRef(v: any) {
      return (s.slots[s.cursor++] ??= { current: v });
    },
    useState(v: any) {
      const at = s.cursor++;
      if (!s.slots[at]) s.slots[at] = { value: typeof v === 'function' ? v() : v };
      return [
        s.slots[at].value,
        (next: any) => {
          s.slots[at].value = typeof next === 'function' ? next(s.slots[at].value) : next;
          s.dirty = true;
        },
      ];
    },
    useCallback(fn: any, deps: any[]) {
      const at = s.cursor++;
      if (!s.slots[at] || !same(s.slots[at].deps, deps)) s.slots[at] = { fn, deps };
      return s.slots[at].fn;
    },
    useEffect(fn: any, deps: any[]) {
      const at = s.cursor++;
      if (!s.slots[at] || !same(s.slots[at].deps, deps)) {
        const old = s.slots[at];
        s.slots[at] = { deps, cleanup: old?.cleanup };
        s.effects.push(() => {
          old?.cleanup?.();
          s.slots[at].cleanup = fn();
        });
      }
    },
  };
  return { s, react };
});
vi.mock('react', () => rt.react);
vi.mock('react/jsx-runtime', () => {
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  return { jsx, jsxs: jsx, Fragment: 'fragment' };
});
vi.mock('react/jsx-dev-runtime', () => {
  const jsxDEV = (type: unknown, props: unknown) => ({ type, props });
  return { jsxDEV, Fragment: 'fragment' };
});

import { PlatformProvider } from '@/components/platform-provider';
import { EXAMPLE } from '@/lib/connection';

const TOKEN = 'fixture-private-local-token';
const STORED_SOURCE = 'stroq-console-source';
const LOCAL_SNAPSHOT = {
  schema: 'stroq-console/1',
  source: 'local',
  generatedAt: '2026-10-23T09:00:00.000Z',
  calls: [
    {
      id: 'audit-1',
      decision: 'block',
      label: 'Policy denied a tool call',
      raw: 'Command and content withheld',
      agent: 'Unknown host',
      date: '2026-10-23',
      time: '09:00:00',
    },
  ],
  agents: [],
  keys: [],
  limitations: ['Timestamps use UTC. Current protection is not assessed.'],
};

interface World {
  hash?: string;
  storage?: Record<string, string>;
  reply?: { ok: boolean; status: number; body: unknown };
}

function mount(world: World = {}) {
  const storage = new Map(Object.entries(world.storage ?? {}));
  const writes: Array<[string, string]> = [];
  const reply = world.reply ?? { ok: true, status: 200, body: LOCAL_SNAPSHOT };
  const fetchCalls: Array<{ path: string; headers: Record<string, string> }> = [];
  vi.stubGlobal('window', { location: { hash: world.hash ?? '' } });
  vi.stubGlobal('location', { pathname: '/', search: '' });
  vi.stubGlobal('history', { replaceState: vi.fn() });
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push([key, value]);
      storage.set(key, value);
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: { headers: Record<string, string> }) => {
      fetchCalls.push({ path, headers: init.headers });
      return { ok: reply.ok, status: reply.status, json: async () => reply.body };
    }),
  );
  rt.s.slots = [];
  rt.s.effects = [];
  rt.s.dirty = false;
  let value: any;
  const render = () => {
    rt.s.cursor = 0;
    rt.s.dirty = false;
    value = (PlatformProvider({ children: null }) as any).props.value;
  };
  const runEffects = () => {
    while (rt.s.effects.length) rt.s.effects.shift()!();
  };
  const flush = async () => {
    for (let i = 0; i < 24; i++) {
      await Promise.resolve();
      if (rt.s.dirty) {
        render();
        runEffects();
      }
    }
  };
  render();
  return {
    get value() {
      return value;
    },
    storage,
    writes,
    fetchCalls,
    /** The snapshot reads only; the page also asks for its workspace context once connected. */
    get snapshotReads() {
      return fetchCalls.filter((call) => call.path === '/api/snapshot');
    },
    /** Run the mount effects, as the browser does after the first paint. */
    async start() {
      runEffects();
      await flush();
    },
    async flush() {
      await flush();
    },
    unmount() {
      for (const slot of rt.s.slots) slot?.cleanup?.();
    },
  };
}

beforeEach(() => {
  rt.s.slots = [];
  rt.s.effects = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the console starts with only real data', () => {
  it('begins not connected, with no calls, agents or keys, before anything is read', () => {
    const page = mount();
    expect(page.value.source).toBe('none');
    expect(page.value.calls).toEqual([]);
    expect(page.value.agents).toEqual([]);
    expect(page.value.keys).toEqual([]);
    expect(page.value.generatedAt).toBe('');
    expect(page.value.ready).toBe(false);
    expect(page.value.localAccess).toBe(false);
  });

  it('stays not connected and asks the network for nothing when there is no token', async () => {
    const page = mount();
    await page.start();
    expect(page.value.ready).toBe(true);
    expect(page.value.source).toBe('none');
    expect(page.value.calls).toEqual([]);
    expect(page.value.agents).toEqual([]);
    expect(page.value.keys).toEqual([]);
    expect(page.fetchCalls).toEqual([]);
  });

  it('never picks example data on load, even when a demo choice was stored', async () => {
    const page = mount({ storage: { [STORED_SOURCE]: 'demo' } });
    await page.start();
    expect(page.value.source).toBe('none');
    expect(page.value.calls).toEqual([]);
    expect(page.fetchCalls).toEqual([]);
  });

  it('connects to the real source when a stored demo choice sits beside a real token', async () => {
    const page = mount({
      storage: { 'stroq-console-token': TOKEN, [STORED_SOURCE]: 'demo' },
    });
    await page.start();
    expect(page.snapshotReads).toHaveLength(1);
    expect(page.snapshotReads[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(page.value.source).toBe('local');
    expect(page.value.calls.map((c: { id: string }) => c.id)).toEqual(['audit-1']);
    expect(page.value.localAccess).toBe(true);
  });

  it('connects from the token in the link and keeps it for this tab only', async () => {
    const page = mount({ hash: '#token=from-the-link' });
    await page.start();
    expect(page.snapshotReads[0]?.headers.Authorization).toBe('Bearer from-the-link');
    expect(page.storage.get('stroq-console-token')).toBe('from-the-link');
    expect(page.value.source).toBe('local');
  });

  it('leaves nothing to show when the connection is refused', async () => {
    const page = mount({
      storage: { 'stroq-console-token': TOKEN },
      reply: { ok: false, status: 401, body: {} },
    });
    await page.start();
    expect(page.value.source).toBe('none');
    expect(page.value.calls).toEqual([]);
    expect(page.value.error).toMatch(/private link/);
  });

  it('refuses a snapshot it cannot verify instead of showing part of it', async () => {
    const page = mount({
      storage: { 'stroq-console-token': TOKEN },
      reply: { ok: true, status: 200, body: { ...LOCAL_SNAPSHOT, source: 'demo' } },
    });
    await page.start();
    expect(page.value.source).toBe('none');
    expect(page.value.calls).toEqual([]);
    expect(page.value.error).toMatch(/unsupported snapshot/);
  });
});

describe('example data needs an explicit choice', () => {
  it('appears only after the choice, with the example rows and a plain label', async () => {
    const page = mount();
    await page.start();
    expect(page.value.source).toBe('none');
    page.value.showExample();
    await page.flush();
    expect(page.value.source).toBe('demo');
    expect(page.value.calls).toBe(EXAMPLE.calls);
    expect(page.value.calls.length).toBeGreaterThan(0);
    expect(page.value.limitations.join(' ')).toMatch(/not results from your machine/i);
  });

  it('is not remembered: the choice is never stored, and a reload is not connected again', async () => {
    const page = mount();
    await page.start();
    page.value.showExample();
    await page.flush();
    expect(page.writes.some(([, value]) => value === 'demo')).toBe(false);
    const reloaded = mount({ storage: Object.fromEntries(page.storage) });
    await reloaded.start();
    expect(reloaded.value.source).toBe('none');
    expect(reloaded.value.calls).toEqual([]);
  });

  it('goes back to not connected in one step when there is no token', async () => {
    const page = mount();
    await page.start();
    page.value.showExample();
    await page.flush();
    page.value.leaveExample();
    await page.flush();
    expect(page.value.source).toBe('none');
    expect(page.value.calls).toEqual([]);
    expect(page.fetchCalls).toEqual([]);
  });

  it('goes back to the real data in one step when there is a token', async () => {
    const page = mount({ storage: { 'stroq-console-token': TOKEN } });
    await page.start();
    page.value.showExample();
    await page.flush();
    expect(page.value.source).toBe('demo');
    page.value.leaveExample();
    await page.flush();
    expect(page.value.source).toBe('local');
    expect(page.value.calls.map((c: { id: string }) => c.id)).toEqual(['audit-1']);
  });

  it('shows no example rows after leaving, even while the reconnect is still failing', async () => {
    const page = mount({
      storage: { 'stroq-console-token': TOKEN },
      reply: { ok: false, status: 503, body: {} },
    });
    await page.start();
    page.value.showExample();
    await page.flush();
    page.value.leaveExample();
    await page.flush();
    expect(page.value.source).toBe('none');
    expect(page.value.calls).toEqual([]);
    expect(page.value.agents).toEqual([]);
    expect(page.value.keys).toEqual([]);
  });

  it('is replaced by real data when the user connects while the example is on', async () => {
    const page = mount({ storage: { 'stroq-console-token': TOKEN } });
    await page.start();
    page.value.showExample();
    await page.flush();
    await page.value.connectLocal();
    await page.flush();
    expect(page.value.source).toBe('local');
    expect(page.value.calls.some((c: { id: string }) => c.id.startsWith('demo-'))).toBe(false);
  });
});
