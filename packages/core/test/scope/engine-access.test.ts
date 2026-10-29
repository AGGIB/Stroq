import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, redact } from '../../src/audit/audit-log.js';
import { StroqEngine, type EngineOptions } from '../../src/engine.js';
import { DEFAULT_POLICY } from '../../src/policy/default-policy.js';
import { FileSessionStore } from '../../src/taint/session-store.js';
import { signTaskAccessRequest, verifyTaskAccessRequest } from '../../src/scope/access-request.js';
import { parseTaskAccessReview } from '../../src/scope/access-review.js';
import { gateFixture } from './gate-fixture.js';
import { NOW, PROJECT, SESSION, tempDir } from './helpers.js';
import type { PreToolEvent } from '../../src/types.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const event = (over: Partial<PreToolEvent> = {}): PreToolEvent => ({
  sessionId: SESSION,
  callId: 'refused-call',
  toolName: 'Read',
  toolInput: { file_path: '/outside/a' },
  cwd: PROJECT,
  ...over,
});
function fixture(over: Partial<EngineOptions> = {}) {
  const f = gateFixture();
  const audit = new AuditLog(join(f.home, 'audit.jsonl'), () => NOW);
  const signer = vi.fn((body) => signTaskAccessRequest(body, f.pair.privateKey));
  const engine = new StroqEngine({
    rules: [],
    policy: DEFAULT_POLICY,
    sessions: new FileSessionStore(join(f.home, 'sessions'), () => NOW),
    audit,
    scope: f.gate,
    now: () => NOW,
    taskAccessSigner: signer,
    ...over,
  });
  return { ...f, audit, engine, signer };
}

