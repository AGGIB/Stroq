import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCopilotHook, type CopilotPhase } from '../../src/adapters/copilot.js';
import { createEngine } from '../../src/engine-factory.js';

const fixture = fileURLToPath(
  new URL('../fixtures/hosts/copilot/1.0.98-darwin-arm64/', import.meta.url),
);
const read = (name: string) => JSON.parse(readFileSync(join(fixture, name), 'utf8'));
const jsonl = (file: string): Record<string, any>[] =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
const records = jsonl(join(fixture, 'hooks.jsonl'));
const audits = jsonl(join(fixture, 'audit.jsonl'));
type SnapshotFile = { path: string; exists: boolean; content: string | null };
const snapshot = (label: string): SnapshotFile[] => read(`${label}.snapshot.json`).files;
const entry = (label: string, path: string): SnapshotFile => {
  const file = snapshot(label).find((f) => f.path === path);
  if (!file) throw new Error(`missing ${label}/${path}`);
  return file;
};

describe('Measured Copilot CLI 1.0.98 darwin-arm64 contract (offline replay only)', () => {
  let scratch: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it('retains measured metadata, wire path forms, and reviewed file hashes', () => {
    const manifest = read('manifest.json');
    expect(manifest).toMatchObject({
      host: 'copilot',
      kind: 'recorded-host',
      version: '1.0.98',
      os: 'darwin',
      recordedDate: '2026-10-15',
    });
    expect(records).toHaveLength(20);
    expect(audits).toHaveLength(17);
    expect(manifest.scope.preToolUse).toEqual({
      bash: ['allow'],
      apply_patch: ['allow', 'deny-self-tamper'],
      view: ['allow'],
    });

    for (const record of records) {
      expect(record.inputHadBom).toBe(false);
      expect(record.stderr).toBe('');
      expect(record.input.sessionId).toMatch(/^copilot-fixture-id-\d{4}$/);
      expect(record.input.cwd).toMatch(/^\/private\/tmp\/stroq-live-fixture\/project/);
    }

    for (const name of manifest.files as string[]) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(fixture, name)))
          .digest('hex'),
      ).toBe(manifest.sha256[name]);
    }
  });

  it('replays every actual invocation through the production adapter with response and audit parity', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'stroq-measured-copilot-'));
    const project = join(scratch, 'project');
    const home = join(scratch, 'stroq-home');
    mkdirSync(join(project, '.claude'), { recursive: true });
    mkdirSync(join(project, 'scratch'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(project, '.claude/settings.json'),
      entry('before-validated', '.claude/settings.json').content!,
    );
    vi.stubEnv('STROQ_HOME', home);

    const relocate = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const prefix = '/private/tmp/stroq-live-fixture/project';
        if (value.startsWith(prefix)) {
          return join(project, ...value.slice(prefix.length).split('/').filter(Boolean));
        }
        return value.replaceAll('/private/tmp/stroq-live-fixture/project', project);
      }
      if (Array.isArray(value)) return value.map(relocate);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([key, each]) => [key, relocate(each)]),
        );
      }
      return value;
    };

    const engine = createEngine();
    for (const record of records) {
      const result = await handleCopilotHook(
        engine,
        record.phase as CopilotPhase,
        relocate(record.input),
      );
      expect(result).toEqual({ stdout: record.stdout, exitCode: record.exitCode });
    }

    const replayAudit = jsonl(join(home, 'audit.jsonl'));
    expect(replayAudit).toHaveLength(audits.length);
    for (const [index, recorded] of audits.entries()) {
      const keys = ['sessionId', 'phase', 'tool', 'classes', 'decision'];
      const expected = Object.fromEntries(
        keys.filter((key) => key in recorded).map((key) => [key, recorded[key]]),
      );
      expect(replayAudit[index]).toMatchObject(relocate(expected) as object);
    }
  });

  it('correlates native gate responses with disk outcomes and the successful ungated Write control', () => {
    const preDeny = records.find(
      (record) => record.phase === 'pre' && record.stdout.includes('deny'),
    );
    expect(preDeny).toBeDefined();
    expect(preDeny!.input.toolName).toBe('apply_patch');
    expect(JSON.parse(preDeny!.stdout)).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('deny-self-tamper'),
    });
    const controlPost = records.find(
      (record) =>
        record.phase === 'post' &&
        record.input.toolName === 'apply_patch' &&
        record.input.toolArgs === preDeny!.input.toolArgs,
    );
    expect(controlPost).toBeDefined();
    expect(controlPost!.input.toolResult.resultType).toBe('success');
    expect(
      records.some(
        (record) =>
          record.phase === 'pre' && record.input.sessionId === controlPost!.input.sessionId,
      ),
    ).toBe(false);

    // Check disk snapshots
    const initialWrite = entry('before-validated', 'scratch/write-me.txt');
    expect(initialWrite.exists).toBe(false);
    expect(entry('before-validated', 'scratch/delete-me.txt').exists).toBe(true);

    // After write
    expect(entry('after-allow-write', 'scratch/write-me.txt')).toMatchObject({
      exists: true,
      content: 'content written by copilot\n',
    });

    // Deny preserved .claude/settings.json
    const protectedBefore = entry('before-validated', '.claude/settings.json');
    expect(entry('after-deny', '.claude/settings.json')).toEqual(protectedBefore);
    expect(entry('before-control', '.claude/settings.json')).toEqual(protectedBefore);

    // After delete
    expect(entry('after-allow-delete', 'scratch/delete-me.txt')).toMatchObject({
      exists: false,
      content: null,
    });

    // Control run: preToolUse disabled permitted tamper
    expect(entry('after-control', '.claude/settings.json')).toMatchObject({
      exists: true,
      content: '{"copilot_fixture":"tampered"}\n',
    });

    // Restore returned to enforcing hooks
    const enforcing = JSON.parse(entry('after-deny', '.github/hooks/stroq.json').content!);
    const control = JSON.parse(entry('after-control', '.github/hooks/stroq.json').content!);
    const restored = JSON.parse(entry('after-restore', '.github/hooks/stroq.json').content!);
    expect(enforcing.hooks.preToolUse).toHaveLength(1);
    expect(control.hooks.preToolUse).toHaveLength(0);
    expect(restored).toEqual(enforcing);
    // This historical capture restored the same config but dropped its final newline.
    expect(entry('after-restore', '.github/hooks/stroq.json').content + '\n').toBe(
      entry('before-validated', '.github/hooks/stroq.json').content,
    );
  });
});
