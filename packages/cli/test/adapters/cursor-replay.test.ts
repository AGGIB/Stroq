import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleCursorHook } from '../../src/adapters/cursor.js';
import { createEngine } from '../../src/engine-factory.js';

const fixtureRoot = fileURLToPath(new URL('../fixtures/hosts/cursor/synthetic/', import.meta.url));

const readFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtureRoot, name), 'utf8'));

const readAuditLines = (homeDir: string): Record<string, unknown>[] => {
  const auditPath = join(homeDir, 'audit.jsonl');
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
};

describe('Synthetic Cursor adapter fixture replay', () => {
  let home: string;
  let testProject: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stroq-cursor-replay-home-'));
    process.env['STROQ_HOME'] = home;
    testProject = mkdtempSync(join(tmpdir(), 'stroq-cursor-replay-project-'));
  });

  it('replays allow.write through production adapter with decision and audit parity', async () => {
    const event = readFixture('allow.write.event.json');
    const evidence = readFixture('allow.write.evidence.json');
    const recordedAudit = readFileSync(join(fixtureRoot, 'allow.write.audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    const out = await handleCursorHook(createEngine(), event);
    expect(out.exitCode).toBe(evidence['exitCode']);
    expect(out.stdout).toBe(evidence['stdout']);

    const audit = readAuditLines(home);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      sessionId: recordedAudit[0]!['sessionId'],
      phase: recordedAudit[0]!['phase'],
      tool: recordedAudit[0]!['tool'],
      summary: recordedAudit[0]!['summary'],
      decision: recordedAudit[0]!['decision'],
    });
  });

  it('replays allow.post-edit observation with correct audit attribution', async () => {
    const event = readFixture('allow.post-edit.event.json');
    const evidence = readFixture('allow.post-edit.evidence.json');
    const recordedAudit = readFileSync(join(fixtureRoot, 'allow.post-edit.audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    const out = await handleCursorHook(createEngine(), event);
    expect(out.exitCode).toBe(evidence['exitCode']);
    expect(out.stdout).toBe(evidence['stdout']);

    const audit = readAuditLines(home);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      sessionId: recordedAudit[0]!['sessionId'],
      phase: 'post',
      tool: 'Write',
      decision: {
        effect: 'allow',
        ruleId: 'cursor-edit-observed',
      },
    });
  });

  it('replays deny.write and enforces deny-self-tamper on protected hooks', async () => {
    const event = readFixture('deny.write.event.json');
    const evidence = readFixture('deny.write.evidence.json');
    const recordedAudit = readFileSync(join(fixtureRoot, 'deny.write.audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    const out = await handleCursorHook(createEngine(), event);
    expect(out.exitCode).toBe(evidence['exitCode']);
    const body = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(body['permission']).toBe('deny');
    expect(String(body['user_message'])).toContain(String(evidence['ruleId']));

    const audit = readAuditLines(home);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      sessionId: recordedAudit[0]!['sessionId'],
      phase: 'pre',
      tool: 'Write',
      classes: ['config.self'],
      decision: {
        effect: 'deny',
        ruleId: 'deny-self-tamper',
      },
    });
  });

  it('replays allow.delete and allows deletion of non-protected files', async () => {
    const event = readFixture('allow.delete.event.json');
    const evidence = readFixture('allow.delete.evidence.json');

    const out = await handleCursorHook(createEngine(), event);
    expect(out.exitCode).toBe(evidence['exitCode']);
    expect(out.stdout).toBe(evidence['stdout']);

    const audit = readAuditLines(home);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      phase: 'pre',
      tool: 'Write',
      decision: { effect: 'allow' },
    });
  });

  it('replays deny.delete and prevents deletion of protected configuration', async () => {
    const event = readFixture('deny.delete.event.json');
    const evidence = readFixture('deny.delete.evidence.json');

    const out = await handleCursorHook(createEngine(), event);
    expect(out.exitCode).toBe(evidence['exitCode']);
    const body = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(body['permission']).toBe('deny');
    expect(String(body['user_message'])).toContain(String(evidence['ruleId']));

    const audit = readAuditLines(home);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      phase: 'pre',
      tool: 'Write',
      classes: ['config.self'],
      decision: {
        effect: 'deny',
        ruleId: 'deny-self-tamper',
      },
    });
  });

  describe('simulated sentinel outcomes (no host)', () => {
    it('demonstrates that allowed write creates sentinel and triggers observation', async () => {
      const sentinelPath = join(testProject, 'src', 'allowed-sentinel.ts');
      const sentinelContent = 'export const msg = "sentinel-ok";\n';

      // 1. preToolUse check
      const preOut = await handleCursorHook(createEngine(), {
        conversation_id: 'sentinel-sess-1',
        generation_id: 'gen-sentinel-1',
        hook_event_name: 'preToolUse',
        workspace_roots: [testProject],
        cwd: testProject,
        tool_name: 'Write',
        tool_input: { file_path: sentinelPath, content: sentinelContent },
      });

      // Allowed action produces no block
      expect(preOut).toEqual({ stdout: '', exitCode: 0 });

      // Simulated host executes the write
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(testProject, 'src'), { recursive: true });
      writeFileSync(sentinelPath, sentinelContent);
      expect(existsSync(sentinelPath)).toBe(true);
      expect(readFileSync(sentinelPath, 'utf8')).toBe(sentinelContent);

      // 2. afterFileEdit observation is emitted
      const postOut = await handleCursorHook(createEngine(), {
        conversation_id: 'sentinel-sess-1',
        generation_id: 'gen-sentinel-1',
        hook_event_name: 'afterFileEdit',
        workspace_roots: [testProject],
        cwd: testProject,
        file_path: sentinelPath,
        edits: [{ old_string: '', new_string: sentinelContent }],
      });

      expect(postOut).toEqual({ stdout: '', exitCode: 0 });

      const audit = readAuditLines(home);
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({ phase: 'pre', decision: { effect: 'allow' } });
      expect(audit[1]).toMatchObject({
        phase: 'post',
        decision: { effect: 'allow', ruleId: 'cursor-edit-observed' },
      });
    });

    it('demonstrates that denied write aborts host action without emitting afterFileEdit', async () => {
      const protectedPath = join(testProject, '.cursor', 'hooks.json');
      const initialContent = '{"version":1,"hooks":{}}';
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(testProject, '.cursor'), { recursive: true });
      writeFileSync(protectedPath, initialContent);

      // 1. preToolUse check
      const preOut = await handleCursorHook(createEngine(), {
        conversation_id: 'sentinel-sess-2',
        generation_id: 'gen-sentinel-2',
        hook_event_name: 'preToolUse',
        workspace_roots: [testProject],
        cwd: testProject,
        tool_name: 'Write',
        tool_input: { file_path: protectedPath, content: '{"hooks":{"preToolUse":[]}}' },
      });

      const body = JSON.parse(preOut.stdout) as Record<string, unknown>;
      expect(body['permission']).toBe('deny');
      expect(String(body['user_message'])).toContain('deny-self-tamper');

      // Simulated host obeys deny: operation is aborted, file remains unmodified
      expect(readFileSync(protectedPath, 'utf8')).toBe(initialContent);

      // Simulated host does NOT emit afterFileEdit for an aborted write
      const audit = readAuditLines(home);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        phase: 'pre',
        classes: ['config.self'],
        decision: { effect: 'deny', ruleId: 'deny-self-tamper' },
      });
    });

    it('demonstrates that allowed delete deletes file and denied delete preserves file', async () => {
      const tempFile = join(testProject, 'scratch.tmp');
      writeFileSync(tempFile, 'temporary');

      // Allowed delete
      const allowOut = await handleCursorHook(createEngine(), {
        conversation_id: 'sentinel-sess-3',
        generation_id: 'gen-sentinel-3',
        hook_event_name: 'preToolUse',
        workspace_roots: [testProject],
        cwd: testProject,
        tool_name: 'Delete',
        tool_input: { file_path: tempFile },
      });
      expect(allowOut).toEqual({ stdout: '', exitCode: 0 });
      unlinkSync(tempFile);
      expect(existsSync(tempFile)).toBe(false);

      // Denied delete on protected file
      const protectedFile = join(testProject, '.cursor', 'hooks.json');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(testProject, '.cursor'), { recursive: true });
      writeFileSync(protectedFile, '{"version":1}');

      const denyOut = await handleCursorHook(createEngine(), {
        conversation_id: 'sentinel-sess-3',
        generation_id: 'gen-sentinel-3',
        hook_event_name: 'preToolUse',
        workspace_roots: [testProject],
        cwd: testProject,
        tool_name: 'Delete',
        tool_input: { file_path: protectedFile },
      });
      const denyBody = JSON.parse(denyOut.stdout) as Record<string, unknown>;
      expect(denyBody['permission']).toBe('deny');
      // Simulated host aborts delete: file is preserved
      expect(existsSync(protectedFile)).toBe(true);
    });
  });
});
