import fc from 'fast-check';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newEscalationBody, signEscalation } from '../../src/scope/escalation.js';
import { createScopeGate } from '../../src/scope/gate.js';
import { HARD_CLASSES } from '../../src/scope/hard-set.js';
import { keyIdOf } from '../../src/scope/keys.js';
import { evaluatePath } from '../../src/scope/paths.js';
import { signPermit } from '../../src/scope/permit.js';
import type { PermitStore } from '../../src/scope/store.js';
import type { ScopeGate, ScopeGateInput, TaskScope } from '../../src/scope/types.js';
import { ACTION_CLASSES, type ActionClass, type ToolResources } from '../../src/types.js';
import { ALLOW, ASK, DENY, POSIX_PATHS, callOf, gateFixture } from './gate-fixture.js';
import {
  NOW,
  NONCE,
  POLICY_DIGEST,
  PROJECT,
  STATE_DIGESTS,
  rawOf,
  sampleBody,
  sampleScope,
  testKeys,
} from './helpers.js';

const keys = testKeys();
const TASK = 'fix-login-1';
const KNOWN_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'Task',
];
const FILE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const GLOBS = [
  `${PROJECT}/**`,
  `${PROJECT}/src/**`,
  `${PROJECT}/**/.env*`,
  `${PROJECT}/.git/**`,
  '/etc/**',
  '/**',
];
const PATHS = [
  `${PROJECT}/src/a.ts`,
  `${PROJECT}/.env`,
  `${PROJECT}/.git/config`,
  `${PROJECT}/README.md`,
  '/etc/passwd',
  `${PROJECT}/src/../../etc/hosts`,
  'relative/x.ts',
];

/** A store and key set held in memory, so that a property can run thousands of times. */
function memoryGate(permitText: string, escalateEverything: boolean): ScopeGate {
  const store: PermitStore = {
    readPermit: () => ({ kind: 'present', text: permitText }),
    readEscalation: (taskId, fingerprint) =>
      escalateEverything
        ? {
            kind: 'present',
            text: rawOf(
              signEscalation(
                newEscalationBody({ taskId, nonce: NONCE, fingerprint, now: NOW }),
                keys.privateKey,
              ),
            ),
          }
        : { kind: 'absent' },
    consumeEscalation: () => true,
  };
  return createScopeGate({
    taskId: TASK,
    store,
    keys: {
      readPublicKey: () => ({ kind: 'ok', key: keys.publicKey, keyId: keyIdOf(keys.publicKey) }),
    },
    context: () => ({
      nonce: NONCE,
      projectRoot: PROJECT,
      policyDigest: POLICY_DIGEST,
      stateDigests: { ...STATE_DIGESTS },
    }),
    now: () => NOW,
    paths: POSIX_PATHS,
  });
}

const gateFor = (scope: TaskScope, escalateEverything = false): ScopeGate =>
  memoryGate(rawOf(signPermit(sampleBody({ scope }), keys.privateKey)), escalateEverything);

const globs = fc.subarray(GLOBS, { maxLength: 4 });
const scopes: fc.Arbitrary<TaskScope> = fc.record({
  tools: fc.subarray(KNOWN_TOOLS),
  read: fc.record({ allow: globs, deny: globs }),
  write: fc.record({ allow: globs, deny: globs }),
  net: fc.oneof(
    fc.constant({ mode: 'none' as const }),
    fc.record({
      mode: fc.constant('hosts' as const),
      hosts: fc.subarray(['api.example.com', '*.example.org', 'example.net']),
    }),
  ),
  mcp: fc.subarray([
    { server: 'docs', tools: '*' as const },
    { server: 'docs', tools: ['search'] },
    { server: 'a', tools: ['b'] },
  ]),
  shell: fc.constantFrom('allowed' as const, 'denied' as const),
});

const resources: fc.Arbitrary<ToolResources | undefined> = fc
  .option(
    fc.record({
      paths: fc.array(
        fc.record({
          path: fc.constantFrom(...PATHS),
          op: fc.constantFrom('read' as const, 'write' as const),
          real: fc.option(fc.constantFrom(...PATHS), { nil: undefined }),
        }),
        { maxLength: 3 },
      ),
      pathsComplete: fc.boolean(),
      urls: fc.constant([]),
      shell: fc.boolean(),
    }),
    { nil: undefined },
  )
  .map((r) =>
    r === undefined
      ? undefined
      : {
          ...r,
          paths: r.paths.map(({ real, ...rest }) =>
            real === undefined ? rest : { ...rest, real },
          ),
        },
  );

const tools = fc.oneof(
  fc.constantFrom(...KNOWN_TOOLS),
  fc.constantFrom('mcp__docs__search', 'mcp__a__b', 'mcp__x__y', 'mcp__'),
  fc.string({ maxLength: 10 }),
);
const anyClasses = fc.subarray([...ACTION_CLASSES]);
const decisions = fc.constantFrom(ALLOW, ASK, DENY);

const callArb = (classes: fc.Arbitrary<readonly ActionClass[]>) =>
  fc
    .record({ tool: tools, classes, decision: decisions, res: resources })
    .map(({ tool, classes: cls, decision, res }) =>
      callOf(
        tool,
        { file_path: PATHS[0] },
        { classes: cls, decision, ...(res ? { resources: res } : {}) },
      ),
    );

const RUNS = { numRuns: 300 };

