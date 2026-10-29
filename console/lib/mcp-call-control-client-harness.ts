import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

export const taskWorkspace = `workspace-${'a'.repeat(24)}`;
/** Executes the actual hook and validators with held IO, effect cleanup and controlled time. */
export function mcpCallControlHarness(variant: 'control' | 'overview' = 'control') {
  let cursor = 0,
    dirty = false,
    live = true,
    output: any,
    serial = 0,
    clock = Date.parse('2026-10-24T10:00:00.000Z');
  const slots: any[] = [],
    effects: (() => void)[] = [],
    modules = new Map<string, any>(),
    timers = new Map<number, { at: number; callback: () => void }>();
  const calls: { path: string; body: unknown; signal?: AbortSignal }[] = [];
  const props: any = {
    target: null,
    enabled: true,
    recovery: null,
    location: { requested: false, invalid: false, controlId: null, contextId: null },
  };
  const platform: any = {
    localAccess: true,
    localContext: { workspace: { id: taskWorkspace, label: 'Fixture' } },
  };
  let handler = async (_path: string, _body?: unknown): Promise<unknown> => ({});
  platform.requestLocal = (path: string, body?: unknown, signal?: AbortSignal) => {
    calls.push({ path, body, signal });
    return handler(path, body);
  };
  const same = (a: unknown[], b: unknown[]) =>
    a?.length === b.length && b.every((value, index) => Object.is(value, a[index]));
  const react = {
    useRef(value: unknown) {
      return (slots[cursor++] ??= { current: value });
    },
    useState(value: any) {
      const at = cursor++;
      if (!slots[at]) slots[at] = { value: typeof value === 'function' ? value() : value };
      return [
        slots[at].value,
        (next: any) => {
          slots[at].value = typeof next === 'function' ? next(slots[at].value) : next;
          dirty = true;
        },
      ];
    },
    useCallback(fn: any, deps: unknown[]) {
      const at = cursor++;
      if (!slots[at] || !same(slots[at].deps, deps)) slots[at] = { fn, deps };
      return slots[at].fn;
    },
    useEffect(fn: () => void, deps: unknown[]) {
      const at = cursor++;
      if (!slots[at] || !same(slots[at].deps, deps)) {
        const old = slots[at];
        slots[at] = { deps, cleanup: old?.cleanup };
        effects.push(() => {
          old?.cleanup?.();
          slots[at].cleanup = fn();
        });
      }
    },
  };
  class ClockDate extends Date {
    constructor(value?: string | number) {
      super(value ?? clock);
    }
    static now() {
      return clock;
    }
  }
  function load(name: string): any {
    const file = /\.tsx?$/.test(name)
      ? name
      : `${name}${existsSync(`${name}.tsx`) ? '.tsx' : '.ts'}`;
    if (modules.has(file)) return modules.get(file);
    const exports: any = {};
    modules.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(code, {
      exports,
      Object,
      Array,
      JSON,
      Reflect,
      Error,
      Number,
      TextEncoder,
      AbortController,
      Date: ClockDate,
      setTimeout(callback: () => void, delay: number) {
        const id = ++serial;
        timers.set(id, { at: clock + delay, callback });
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
      require(imported: string) {
        if (imported === 'react') return react;
        if (imported === '@/components/platform-provider') return { usePlatform: () => platform };
        return load(
          imported.startsWith('@/')
            ? resolve(process.cwd(), imported.slice(2))
            : resolve(dirname(file), imported),
        );
      },
    });
    return exports;
  }
  const hook = load(
    resolve(
      process.cwd(),
      variant === 'control'
        ? 'components/platform/use-mcp-call-control'
        : 'components/platform/use-mcp-call-controls',
    ),
  );
  function render() {
    cursor = 0;
    dirty = false;
    output =
      variant === 'control'
        ? hook.useMcpCallControl(props.target, props.enabled, props.recovery)
        : hook.useMcpCallControls(props.location);
    while (effects.length) effects.shift()!();
    return output;
  }
  async function flush() {
    for (let index = 0; index < 40; index++) {
      await Promise.resolve();
      if (live && dirty) render();
    }
    return output;
  }
  function unmount() {
    live = false;
    for (const slot of slots) slot?.cleanup?.();
  }
  return {
    get pendingWrites() {
      return load(resolve(process.cwd(), 'lib/mcp-call-control-binding')).callControlPending(
        platform.requestLocal,
      ) as Map<string, unknown>;
    },
    props,
    platform,
    calls,
    render,
    flush,
    unmount,
    get output() {
      return output;
    },
    set handler(value: typeof handler) {
      handler = value;
    },
    remount() {
      unmount();
      slots.length = 0;
      effects.length = 0;
      live = true;
      render();
    },
    async advance(ms: number) {
      clock += ms;
      for (const [id, timer] of timers)
        if (timer.at <= clock) {
          timers.delete(id);
          timer.callback();
        }
      await flush();
    },
  };
}