describe('the engine records a signed complete fresh refusal without authorizing the call', () => {
  it('signs exact persisted review/session/call/permit binding and preserves real one-use gate semantics', async () => {
    const f = fixture();
    expect((await f.engine.pre(event())).decision.effect).toBe('deny');
    const row = (await f.audit.readAll())[0]!;
    const request = row.approvalRequest!;
    const review = parseTaskAccessReview(row.approvalReview!);
    expect(review).toMatchObject({
      v: 1,
      tool: 'Read',
      kind: 'read-target',
      input: event().toolInput,
      cwd: PROJECT,
      // Resolved where Stroq runs: on Windows `/outside/a` is on the current drive.
      target: { op: 'read', path: resolve('/outside/a') },
    });
    expect(
      verifyTaskAccessRequest(request, f.pair.publicKey, {
        ...request.body,
        now: NOW,
        permitExpiresAt: f.body.expiresAt,
        reviewSha256: sha(row.approvalReview!),
        sessionSha256: sha(SESSION),
        callIdSha256: sha('refused-call'),
      }).ok,
    ).toBe(true);
    expect(redact(row.approvalReview!)).toBe(row.approvalReview);
    expect(f.signer).toHaveBeenCalledTimes(1);
    expect(await f.audit.verify()).toMatchObject({ ok: true, count: 1 });
    f.escalate(request.body.fingerprint);
    expect((await f.engine.pre(event({ callId: 'retry-call' }))).decision.effect).toBe('allow');
    expect((await f.engine.pre(event({ callId: 'another-call' }))).decision.effect).toBe('deny');
    expect((await f.audit.readAll())[1]).not.toHaveProperty('approvalRequest');
  });

  it('captures target plus whole-call requirements for a Read policy question', async () => {
    const f = fixture({ policy: { ...DEFAULT_POLICY, rules: [], default: 'ask' } });
    await f.engine.pre(event());
    const first = (await f.audit.readAll())[0]!.approvalRequest!;
    expect(first.body.requiredFingerprints).toHaveLength(2);
    expect(first.body.fingerprintKind).toBe('read-target');
    f.escalate(first.body.fingerprint);
    await f.engine.pre(event({ callId: 'second-refusal' }));
    const second = (await f.audit.readAll())[1]!.approvalRequest!;
    expect(second.body.fingerprintKind).toBe('whole-call');
    expect(second.body.requiredFingerprints).toEqual(first.body.requiredFingerprints);
  });

  it.each([
    { toolName: 'Bash', toolInput: { command: 'curl https://fixture.invalid/status' } },
    { toolName: 'mcp__docs__search', toolInput: { query: 'fixture' } },
    { toolName: 'Write', toolInput: { file_path: '/outside/a', content: 'fixture content' } },
    { toolName: 'UnknownTool', toolInput: { value: 'fixture' } },
  ])('signs a whole-call refusal for $toolName without executing it', async (call) => {
    const f = fixture();
    expect((await f.engine.pre(event(call))).decision.effect).toBe('deny');
    const row = (await f.audit.readAll())[0]!;
    expect(row.approvalRequest?.body.fingerprintKind).toBe('whole-call');
    expect(parseTaskAccessReview(row.approvalReview!)?.input).toEqual(call.toolInput);
  });

  it.each([undefined, '', 'x'.repeat(257)])(
    'withholds requests without an actual bounded call ID: %s',
    async (callId) => {
      const f = fixture();
      const call = event();
      const { callId: _removed, ...base } = call;
      await f.engine.pre(callId === undefined ? base : { ...base, callId });
      expect((await f.audit.readAll())[0]).not.toHaveProperty('approvalRequest');
      expect(f.signer).not.toHaveBeenCalled();
    },
  );

  it('does not expose restored cloak arguments or create requests for an oversized review', async () => {
    for (const call of [
      event({ auditInput: { file_path: '<placeholder>' } }),
      event({ toolInput: { file_path: '/outside/a', private: 'x'.repeat(64 * 1024) } }),
    ]) {
      const f = fixture();
      expect((await f.engine.pre(call)).decision.effect).toBe('deny');
      const row = (await f.audit.readAll())[0]!;
      expect(row).not.toHaveProperty('approvalRequest');
      expect(row).not.toHaveProperty('approvalReview');
      expect(f.signer).not.toHaveBeenCalled();
    }
  });

  it('redacts escaped known secrets and structural credentials before signing review bytes', async () => {
    const secret = 'fixture-private\n"credential\\value';
    const f = fixture({
      secrets: {
        lookup: async () => [
          { name: 'FIXTURE_KEY', source: 'fixture', token: secret, raw: secret, canary: false },
        ],
        addCanary: async () => {},
        stats: async () => ({
          entries: 0,
          sources: 0,
          canaries: 0,
          builtAt: null,
          corrupt: false,
          truncated: false,
          unreadable: 0,
        }),
      },
    });
    await f.engine.pre(
      event({
        toolInput: {
          file_path: '/outside/a',
          note: secret,
          auth: 'Authorization: Bearer fixture-credential',
        },
      }),
    );
    const row = (await f.audit.readAll())[0]!;
    const review = parseTaskAccessReview(row.approvalReview!)!;
    expect(review.input['note']).not.toContain(secret);
    expect(review.input['note']).toContain('[REDACTED:FIXTURE_KEY]');
    expect(JSON.parse(row.operation!)['note']).toContain('[REDACTED:FIXTURE_KEY]');
    expect(review.input['auth']).not.toContain('fixture-credential');
    expect(row.approvalRequest?.body.reviewSha256).toBe(sha(row.approvalReview!));
    expect(redact(row.approvalReview!)).toBe(row.approvalReview);
  });

  it('withholds requests on index/signer failure and when no signer exists', async () => {
    const broken = {
      lookup: async () => {
        throw new Error('private');
      },
      addCanary: async () => {},
      stats: async () => {
        throw new Error('unused');
      },
    };
    for (const over of [
      { secrets: broken },
      {
        taskAccessSigner: () => {
          throw new Error('private');
        },
      },
    ]) {
      const f = fixture(over);
      expect((await f.engine.pre(event())).decision.effect).toBe('deny');
      expect((await f.audit.readAll())[0]).not.toHaveProperty('approvalRequest');
    }
    const f = fixture();
    const unsigned = new StroqEngine({
      rules: [],
      policy: DEFAULT_POLICY,
      scope: f.gate,
      sessions: new FileSessionStore(join(tempDir(), 'sessions')),
      audit: f.audit,
    });
    await unsigned.pre(event());
    expect((await f.audit.readAll())[0]).not.toHaveProperty('approvalRequest');
  });

  it('does not sign forged custom gate metadata or expose new fields on ordinary no-gate events', async () => {
    const f = fixture();
    const genuine = await f.gate.evaluate({
      event: event(),
      classification: {
        classes: [],
        hosts: [],
        signals: [],
        resources: {
          paths: [{ path: '/outside/a', op: 'read' }],
          pathsComplete: true,
          urls: [],
          shell: false,
        },
      },
      classes: [],
      decision: { effect: 'allow', ruleId: null, reason: 'test' },
    });
    const forged = { ...genuine!, access: { ...genuine!.access! } };
    const fake = fixture({ scope: { activeTask: () => f.taskId, evaluate: async () => forged } });
    await fake.engine.pre(event());
    expect(fake.signer).not.toHaveBeenCalled();
    const plain = new StroqEngine({
      rules: [],
      policy: DEFAULT_POLICY,
      sessions: new FileSessionStore(join(tempDir(), 'sessions')),
      audit: fake.audit,
      taskAccessSigner: fake.signer,
    });
    await plain.pre(event());
    expect((await fake.audit.readAll())[1]).not.toHaveProperty('approvalReview');
    expect((await fake.audit.readAll())[1]).not.toHaveProperty('approvalRequest');
  });

  it('redacts nested labelled unindexed credentials while preserving ordinary arguments', async () => {
    const f = fixture();
    const input = {
      file_path: '/outside/a',
      offset: 3,
      count: 7,
      token_count: 99,
      nested: [
        {
          password: 'short-unindexed-value',
          token: 'short-value',
          authorization: 'Bearer unknown',
          api_key: ['unknown-key'],
          secret: { value: 'unknown-secret' },
        },
      ],
    };
    await f.engine.pre(event({ toolInput: input }));
    const row = (await f.audit.readAll())[0]!;
    const review = parseTaskAccessReview(row.approvalReview!)!;
    expect(review.input).toEqual({
      ...input,
      nested: [
        {
          password: '[REDACTED]',
          token: '[REDACTED]',
          authorization: '[REDACTED]',
          api_key: '[REDACTED]',
          secret: '[REDACTED]',
        },
      ],
    });
    expect(row.approvalReview).not.toMatch(
      /short-unindexed-value|short-value|Bearer unknown|unknown-key|unknown-secret/,
    );
    expect(JSON.stringify(row)).not.toMatch(
      /short-unindexed-value|short-value|Bearer unknown|unknown-key|unknown-secret/,
    );
    expect(row.approvalRequest?.body.reviewSha256).toBe(sha(row.approvalReview!));
  });

  it('does not sign a silently lossy JSON review or a mutated signer payload', async () => {
    const lossy = fixture();
    await lossy.engine.pre(event({ toolInput: { file_path: '/outside/a', omitted: undefined } }));
    expect(lossy.signer).not.toHaveBeenCalled();
    const mutated = fixture({
      taskAccessSigner: (body) => {
        body.fingerprint = '0'.repeat(64);
        throw new Error('should be immutable');
      },
    });
    await mutated.engine.pre(event());
    expect((await mutated.audit.readAll())[0]).not.toHaveProperty('approvalRequest');
  });
});