describe('properties of the gate', () => {
  it('never allows a call that has a hard class, whatever the scope, the policy or the escalations', async () => {
    const hard = fc.tuple(anyClasses, fc.constantFrom(...HARD_CLASSES)).map(([a, h]) => [...a, h]);
    await fc.assert(
      fc.asyncProperty(scopes, callArb(hard), fc.boolean(), async (scope, input, escalate) => {
        const verdict = await gateFor(scope, escalate).evaluate(input);
        expect(verdict?.decision.effect).toBe('deny');
        expect(verdict?.decision.ruleId).toMatch(/^task-hard:/);
      }),
      RUNS,
    );
  });

  it('never turns a policy deny into an allow, with every escalation on offer', async () => {
    await fc.assert(
      fc.asyncProperty(scopes, callArb(anyClasses), fc.boolean(), async (scope, base, escalate) => {
        const input: ScopeGateInput = { ...base, decision: DENY };
        const verdict = await gateFor(scope, escalate).evaluate(input);
        expect(verdict?.decision.effect).toBe('deny');
      }),
      RUNS,
    );
  });

  it('never allows more than the policy allowed unless a signed escalation said so', async () => {
    await fc.assert(
      fc.asyncProperty(scopes, callArb(anyClasses), async (scope, input) => {
        const verdict = await gateFor(scope, false).evaluate(input);
        if (verdict?.decision.effect === 'allow') {
          expect(input.decision.effect).toBe('allow');
          expect(verdict.evidence.kind).toBe('in-scope');
        }
      }),
      RUNS,
    );
  });

  it('denies a tool the scope does not list, whatever the policy said', async () => {
    const unknown = fc.string({ maxLength: 12 }).filter((name) => !name.startsWith('mcp__'));
    await fc.assert(
      fc.asyncProperty(
        scopes,
        unknown,
        anyClasses,
        decisions,
        async (scope, name, classes, decision) => {
          fc.pre(!scope.tools.includes(name));
          const verdict = await gateFor(scope).evaluate(callOf(name, {}, { classes, decision }));
          expect(verdict?.decision.effect).toBe('deny');
          expect(verdict?.decision.ruleId).toMatch(/^task-(hard|scope-tool)/);
        },
      ),
      RUNS,
    );
  });

  it('only allows a file tool whose every path passes the path rules, real paths included', async () => {
    await fc.assert(
      fc.asyncProperty(scopes, callArb(fc.constant([])), async (scope, input) => {
        const verdict = await gateFor(scope).evaluate(input);
        const tool = input.event.toolName;
        if (verdict?.decision.effect !== 'allow' || !FILE_TOOLS.has(tool)) return;
        const found = input.classification.resources;
        expect(found?.pathsComplete).toBe(true);
        for (const p of found?.paths ?? []) {
          const rules = p.op === 'read' ? scope.read : scope.write;
          expect(evaluatePath(rules, p, POSIX_PATHS)).toBe('allow');
        }
      }),
      RUNS,
    );
  });

  it('gives the same answer to the same call twice', async () => {
    await fc.assert(
      fc.asyncProperty(scopes, callArb(anyClasses), async (scope, input) => {
        const gate = gateFor(scope);
        expect(await gate.evaluate(input)).toEqual(await gate.evaluate(input));
      }),
      RUNS,
    );
  });
});

describe('corrupt permit bytes give deny-all and never an exception', () => {
  const read = callOf('Read', { file_path: `${PROJECT}/src/a.ts` });

  it('denies Read for arbitrary bytes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 4000 }), async (bytes) => {
        const gate = memoryGate(Buffer.from(bytes).toString('utf8'), false);
        const verdict = await gate.evaluate(read);
        expect(verdict?.decision.effect).toBe('deny');
        expect(verdict?.decision.ruleId).toMatch(/^task-void:/);
      }),
      { numRuns: 500 },
    );
  });

  it('denies Read for a good permit with one byte replaced or the end cut off', async () => {
    const good = rawOf(signPermit(sampleBody({ scope: sampleScope() }), keys.privateKey));
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: good.length - 1 }),
        fc.integer({ min: 0, max: 255 }),
        fc.boolean(),
        async (at, byte, cut) => {
          const text = cut
            ? good.slice(0, at)
            : good.slice(0, at) +
              String.fromCharCode(byte === good.charCodeAt(at) ? byte ^ 1 : byte) +
              good.slice(at + 1);
          const verdict = await memoryGate(text, false).evaluate(read);
          expect(verdict?.decision.effect).toBe('deny');
          expect(verdict?.decision.ruleId).toMatch(/^task-void:/);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('denies Read for arbitrary bytes in the real permit file, up to well past the size cap', async () => {
    const f = gateFixture({ permit: 'none' });
    mkdirSync(join(f.home, 'tasks', f.taskId), { recursive: true });
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.uint8Array({ maxLength: 3000 }),
          fc.uint8Array({ minLength: 70_000, maxLength: 70_100 }),
        ),
        async (bytes) => {
          writeFileSync(join(f.home, 'tasks', f.taskId, 'permit.json'), bytes);
          const verdict = await f.gate.evaluate(read);
          expect(verdict?.decision.effect).toBe('deny');
          expect(verdict?.decision.ruleId).toMatch(/^task-void:/);
        },
      ),
      { numRuns: 40 },
    );
  });
});
