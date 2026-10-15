import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleOpenClawHook, type OpenClawPhase } from '../../src/adapters/openclaw.js';
import { createEngine } from '../../src/engine-factory.js';

const fixture = fileURLToPath(
  new URL('../fixtures/hosts/openclaw/2026.10.3-darwin-arm64/', import.meta.url),
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
  const file = snapshot(label).find((file) => file.path === path);
  if (!file) throw new Error(`missing ${label}/${path}`);
  return file;
};

describe('Measured OpenClaw 2026.10.3 macOS contract (offline replay only)', () => {
  let scratch: string | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it('retains measured metadata, wire event forms, and reviewed file hashes', () => {
    const manifest = read('manifest.json');
    expect(manifest).toMatchObject({
      host: 'openclaw',
      kind: 'recorded-host',
      version: '2026.10.3',
      os: 'darwin',
      recordedDate: '2026-10-15',
    });
    expect(records).toHaveLength(10);
    expect(audits).toHaveLength(8);
    for (const record of records) {
      expect(record.inputHadBom).toBe(false);
      expect(record.stderr).toBe('');
      expect(record.input.cwd).toBe('/tmp/stroq-live-fixture/project');
      expect(['pre', 'post']).toContain(record.phase);
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
    // Only relocate the measured POSIX paths to this runner's temporary directory.
    // No OpenClaw gateway, model request or simulated host enforcement occurs here.
    scratch = mkdtempSync(join(tmpdir(), 'stroq-measured-openclaw-'));
    const project = join(scratch, 'project');
    const home = join(scratch, 'stroq-home');
    mkdirSync(join(project, '.claude'), { recursive: true });
    mkdirSync(join(project, 'scratch'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(project, '.claude/settings.json'),
      entry('before-validated', '.claude/settings.json').content!,
    );
    writeFileSync(join(project, 'sample.txt'), entry('before-validated', 'sample.txt').content!);
    vi.stubEnv('STROQ_HOME', home);

    const relocate = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const prefix = '/tmp/stroq-live-fixture/project';
        if (value.startsWith(prefix)) {
          return join(project, ...value.slice(prefix.length).split('/').filter(Boolean));
        }
        return value.replaceAll(prefix, project);
      }
      if (Array.isArray(value)) return value.map(relocate);
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, each]) => [key, relocate(each)]),
        );
      return value;
    };

    const engine = createEngine();
    for (const record of records) {
      const result = await handleOpenClawHook(
        engine,
        record.phase as OpenClawPhase,
        relocate(record.input),
      );
      expect(result).toEqual({ stdout: record.stdout, exitCode: record.exitCode });
    }

    const replayAudit = jsonl(join(home, 'audit.jsonl'));
    expect(replayAudit).toHaveLength(audits.length);
    for (const [index, recorded] of audits.entries()) {
      const keys = ['sessionId', 'phase', 'tool', 'summary', 'classes', 'decision', 'scan'];
      const expected = Object.fromEntries(
        keys.filter((key) => key in recorded).map((key) => [key, recorded[key]]),
      );
      expect(replayAudit[index]).toMatchObject(relocate(expected) as object);
      for (const key of ['classes', 'decision', 'scan']) {
        if (!(key in recorded)) expect(replayAudit[index]).not.toHaveProperty(key);
      }
    }
  });

  it('correlates native gate responses with disk outcomes and the successful ungated control', () => {
    const pre = records.filter((record) => record.phase === 'pre');
    expect(
      pre.map((record) => [record.input.toolName, JSON.parse(record.stdout).decision]),
    ).toEqual([
      ['exec', 'allow'],
      ['write', 'allow'],
      ['read', 'allow'],
      ['write', 'deny'],
      ['delete', 'allow'],
    ]);

    const initialWrite = entry('before-validated', 'scratch/write-me.txt');
    expect(initialWrite.exists).toBe(false);
    expect(entry('before-validated', 'scratch/delete-me.txt').exists).toBe(true);

    expect(entry('after-allow-write', 'scratch/write-me.txt')).toMatchObject({
      exists: true,
      content: pre[1]!.input.params.content,
    });
    expect(entry('after-allow-delete', 'scratch/delete-me.txt')).toMatchObject({
      exists: false,
      content: null,
    });

    const protectedBefore = entry('before-validated', '.claude/settings.json');
    expect(entry('after-deny', '.claude/settings.json')).toEqual(protectedBefore);
    expect(entry('before-control', '.claude/settings.json')).toEqual(protectedBefore);
    expect(entry('after-control', '.claude/settings.json')).toMatchObject({
      exists: true,
      content: '{"openclaw_fixture":"tampered"}\n',
    });
    expect(entry('after-restore', '.claude/settings.json')).toEqual(protectedBefore);

    const denyAudits = audits.filter((audit) => audit.decision?.ruleId === 'deny-self-tamper');
    expect(denyAudits).toHaveLength(1);
    expect(denyAudits[0]!.sessionId).toBe(pre[3]!.input.sessionId);

    // Verify ordering of timestamps between snapshots and tool events
    expect(Date.parse(read('before-validated.snapshot.json').at)).toBeLessThan(
      Date.parse(pre[0]!.at),
    );
    expect(Date.parse(pre[0]!.at)).toBeLessThan(Date.parse(records[1]!.at));
    expect(Date.parse(read('before-control.snapshot.json').at)).toBeLessThan(
      Date.parse(records[9]!.at),
    );
    expect(Date.parse(records[9]!.at)).toBeLessThan(
      Date.parse(read('after-control.snapshot.json').at),
    );
  });
});
