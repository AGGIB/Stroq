import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
const root = fileURLToPath(new URL('../', import.meta.url));
export const ws = `workspace-${'a'.repeat(24)}`,
  otherWs = `workspace-${'b'.repeat(24)}`,
  registrationId = `item-${'c'.repeat(24)}`,
  bindingId = `binding-${'d'.repeat(64)}`,
  toolId = `tool-${'e'.repeat(64)}`,
  version = 'f'.repeat(64),
  registrationSha = '1'.repeat(64);
export const clone = (value) => JSON.parse(JSON.stringify(value));
export const uuid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
export function harness(selected = true) {
  let cursor = 0,
    dirty = false,
    output,
    clock = Date.parse('2026-10-24T01:00:00.000Z'),
    mode = 'ok',
    serial = 0,
    timerId = 0,
    decision = 'pending',
    storeRevision = '2'.repeat(64);
  const slots = [],
    effects = [],
    calls = [],
    timers = new Map(),
    held = [],
    modules = new Map(),
    plans = new Map(),
    history = [];
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock]));
    }
    static now() {
      return clock;
    }
  }
  const same = (a, b) =>
    a?.length === b.length && b.every((value, index) => Object.is(a[index], value));
  const react = {
    useRef(value) {
      return (slots[cursor++] ??= { current: value });
    },
    useState(value) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = { value: typeof value === 'function' ? value() : value };
      return [
        slots[index].value,
        (value) => {
          slots[index].value = typeof value === 'function' ? value(slots[index].value) : value;
          dirty = true;
        },
      ];
    },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { fn, deps };
      return slots[index].fn;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) {
        const old = slots[index];
        slots[index] = { fn, deps, cleanup: old?.cleanup };
        effects.push(() => {
          old?.cleanup?.();
          slots[index].cleanup = fn();
        });
      }
    },
  };
  let selection = selected
    ? {
        requested: true,
        invalid: false,
        workspaceId: ws,
        registrationId,
        bindingId,
        toolId,
        contractSha256: version,
      }
    : {
        requested: false,
        invalid: false,
        workspaceId: null,
        registrationId: null,
        bindingId: null,
        toolId: null,
        contractSha256: null,
      };
  const platform = {
    localAccess: true,
    localContext: { workspace: { id: ws, label: 'Fixture workspace' } },
  };
  function load(file) {
    if (!file.endsWith('.ts')) file += '.ts';
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    modules.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(
      code,
      {
        exports,
        Object,
        Array,
        JSON,
        Reflect,
        Error,
        Number,
        TextEncoder,
        AbortController,
        Date: FakeDate,
        setTimeout(fn, delay) {
          const id = ++timerId;
          timers.set(id, { fn, at: clock + delay });
          return id;
        },
        clearTimeout(id) {
          timers.delete(id);
        },
        require(name) {
          if (name === 'react') return react;
          if (name === '@/components/platform-provider') return { usePlatform: () => platform };
          return load(
            name.startsWith('@/') ? resolve(root, name.slice(2)) : resolve(dirname(file), name),
          );
        },
      },
      { filename: file },
    );
    return exports;
  }
  const schema = load(resolve(root, 'lib/mcp-tool-contracts'));
  const { compareMcpToolContract } = load(resolve(root, 'lib/mcp-tool-contract-comparison'));
  function tool() {
    const contract = JSON.stringify({
      name: 'notes:read',
      description: '<script>hostile</script> https://example.invalid/private',
      inputSchema: { type: 'object' },
    });
    const baseline = history.findLast((row) => row.action === 'approve');
    const previousApprovedContract = baseline ? contract : null;
    return {
      id: toolId,
      name: 'notes:read',
      sha256: version,
      contract,
      decision,
      previousApprovedContract,
      comparison: clone(
        compareMcpToolContract(
          contract,
          previousApprovedContract,
          baseline ? { sha256: baseline.contractSha256, approvedAt: baseline.at } : null,
        ),
      ),
    };
  }
  function registration() {
    return {
      id: registrationId,
      name: 'Notes server',
      agent: 'cursor',
      scope: 'user',
      registrationSha256: registrationSha,
      bindingId,
      revision: storeRevision,
      status: 'complete',
      reason: null,
      captureSha256: '3'.repeat(64),
      observedAt: new FakeDate().toISOString(),
      tools: [tool()],
      history: clone(history),
    };
  }
  function state() {
    return {
      schema: 'stroq-mcp-tool-contracts/1',
      workspaceId: platform.localContext.workspace.id,
      generatedAt: new FakeDate().toISOString(),
      available: true,
      reason: null,
      registrations: [registration()],
      gaps: [],
      limitations: [...schema.MCP_TOOL_CONTRACT_LIMITATIONS],
    };
  }
  async function request(path, body, signal) {
    calls.push({ path, body, signal });
    let value;
    if (path.endsWith('/preview')) {
      assert.deepEqual(
        Object.keys(body).sort(),
        [
          'action',
          'bindingId',
          'expectedRevision',
          'expectedCaptureSha256',
          'toolId',
          'expectedContractSha256',
        ].sort(),
      );
      const row = registration();
      value = {
        schema: 'stroq-mcp-tool-contract-preview/1',
        id: uuid(++serial),
        workspaceId: platform.localContext.workspace.id,
        createdAt: new FakeDate().toISOString(),
        expiresAt: new FakeDate(clock + 120000).toISOString(),
        ...clone(body),
        registrationId: row.id,
        registrationSha256: row.registrationSha256,
        tool: {
          name: row.tools[0].name,
          contract: row.tools[0].contract,
          previousApprovedContract: row.tools[0].previousApprovedContract,
          comparison: clone(row.tools[0].comparison),
        },
        hostEnforcement: false,
      };
      plans.set(value.id, clone(value));
      if (mode === 'bad-preview-binding') value.bindingId = `binding-${'4'.repeat(64)}`;
      if (mode === 'bad-preview-body')
        value.tool.contract = JSON.stringify({
          name: 'notes:read',
          inputSchema: { type: 'object' },
        });
      if (mode === 'bad-preview-capture') value.expectedCaptureSha256 = '4'.repeat(64);
      if (mode === 'private-preview') value.command = 'PRIVATE';
    } else if (path.endsWith('/apply')) {
      assert.deepEqual(
        Object.keys(body).sort(),
        ['previewId', 'confirm', 'acknowledgeContract', 'acknowledgeCallLimits'].sort(),
      );
      const preview = plans.get(body.previewId);
      assert(preview);
      decision = preview.action === 'approve' ? 'approved' : 'revoked';
      history.push({
        action: preview.action,
        toolId,
        contractSha256: version,
        at: new FakeDate().toISOString(),
      });
      storeRevision = String(serial + 4)
        .repeat(64)
        .slice(0, 64);
      const {
        schema: _schema,
        id: _id,
        createdAt: _created,
        expiresAt: _expires,
        tool: _tool,
        ...identity
      } = preview;
      value = {
        ...identity,
        schema: 'stroq-mcp-tool-contract-receipt/1',
        previewId: preview.id,
        completedAt: new FakeDate().toISOString(),
        revision: storeRevision,
      };
      if (mode === 'bad-receipt-id') value.previewId = uuid(999);
      if (mode === 'bad-receipt-version') value.expectedContractSha256 = '4'.repeat(64);
      if (mode === 'private-receipt') value.path = 'PRIVATE';
    } else {
      assert.equal(path, '/api/mcp-tool-contracts');
      assert.equal(body, undefined);
      if (mode === 'raw-read-error') throw new Error('PRIVATE_TOKEN');
      if (mode === 'fixed-read-error') throw new Error('tool-contract-limit');
      value = state();
      if (mode === 'foreign-read') value.workspaceId = otherWs;
      if (mode === 'private-read') value.path = 'PRIVATE';
      if (mode === 'unavailable-read') {
        value.available = false;
        value.reason = 'storage-unavailable';
        value.registrations = [];
      }
      if (mode === 'missing-registration') value.registrations = [];
      if (mode === 'missing-tool') value.registrations[0].tools = [];
      if (mode === 'changed-binding')
        value.registrations[0].bindingId = `binding-${'4'.repeat(64)}`;
      if (mode === 'changed-version') value.registrations[0].tools[0].sha256 = '4'.repeat(64);
      if (mode === 'none') {
        Object.assign(value.registrations[0], {
          status: 'none',
          revision: null,
          captureSha256: null,
          observedAt: null,
          tools: [],
          history: [],
        });
      }
      if (mode === 'incomplete')
        Object.assign(value.registrations[0], {
          status: 'incomplete',
          reason: 'listing-invalidated',
        });
    }
    if (!mode.startsWith('private'))
      assert(
        path.endsWith('/preview')
          ? schema.validateMcpToolContractPreview(value)
          : path.endsWith('/apply')
            ? schema.validateMcpToolContractReceipt(value)
            : schema.validateMcpToolContractState(value),
        `Real ${path} fixture ${mode}`,
      );
    if (
      (mode === 'hold-read' && path === '/api/mcp-tool-contracts') ||
      (mode === 'hold-preview' && path.endsWith('/preview')) ||
      (mode === 'hold-apply' && path.endsWith('/apply'))
    )
      return new Promise((done) => held.push(() => done(clone(value))));
    return clone(value);
  }
  platform.requestLocal = request;
  const hook = load(resolve(root, 'components/platform/use-mcp-tool-contracts'));
  function render() {
    cursor = 0;
    dirty = false;
    effects.length = 0;
    output = hook.useMcpToolContracts(selection);
    effects.splice(0).forEach((fn) => fn());
    return output;
  }
  async function flush() {
    for (let i = 0; i < 100; i++) {
      await Promise.resolve();
      if (dirty) render();
    }
    return output;
  }
  return {
    calls,
    timers,
    render,
    flush,
    get output() {
      return output;
    },
    mode(value) {
      mode = value;
    },
    async context(values = {}, workspace, access) {
      selection = { ...selection, ...values };
      if (workspace)
        platform.localContext = { workspace: { id: workspace, label: 'Other fixture' } };
      if (access !== undefined) platform.localAccess = access;
      const immediate = render();
      await flush();
      return immediate;
    },
    async routeImmediate(values) {
      selection = { ...selection, ...values };
      cursor = 0;
      dirty = false;
      output = hook.useMcpToolContracts(selection);
      return output;
    },
    async reconnect() {
      platform.requestLocal = (...args) => request(...args);
      render();
      await flush();
    },
    async reconnectContext() {
      platform.localContext = { ...platform.localContext };
      render();
      await flush();
    },
    release() {
      held.splice(0).forEach((fn) => fn());
    },
    async advance(ms) {
      const end = clock + ms;
      for (let i = 0; i < 100; i++) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        clock = next[1].at;
        next[1].fn();
        await flush();
      }
      clock = end;
      await flush();
    },
    async prepare(action = 'approve') {
      await output.prepare(action);
      await flush();
    },
    async consent() {
      output.acknowledge('contract', true);
      output.acknowledge('callLimits', true);
      await flush();
    },
    async apply() {
      await output.apply();
      await flush();
    },
    unmount() {
      slots.forEach((slot) => slot?.cleanup?.());
    },
    async strictCycle() {
      slots.forEach((slot) => slot?.cleanup?.());
      slots.forEach((slot) => {
        if (slot?.fn) slot.cleanup = slot.fn();
      });
      await flush();
    },
  };
}
