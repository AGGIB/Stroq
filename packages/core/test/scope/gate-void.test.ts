import { chmodSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createScopeGate } from '../../src/scope/gate.js';
import { generateKeyPair } from '../../src/scope/keys.js';
import { signPermit } from '../../src/scope/permit.js';
import type { ScopeGateInput } from '../../src/scope/types.js';
import {
  ALLOW,
  ASK,
  DENY,
  type Fixture,
  POSIX_PATHS,
  callOf,
  gateFixture,
  resourcesOf,
  verdictOf,
} from './gate-fixture.js';
import { NOW, NONCE, SESSION, rawOf, sampleBody } from './helpers.js';

const posix = process.platform !== 'win32';

/** Every kind of tool, the read-only ones first: a void permit takes them all. */
const TOOLS: Array<[string, Record<string, unknown>]> = [
  ['Read', { file_path: '/work/project/src/a.ts' }],
  ['Grep', { pattern: 'x' }],
  ['Glob', { pattern: '*.ts' }],
  ['Bash', { command: 'echo hello' }],
  ['Edit', { file_path: '/work/project/src/a.ts' }],
  ['WebFetch', { url: 'https://example.invalid/' }],
  ['TodoWrite', { todos: [] }],
  ['mcp__docs__search', { q: 'x' }],
];

const permitPath = (f: Fixture): string => join(f.home, 'tasks', f.taskId, 'permit.json');
function textOf(f: Fixture): string {
  const read = f.store.readPermit(f.taskId);
  if (read.kind !== 'present') throw new Error('no permit to rewrite');
  return read.text;
}
const rewrite = (f: Fixture, change: (parsed: any) => void): void => {
  const parsed = JSON.parse(textOf(f));
  change(parsed);
  writeFileSync(permitPath(f), JSON.stringify(parsed));
};

interface Cause {
  readonly name: string;
  readonly reason: string;
  readonly make: () => { f: Fixture; call?: Partial<Parameters<typeof callOf>[2]> };
}

const causes: Cause[] = [
  {
    name: 'a body changed after signing',
    reason: 'signature',
    make: () => {
      const f = gateFixture();
      rewrite(f, (p) => (p.body.scope.shell = 'denied'));
      return { f };
    },
  },
  {
    name: 'a permit signed by another key',
    reason: 'key-id',
    make: () => {
      const f = gateFixture({ permit: 'none' });
      f.store.writePermit(f.taskId, rawOf(signPermit(f.body, generateKeyPair().privateKey)));
      return { f };
    },
  },
  {
    name: 'a permit for another launch (nonce)',
    reason: 'nonce',
    make: () => ({ f: gateFixture({ run: { nonce: `${NONCE}-other` } }) }),
  },
  {
    name: 'a permit at the instant it expires',
    reason: 'expired',
    make: () => {
      const f = gateFixture();
      f.clock.now = new Date(Date.parse(f.body.expiresAt));
      return { f };
    },
  },
  {
    name: 'a policy.yaml that changed since the permit was made',
    reason: 'policy-digest',
    make: () => ({ f: gateFixture({ run: { policyDigest: 'f'.repeat(64) } }) }),
  },
  {
    name: 'a sealed state file that changed',
    reason: 'state-digest',
    make: () => ({ f: gateFixture({ run: { stateDigests: { 'policy.yaml': 'f'.repeat(64) } } }) }),
  },
  {
    name: 'a permit for another project',
    reason: 'project-root',
    make: () => ({ f: gateFixture({ run: { projectRoot: '/work/other' } }) }),
  },
  {
    name: 'a permit used by another session',
    reason: 'session',
    make: () => ({ f: gateFixture(), call: { sessionId: `${SESSION}-other` } }),
  },
  {
    name: 'a permit copied from another task',
    reason: 'task-id',
    make: () => {
      const f = gateFixture({ permit: 'none', body: { taskId: 'task-b' } });
      f.store.writePermit(
        'task-b',
        rawOf(signPermit(sampleBody({ taskId: 'task-a' }), f.pair.privateKey)),
      );
      return { f };
    },
  },
  {
    name: 'a revoked task',
    reason: 'revoked',
    make: () => {
      const f = gateFixture();
      f.store.revoke(f.taskId);
      return { f };
    },
  },
  {
    name: 'a task that ended',
    reason: 'ended',
    make: () => {
      const f = gateFixture();
      f.store.end(f.taskId);
      return { f };
    },
  },
  {
    name: 'a permit with a key it does not know',
    reason: 'schema',
    make: () => {
      const f = gateFixture();
      rewrite(f, (p) => (p.extra = 1));
      return { f };
    },
  },
  {
    name: 'a permit that is not JSON',
    reason: 'malformed',
    make: () => {
      const f = gateFixture();
      writeFileSync(permitPath(f), 'this is not a permit');
      return { f };
    },
  },
  {
    name: 'a permit with duplicate keys',
    reason: 'malformed',
    make: () => {
      const f = gateFixture();
      writeFileSync(permitPath(f), textOf(f).replace('"v":1', '"v":1,"v":1'));
      return { f };
    },
  },
  {
    name: 'a permit over 64 KiB',
    reason: 'oversize',
    make: () => {
      const f = gateFixture();
      writeFileSync(permitPath(f), `${textOf(f)}${' '.repeat(70_000)}`);
      return { f };
    },
  },
  {
    name: 'a permit file that is empty',
    reason: 'malformed',
    make: () => {
      const f = gateFixture();
      writeFileSync(permitPath(f), '');
      return { f };
    },
  },
  {
    name: 'a permit that is a directory',
    reason: 'not-regular',
    make: () => {
      const f = gateFixture();
      rmSync(permitPath(f));
      mkdirSync(permitPath(f));
      return { f };
    },
  },
  {
    name: 'a public key that is gone',
    reason: 'key-missing',
    make: () => {
      const f = gateFixture();
      unlinkSync(join(f.home, 'keys', 'permit.pub'));
      return { f };
    },
  },
  {
    name: 'a public key that is garbage',
    reason: 'key-bad',
    make: () => {
      const f = gateFixture();
      writeFileSync(join(f.home, 'keys', 'permit.pub'), 'garbage');
      return { f };
    },
  },
];

