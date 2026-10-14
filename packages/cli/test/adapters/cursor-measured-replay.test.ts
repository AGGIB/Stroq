import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleCursorHook,
  cursorProjectRoot,
  type CursorHookInput,
} from '../../src/adapters/cursor.js';
import { createEngine } from '../../src/engine-factory.js';

const fixture = fileURLToPath(new URL('../fixtures/hosts/cursor/3.24.18-win32/', import.meta.url));
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
const hooksAt = (label: string) => JSON.parse(entry(label, '.cursor/hooks.json').content!).hooks;

describe('Measured Cursor 3.24.18 Windows contract (offline replay only)', () => {
  let scratch: string | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it('retains measured metadata, wire path forms, BOM observations and reviewed file hashes', () => {
    const manifest = read('manifest.json');
    expect(manifest).toMatchObject({
      kind: 'recorded-host',
      version: '3.24.18',
      os: 'win32',
      recordedDate: '2026-10-14',
    });
    expect(records).toHaveLength(10);
    expect(audits).toHaveLength(14);
    for (const record of records) {
      expect(record.inputHadBom).toBe(true);
      expect(record.stderr).toBe('');
      expect(record.input.cursor_version).toBe(manifest.version);
      expect(record.input.workspace_roots).toEqual(['/C:/stroq-live-fixture/project']);
      expect(cursorProjectRoot(record.input as CursorHookInput, 'win32')).toBe(
        'C:/stroq-live-fixture/project',
      );
      const path = record.input.tool_input?.file_path ?? record.input.file_path;
      expect(path).toMatch(/^C:\\stroq-live-fixture\\project\\/);
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
    // Only relocate the measured Windows paths to this runner's temporary directory.
    // No Cursor process, model request or simulated host enforcement occurs here.
    scratch = mkdtempSync(join(tmpdir(), 'stroq-measured-cursor-'));
    const project = join(scratch, 'project');
    const home = join(scratch, 'stroq-home');
    mkdirSync(join(project, '.claude'), { recursive: true });
    mkdirSync(join(project, 'scratch'));
    mkdirSync(home);
    writeFileSync(
      join(project, '.claude/settings.json'),
      entry('after-deny', '.claude/settings.json').content!,
    );
    vi.stubEnv('STROQ_HOME', home);
    const relocate = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const prefix = 'C:\\stroq-live-fixture\\project';
        if (value.startsWith(prefix))
          return join(project, ...value.slice(prefix.length).split('\\').filter(Boolean));
        return value.replaceAll('/C:/stroq-live-fixture/project', project);
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
      const result = await handleCursorHook(engine, relocate(record.input));
      expect(result).toEqual({ stdout: record.stdout, exitCode: record.exitCode });
    }
    const replayAudit = jsonl(join(home, 'audit.jsonl'));
    expect(replayAudit).toHaveLength(audits.length);
    for (const [index, recorded] of audits.entries()) {
      const keys = ['sessionId', 'phase', 'tool', 'summary', 'classes', 'decision'];
      const expected = Object.fromEntries(
        keys.filter((key) => key in recorded).map((key) => [key, recorded[key]]),
      );
      expect(replayAudit[index]).toMatchObject(relocate(expected) as object);
      for (const key of ['classes', 'decision']) {
        if (!(key in recorded)) expect(replayAudit[index]).not.toHaveProperty(key);
      }
    }
  });

  it('correlates native gate responses with disk outcomes and the successful ungated Write control', () => {
    const pre = records.filter((record) => record.input.hook_event_name === 'preToolUse');
    expect(
      pre.map((record) => [record.input.tool_name, JSON.parse(record.stdout).permission]),
    ).toEqual([
      ['Write', 'allow'],
      ['Delete', 'allow'],
      ['Write', 'deny'],
      ['Delete', 'deny'],
    ]);
    const initialWrite = entry('before-validated', 'scratch/write-me.txt');
    expect(initialWrite.exists).toBe(false);
    expect(entry('before-validated', 'scratch/delete-me.txt').exists).toBe(true);
    expect(entry('after-allow-before-deny', 'scratch/write-me.txt')).toMatchObject({
      exists: true,
      content: pre[0]!.input.tool_input.content,
    });
    expect(entry('after-allow-before-deny', 'scratch/delete-me.txt')).toMatchObject({
      exists: false,
      content: null,
    });
    const protectedBefore = entry('after-allow-before-deny', '.claude/settings.json');
    expect(entry('after-deny', '.claude/settings.json')).toEqual(protectedBefore);
    expect(entry('before-control', '.claude/settings.json')).toEqual(protectedBefore);
    const enforcing = hooksAt('after-deny');
    const control = hooksAt('before-control');
    expect(enforcing.preToolUse).toHaveLength(1);
    expect(enforcing.preToolUse[0]).toMatchObject({
      failClosed: true,
      matcher: '^(Write|Delete)$',
    });
    expect(control).toEqual({ ...enforcing, preToolUse: [] });
    expect(hooksAt('after-control')).toEqual(control);
    expect(entry('after-control', '.claude/settings.json')).toMatchObject({
      exists: true,
      content: '{"cursor_fixture":"control-succeeded"}\n',
    });
    expect(entry('after-restore', '.cursor/hooks.json').content).toBe(
      entry('after-deny', '.cursor/hooks.json').content,
    );
    const controlEdits = records.filter(
      (record) =>
        record.input.hook_event_name === 'afterFileEdit' &&
        record.input.file_path.endsWith('settings.json'),
    );
    expect(controlEdits).toHaveLength(1);
    expect(
      pre.some((record) => record.input.conversation_id === controlEdits[0]!.input.conversation_id),
    ).toBe(false);
    const denyAudits = audits.filter((audit) => audit.decision?.ruleId === 'deny-self-tamper');
    expect(denyAudits).toHaveLength(2);
    expect(denyAudits.map((audit) => audit.sessionId)).toEqual(
      pre.slice(2).map((record) => record.input.conversation_id),
    );
    expect(
      records.filter((record) => record.input.hook_event_name === 'afterFileEdit'),
    ).toHaveLength(2);
    expect(Date.parse(read('after-allow-before-deny.snapshot.json').at)).toBeLessThan(
      Date.parse(pre[2]!.at),
    );
    expect(Date.parse(pre[3]!.at)).toBeLessThan(Date.parse(read('after-deny.snapshot.json').at));
    expect(Date.parse(read('before-control.snapshot.json').at)).toBeLessThan(
      Date.parse(controlEdits[0]!.at),
    );
    expect(Date.parse(controlEdits[0]!.at)).toBeLessThan(
      Date.parse(read('after-control.snapshot.json').at),
    );
  });
});
