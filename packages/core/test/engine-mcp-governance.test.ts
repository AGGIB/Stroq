import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit/audit-log.js';
import { classifyTool } from '../src/actions/classify-tool.js';
import { StroqEngine, type EngineOptions } from '../src/engine.js';
import { DEFAULT_POLICY } from '../src/policy/default-policy.js';
import { PolicySchema } from '../src/policy/policy-types.js';
import { FileSecretIndex } from '../src/secrets/index.js';
import { FileSessionStore } from '../src/taint/session-store.js';
import { wholeCallFingerprint } from '../src/scope/scope-check.js';
import type { PreToolEvent } from '../src/types.js';
import { gateFixture } from './scope/gate-fixture.js';
import { NOW, PROJECT, SESSION } from './scope/helpers.js';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const policy = PolicySchema.parse({
  ...DEFAULT_POLICY,
  version: 2,
  mcpGovernance: { allowed: [{ channel: 'claude-code', name: 'docs' }] },
});
const call = (over: Partial<PreToolEvent> = {}): PreToolEvent => ({
  sessionId: SESSION,
  callId: 'fixture-call',
  toolName: 'mcp__docs__search',
  toolInput: { query: 'bounded fixture' },
  cwd: PROJECT,
  mcpIdentity: { kind: 'server', channel: 'claude-code', name: 'docs' },
  ...over,
});
function fixture(over: Partial<EngineOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'stroq-governance-engine-'));
  directories.push(home);
  const sessions = new FileSessionStore(join(home, 'sessions'), () => NOW);
  const audit = new AuditLog(join(home, 'audit.jsonl'), () => NOW);
  const engine = new StroqEngine({ rules: [], policy, sessions, audit, now: () => NOW, ...over });
  return { home, engine, sessions, audit };
}

describe('real engine MCP governance', () => {
  it('records a listed call, an unlisted call and a missing identity as distinct decisions', async () => {
    const f = fixture();
    expect((await f.engine.pre(call())).decision.effect).toBe('allow');
    const unlisted = await f.engine.pre(
      call({ mcpIdentity: { kind: 'server', channel: 'claude-code', name: 'private-server' } }),
    );
    expect(unlisted.decision).toMatchObject({ effect: 'deny', ruleId: 'mcp-governance-unlisted' });
    expect(JSON.stringify(unlisted.decision)).not.toContain('private-server');
    const { mcpIdentity: _identity, ...unknown } = call();
    expect((await f.engine.pre(unknown)).decision.ruleId).toBe('mcp-governance-identity-unknown');
    expect((await f.audit.readAll()).map((row) => row.decision?.ruleId)).toEqual([
      null,
      'mcp-governance-unlisted',
      'mcp-governance-identity-unknown',
    ]);
    expect(await f.audit.verify()).toMatchObject({ ok: true, count: 3 });
  });

  it('leaves ordinary non-MCP work unchanged and recognizes malformed present evidence', async () => {
    const f = fixture();
    const { mcpIdentity: _identity, ...ordinary } = call({
      toolName: 'Read',
      toolInput: { file_path: `${PROJECT}/file.txt` },
    });
    expect((await f.engine.pre(ordinary)).decision.effect).toBe('allow');
    const malformed = await f.engine.pre({
      ...ordinary,
      mcpIdentity: { kind: 'server', channel: 'claude-code' },
    } as never);
    expect(malformed.classes).toContain('mcp.call');
    expect(malformed.decision.ruleId).toBe('mcp-governance-identity-unknown');
  });

  it('keeps the existing suspect-session side-effect question for an allowed server', async () => {
    const f = fixture();
    await f.sessions.markSuspect(SESSION, {
      tool: 'Read',
      ruleIds: ['fixture'],
      at: NOW.toISOString(),
    });
    const result = await f.engine.pre(call({ toolName: 'mcp__docs__post_message' }));
    expect(result.decision).toMatchObject({
      effect: 'ask',
      ruleId: 'ask-mcp-side-effect-when-tainted',
    });
    expect(result.taint?.level).toBe('suspect');
  });

  it('keeps known-secret refusal for allowed identity, including a future MCP spelling', async () => {
    const f = fixture();
    const secret = `fixture_canary_${'x'.repeat(32)}`;
    const index = new FileSecretIndex(join(f.home, 'secrets.json'), f.home, {});
    await index.addCanary(secret, 'fixture');
    const guarded = fixture({ secrets: index });
    for (const toolName of ['mcp__docs__search', 'FutureMcpTool']) {
      const result = await guarded.engine.pre(call({ toolName, toolInput: { query: secret } }));
      expect(result.classes).toContain('secret.egress');
      expect(result.decision.ruleId).toBe('deny-secret-egress');
    }
  });

  it.each([false, true])(
    'lets no scope implementation lift governance refusal (mutates witness: %s)',
    async (mutates) => {
      const f = fixture({
        scope: {
          activeTask: () => null,
          evaluate: async (input) => {
            if (mutates)
              Object.assign(input.event, {
                mcpIdentity: { kind: 'server', channel: 'claude-code', name: 'docs' },
              });
            return {
              taskId: 'fixture',
              decision: { effect: 'allow', ruleId: 'fake-extension', reason: 'extension' },
              evidence: { kind: 'in-scope', ruleId: 'fake-extension' },
            };
          },
        },
      });
      const result = await f.engine.pre(
        call({ mcpIdentity: { kind: 'unavailable', channel: 'claude-code', reason: 'ambiguous' } }),
      );
      expect(result.decision).toMatchObject({
        effect: 'deny',
        ruleId: 'mcp-governance-identity-unknown',
      });
    },
  );

  it('refuses an unlisted label even with a real signed task extension for that call', async () => {
    const g = gateFixture({ scope: { mcp: [{ server: 'docs', tools: '*' }] } });
    directories.push(g.home);
    const refusedPolicy = PolicySchema.parse({ ...policy, mcpGovernance: { allowed: [] } });
    const f = fixture({ policy: refusedPolicy, scope: g.gate });
    const event = call();
    const classification = classifyTool(event.toolName, event.toolInput, event.cwd);
    const fingerprint = wholeCallFingerprint({
      event,
      classification,
      classes: classification.classes,
      decision: { effect: 'allow', ruleId: null, reason: 'fixture' },
    });
    g.escalate(fingerprint);
    for (let i = 0; i < 2; i++) {
      expect((await f.engine.pre(event)).decision).toMatchObject({
        effect: 'deny',
        ruleId: 'mcp-governance-unlisted',
      });
    }
    expect(g.store.readEscalation(g.taskId, fingerprint).kind).toBe('present');
    expect((await f.audit.readAll()).every((row) => row.decision?.effect === 'deny')).toBe(true);
  });

  it('an allowed identity still has to fit the signed task scope', async () => {
    const g = gateFixture();
    directories.push(g.home);
    const f = fixture({ scope: g.gate });
    expect((await f.engine.pre(call())).decision.effect).toBe('deny');
  });
});