describe('a permit that is present but void denies every tool', () => {
  for (const cause of causes) {
    it(`denies all tools for ${cause.name} with task-void:${cause.reason}`, async () => {
      const { f, call } = cause.make();
      for (const [tool, input] of TOOLS) {
        const verdict = await verdictOf(f, callOf(tool, input, call));
        expect(verdict.decision.effect, tool).toBe('deny');
        expect(verdict.decision.ruleId, tool).toBe(`task-void:${cause.reason}`);
        expect(verdict.evidence, tool).toEqual({
          ruleId: `task-void:${cause.reason}`,
          kind: 'void',
        });
        expect(verdict.taskId).toBe(f.taskId);
        expect(verdict.decision.reason).toContain(cause.reason);
      }
    });
  }

  it.runIf(posix && process.getuid?.() !== 0)(
    'denies all tools for a permit file that cannot be read',
    async () => {
      const f = gateFixture();
      chmodSync(permitPath(f), 0o000);
      for (const [tool, input] of TOOLS) {
        const verdict = await verdictOf(f, callOf(tool, input));
        expect(verdict.decision.ruleId).toBe('task-void:unreadable');
      }
      chmodSync(permitPath(f), 0o600);
    },
  );

  it('denies whatever the policy said, allow included: a void permit has no say in an allow', async () => {
    const f = gateFixture();
    f.store.revoke(f.taskId);
    for (const decision of [ALLOW, ASK, DENY]) {
      const verdict = await verdictOf(
        f,
        callOf('Read', { file_path: '/work/project/a' }, { decision }),
      );
      expect(verdict.decision.effect).toBe('deny');
    }
  });

  it('is void until the permit is good again: nothing is remembered between calls', async () => {
    const f = gateFixture();
    const call = callOf(
      'Read',
      { file_path: '/work/project/src/a.ts' },
      {
        resources: resourcesOf([['read', '/work/project/src/a.ts']]),
      },
    );
    expect((await verdictOf(f, call)).decision.effect).toBe('allow');
    f.clock.now = new Date(Date.parse(f.body.expiresAt) + 1);
    expect((await verdictOf(f, call)).decision.ruleId).toBe('task-void:expired');
    f.clock.now = NOW;
    expect((await verdictOf(f, call)).decision.effect).toBe('allow');
  });

  it('keeps the nonce, session and digests out of the reason text', async () => {
    const f = gateFixture({ run: { nonce: 'secret-nonce-value-0123456789' } });
    const verdict = await verdictOf(f, callOf('Read'));
    expect(JSON.stringify(verdict)).not.toContain('secret-nonce-value-0123456789');
    expect(JSON.stringify(verdict)).not.toContain(NONCE);
  });
});

