import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { AuditLog } from '../../src/audit/audit-log.js';
import { StroqEngine } from '../../src/engine.js';
import { DEFAULT_POLICY } from '../../src/policy/default-policy.js';
import type { ScopeGate, ScopeGateInput } from '../../src/scope/types.js';
import { FileSessionStore } from '../../src/taint/session-store.js';
import type { PreToolEvent } from '../../src/types.js';
import { gateFixture } from './gate-fixture.js';
import { NOW, SESSION, tempDir } from './helpers.js';

function fixture(withScope = true) {
  const base = realpathSync(tempDir('scope-resources-integration'));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(outside, 'nested'), { recursive: true });
  writeFileSync(join(project, 'src', 'allowed.txt'), 'fixture marker');
  writeFileSync(join(outside, 'marker.txt'), 'outside fixture marker');
  symlinkSync(join(outside, 'nested'), join(project, 'escape'));
  const f = gateFixture({
    body: { projectRoot: project },
    run: { projectRoot: project },
    scope: {
      tools: ['Read', 'Write'],
      read: { allow: [`${project}/**`], deny: [] },
      write: { allow: [`${project}/**`], deny: [] },
      mcp: [{ server: 'fs', tools: ['read_file'] }],
    },
  });
  const audit = new AuditLog(join(f.home, 'integration-audit.jsonl'));
  let seen: ScopeGateInput | undefined;
  const scope: ScopeGate = {
    activeTask: () => f.gate.activeTask(),
    evaluate: async (input) => {
      seen = input;
      return f.gate.evaluate(input);
    },
  };
  const engine = new StroqEngine({
    rules: [],
    policy: DEFAULT_POLICY,
    sessions: new FileSessionStore(join(f.home, 'sessions'), () => NOW),
    audit,
    now: () => NOW,
    ...(withScope ? { scope } : {}),
  });
  const event = (toolName: string, toolInput: Record<string, unknown>): PreToolEvent => ({
    sessionId: SESSION,
    cwd: project,
    toolName,
    toolInput,
    callId: 'integration-call',
  });
  return { ...f, project, outside, audit, engine, event, seen: () => seen };
}

// These cases exercise real POSIX symlink/parent semantics, not a fabricated resource inventory.
// Calls stop at engine.pre: no proposed tool operation or shell command is executed.
describe.skipIf(process.platform === 'win32')(
  'classifier resources through engine and task scope',
  () => {
    it('allows an ordinary file after carrying its complete real inventory into the gate', async () => {
      const f = fixture();
      const call = f.event('Read', { file_path: 'src/allowed.txt' });
      const classified = classifyTool(call.toolName, call.toolInput, call.cwd);
      expect((await f.engine.pre(call)).decision.effect).toBe('allow');
      expect(f.seen()?.classification.resources).toEqual(classified.resources);
      expect(classified.resources).toMatchObject({
        paths: [{ op: 'read', path: join(f.project, 'src', 'allowed.txt') }],
        pathsComplete: true,
      });
      expect((await f.audit.readAll())[0]).toMatchObject({
        taskId: f.taskId,
        callId: call.callId,
        scope: { kind: 'in-scope' },
      });
      expect(await f.audit.verify()).toMatchObject({ ok: true, count: 1 });
    });

    it('denies link/../ traversal even when the lexical path stays inside the project', async () => {
      const f = fixture();
      const raw = `${f.project}/escape/../marker.txt`;
      expect(readFileSync(raw, 'utf8')).toBe('outside fixture marker');
      const result = await f.engine.pre(f.event('Read', { file_path: raw }));
      expect(f.seen()?.classification.resources).toMatchObject({
        paths: [
          { op: 'read', path: join(f.project, 'marker.txt'), real: join(f.outside, 'marker.txt') },
        ],
        pathsComplete: true,
      });
      expect(result.decision).toMatchObject({ effect: 'deny', ruleId: 'task-scope-path' });
    });

    it('denies a deeply absent write target reached through an outside symlink', async () => {
      const f = fixture();
      const raw = `${f.project}/escape/future/deeper/new.txt`;
      const target = join(f.outside, 'nested', 'future', 'deeper', 'new.txt');
      expect(existsSync(target)).toBe(false);
      const result = await f.engine.pre(f.event('Write', { file_path: raw, content: 'marker' }));
      expect(f.seen()?.classification.resources).toMatchObject({
        paths: [{ op: 'write', path: raw, real: target }],
        pathsComplete: true,
      });
      expect(result.decision).toMatchObject({ effect: 'deny', ruleId: 'task-scope-path' });
      expect(existsSync(target)).toBe(false);
    });

    it('does not hide a malformed MCP path alias behind another valid path', async () => {
      const f = fixture();
      const result = await f.engine.pre(
        f.event('mcp__fs__read_file', {
          path: join(f.project, 'src', 'allowed.txt'),
          files: [false],
        }),
      );
      expect(f.seen()?.classification.resources?.pathsComplete).toBe(false);
      expect(result.decision).toMatchObject({ effect: 'deny', ruleId: 'task-scope-incomplete' });
    });

    it('keeps legacy policy behavior when the same resource-bearing call has no scope gate', async () => {
      const f = fixture(false);
      const call = f.event('Read', { file_path: `${f.project}/escape/../marker.txt` });
      expect(classifyTool(call.toolName, call.toolInput, call.cwd).resources?.paths[0]?.real).toBe(
        join(f.outside, 'marker.txt'),
      );
      const result = await f.engine.pre(call);
      expect(result.decision.effect).toBe('allow');
      expect(f.seen()).toBeUndefined();
      const entry = (await f.audit.readAll())[0];
      expect(entry?.decision).toEqual(result.decision);
      expect(entry).not.toHaveProperty('taskId');
      expect(entry).not.toHaveProperty('scope');
    });
  },
);