describe('no permit at all', () => {
  // The permit file is in a directory the agent can reach by a path it can spell in many ways, and a
  // file it can delete must not be able to turn the task off.
  it('is a deleted contract for a task: everything is refused, Read included', async () => {
    const f = gateFixture({ permit: 'none' });
    for (const [tool, input] of TOOLS) {
      const verdict = await verdictOf(f, callOf(tool, input, { decision: ALLOW }));
      expect(verdict.decision.effect).toBe('deny');
      expect(verdict.decision.ruleId).toBe('task-void:missing');
    }
    expect(f.gate.activeTask()).toBe(f.taskId);
  });

  it('is a void permit after a good one was deleted in the middle of the task', async () => {
    const f = gateFixture();
    expect(
      (
        await verdictOf(
          f,
          callOf(
            'Read',
            { file_path: '/work/project/src/a.ts' },
            { resources: resourcesOf([['read', '/work/project/src/a.ts']]) },
          ),
        )
      ).decision.effect,
    ).toBe('allow');
    unlinkSync(permitPath(f));
    const verdict = await verdictOf(
      f,
      callOf(
        'Read',
        { file_path: '/work/project/src/a.ts' },
        { resources: resourcesOf([['read', '/work/project/src/a.ts']]) },
      ),
    );
    expect(verdict.decision.ruleId).toBe('task-void:missing');
  });

  it.each([null, undefined])(
    'returns null when the process has no task at all (%s)',
    async (taskId) => {
      const f = gateFixture();
      const gate = createScopeGate({
        taskId,
        store: f.store,
        keys: f.keyStore,
        context: () => f.run,
        paths: POSIX_PATHS,
      });
      expect(await gate.evaluate(callOf('Read'))).toBeNull();
      expect(gate.activeTask()).toBeNull();
    },
  );

  it('refuses everything for a task id that is empty: it is a task whose id cannot be right', async () => {
    const f = gateFixture();
    const gate = createScopeGate({
      taskId: '',
      store: f.store,
      keys: f.keyStore,
      context: () => f.run,
      paths: POSIX_PATHS,
    });
    expect((await gate.evaluate(callOf('Read')))?.decision.effect).toBe('deny');
  });
});

describe('activeTask', () => {
  it('names the task while a permit exists, good or void, so that an adapter fails closed on every tool', () => {
    const f = gateFixture();
    expect(f.gate.activeTask()).toBe(f.taskId);
    f.store.revoke(f.taskId);
    expect(f.gate.activeTask()).toBe(f.taskId);
  });

  it('never throws, and names the task when it cannot tell', () => {
    const f = gateFixture();
    const gate = createScopeGate({
      taskId: f.taskId,
      store: {
        readPermit: () => {
          throw new Error('disk on fire');
        },
        readEscalation: () => ({ kind: 'absent' }),
        consumeEscalation: () => false,
      },
      keys: f.keyStore,
      context: () => f.run,
    });
    expect(gate.activeTask()).toBe(f.taskId);
  });
});

describe('a failure inside the gate is a void permit, not a crash', () => {
  const f0 = gateFixture();
  const base = {
    taskId: f0.taskId,
    store: f0.store,
    keys: f0.keyStore,
    context: () => f0.run,
    now: () => NOW,
    paths: POSIX_PATHS,
  };

  it('treats a throwing store as void', async () => {
    const gate = createScopeGate({
      ...base,
      store: {
        readPermit: () => {
          throw new Error('boom');
        },
        readEscalation: () => ({ kind: 'absent' }),
        consumeEscalation: () => false,
      },
    });
    const verdict = await gate.evaluate(callOf('Read'));
    expect(verdict?.decision).toMatchObject({ effect: 'deny', ruleId: 'task-void:exception' });
  });

  it('treats a throwing context as void', async () => {
    const gate = createScopeGate({
      ...base,
      context: () => {
        throw new Error('policy.yaml is unreadable');
      },
    });
    const verdict = await gate.evaluate(callOf('Read'));
    expect(verdict?.decision.ruleId).toBe('task-void:exception');
  });

  it('treats a throwing key store as void', async () => {
    const gate = createScopeGate({
      ...base,
      keys: {
        readPublicKey: () => {
          throw new Error('boom');
        },
      },
    });
    expect((await gate.evaluate(callOf('Read')))?.decision.ruleId).toBe('task-void:exception');
  });

  it('treats a clock that throws as void', async () => {
    const gate = createScopeGate({
      ...base,
      now: () => {
        throw new Error('no clock');
      },
    });
    expect((await gate.evaluate(callOf('Read')))?.decision.ruleId).toBe('task-void:exception');
  });

  it('treats an input it cannot read as void', async () => {
    const gate = createScopeGate(base);
    for (const input of [undefined, null, {}, { event: null }, 7]) {
      const verdict = await gate.evaluate(input as unknown as ScopeGateInput);
      expect(verdict?.decision.effect).toBe('deny');
      expect(verdict?.decision.ruleId).toMatch(/^task-void:/);
    }
  });

  it('uses a placeholder rather than a hostile task id in the verdict and still denies', async () => {
    const gate = createScopeGate({ ...base, taskId: '../../etc' });
    const verdict = await gate.evaluate(callOf('Read'));
    expect(verdict?.decision.ruleId).toBe('task-void:bad-task-id');
    expect(verdict?.taskId).toBe('invalid');
    expect(gate.activeTask()).toBe('invalid');
  });
});
