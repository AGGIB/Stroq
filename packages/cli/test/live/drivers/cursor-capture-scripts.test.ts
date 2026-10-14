import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cursorRecorderSource } from '../../../../../scripts/cursor-capture-recorder.js';
import { createThrowawayRoot } from '../../../src/live/throwaway.js';

function rawCapture() {
  const root = mkdtempSync(join(tmpdir(), 'stroq-cursor-clean-test-'));
  writeFileSync(
    join(root, 'location.json'),
    JSON.stringify({ project: '/Users/alice/capture/project', root: '/Users/alice/capture' }),
  );
  writeFileSync(join(root, 'version.json'), JSON.stringify({ version: '1.2.3', os: 'darwin' }));
  writeFileSync(
    join(root, 'hooks.jsonl'),
    JSON.stringify({ input: { file_path: '/Users/alice/capture/project/scratch/write-me.txt' } }) +
      '\n',
  );
  for (const step of ['before', 'after'])
    writeFileSync(join(root, `${step}.snapshot.json`), JSON.stringify({ files: [] }));
  const output = join(root, 'candidate');
  const clean = () =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('scripts/clean-cursor-fixture.ts'), root, output],
      { encoding: 'utf8', timeout: 15_000 },
    );
  return { root, output, clean };
}

describe('Cursor candidate capture scripts (synthetic test inputs)', () => {
  it('disables only the private editor gate for control and restores exact bytes', () => {
    const f = rawCapture();
    const made = createThrowawayRoot('stroq-cursor-control-test-');
    writeFileSync(join(f.root, 'location.json'), JSON.stringify(made));
    mkdirSync(join(made.project, '.cursor'));
    const file = join(made.project, '.cursor', 'hooks.json');
    const original = JSON.stringify({
      version: 1,
      hooks: {
        preToolUse: [
          { command: `${process.execPath} ${join(f.root, 'record-hook.mjs')}`, failClosed: true },
        ],
        afterFileEdit: [{ command: 'observation' }],
      },
    });
    writeFileSync(file, original);
    const run = (action: string) =>
      spawnSync(
        process.execPath,
        ['--import', 'tsx', resolve('scripts/capture-cursor-fixture.ts'), action, f.root],
        { encoding: 'utf8' },
      );
    const control = run('control');
    expect(control.status, control.stderr).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks).toEqual({
      preToolUse: [],
      afterFileEdit: [{ command: 'observation' }],
    });
    const restored = run('restore');
    expect(restored.status, restored.stderr).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
    const repeated = run('control');
    expect(repeated.status).not.toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readFileSync(join(f.root, 'enforcing-hooks.json'), 'utf8')).toBe(original);
  });

  it('refuses to disable hooks outside a marked throwaway project', () => {
    const f = rawCapture();
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('scripts/capture-cursor-fixture.ts'), 'control', f.root],
      { encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(join(f.root, 'enforcing-hooks.json'))).toBe(false);
  });

  it.each([false, true])('runs generated recorder with synthetic stdin (BOM %s)', (bom) => {
    const root = mkdtempSync(join(tmpdir(), 'stroq-cursor-recorder-test-'));
    const cli = join(root, 'synthetic-cli.mjs');
    const log = join(root, 'records.jsonl');
    const recorder = join(root, 'recorder.mjs');
    writeFileSync(cli, `process.stdout.write(JSON.stringify({permission:'allow'}));`);
    writeFileSync(
      recorder,
      cursorRecorderSource({ node: process.execPath, cli, log, home: root, stroqHome: root }),
    );
    expect(spawnSync(process.execPath, ['--check', recorder], { encoding: 'utf8' }).status).toBe(0);
    const input = { hook_event_name: 'preToolUse', tool_name: 'Write', synthetic: true };
    const result = spawnSync(process.execPath, [recorder], {
      input: (bom ? '\uFEFF' : '') + JSON.stringify(input),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ permission: 'allow' });
    const record = JSON.parse(readFileSync(log, 'utf8').trim());
    expect(record.input).toEqual(input);
    expect(record.inputHadBom).toBe(bom);
    expect(record.stdout).toBe(result.stdout);
    expect(record.exitCode).toBe(0);
  });

  it('never promotes cleaned observations to a measured contract', () => {
    const f = rawCapture();
    expect(f.clean().status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(f.output, 'manifest.json'), 'utf8'));
    expect(manifest.kind).toBe('unverified-host-capture');
    expect(manifest.provenance).toContain('verification remain required');
    expect(readFileSync(join(f.output, 'hooks.jsonl'), 'utf8')).toContain(
      '/tmp/stroq-live-fixture/project/scratch/write-me.txt',
    );
  });
  it('refuses missing host records without inventing events', () => {
    const f = rawCapture();
    writeFileSync(join(f.root, 'hooks.jsonl'), '');
    expect(f.clean().status).not.toBe(0);
    expect(existsSync(f.output)).toBe(false);
  });
  it('preserves session correlation across hook and optional audit files', () => {
    const f = rawCapture();
    writeFileSync(
      join(f.root, 'hooks.jsonl'),
      [
        { input: { conversation_id: 'first-session', generation_id: 'first-generation' } },
        { input: { conversation_id: 'second-session', generation_id: 'second-generation' } },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
    );
    writeFileSync(
      join(f.root, 'audit.jsonl'),
      [
        { sessionId: 'first-session', phase: 'pre' },
        { sessionId: 'second-session', phase: 'pre' },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
    );
    const result = f.clean();
    expect(result.status, result.stderr).toBe(0);
    const hooks = readFileSync(join(f.output, 'hooks.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const audit = readFileSync(join(f.output, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(audit.map((r) => r.sessionId)).toEqual(hooks.map((r) => r.input.conversation_id));
  });
  it('sanitizes recorded Windows URI roots, native paths and email identities', () => {
    const f = rawCapture();
    writeFileSync(
      join(f.root, 'location.json'),
      JSON.stringify({
        project: 'C:\\Users\\alice\\AppData\\Local\\Temp\\capture\\project',
        root: 'C:\\Users\\alice\\AppData\\Local\\Temp\\capture',
      }),
    );
    writeFileSync(
      join(f.root, 'version.json'),
      JSON.stringify({ version: '3.24.18', os: 'win32' }),
    );
    writeFileSync(
      join(f.root, 'hooks.jsonl'),
      JSON.stringify({
        input: {
          workspace_roots: ['/C:/Users/alice/AppData/Local/Temp/capture/project'],
          tool_input: {
            file_path:
              'C:\\Users\\alice\\AppData\\Local\\Temp\\capture\\project\\scratch\\write-me.txt',
          },
          user_email: 'alice@example.com',
        },
      }) + '\n',
    );
    const result = f.clean();
    expect(result.status, result.stderr).toBe(0);
    const text = readFileSync(join(f.output, 'hooks.jsonl'), 'utf8');
    expect(text).not.toContain('alice');
    expect(text).not.toContain('AppData');
    expect(text).toContain('fixture-user@example.invalid');
    expect(JSON.parse(text).input.workspace_roots).toEqual(['/C:/stroq-live-fixture/project']);
    expect(JSON.parse(text).input.tool_input.file_path).toBe(
      'C:\\stroq-live-fixture\\project\\scratch\\write-me.txt',
    );
  });
  it('refuses missing version metadata instead of inserting defaults', () => {
    const f = rawCapture();
    writeFileSync(join(f.root, 'version.json'), '{}');
    expect(f.clean().status).not.toBe(0);
    expect(existsSync(f.output)).toBe(false);
  });
  it('rejects credentials before writing any candidate bytes', () => {
    const f = rawCapture();
    writeFileSync(
      join(f.root, 'after.snapshot.json'),
      JSON.stringify({ content: 'ghp_' + 'a'.repeat(36) }),
    );
    const result = f.clean();
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('a'.repeat(36));
    expect(existsSync(f.output)).toBe(false);
  });
  it.each(['snapshot', 'hook', 'audit'])(
    'rejects credentials in decoded %s file content before writing candidate bytes',
    (kind) => {
      const f = rawCapture();
      const secret = 'synthetic-private-value';
      const content = JSON.stringify({ password: secret });
      const file =
        kind === 'snapshot'
          ? 'after.snapshot.json'
          : kind === 'hook'
            ? 'hooks.jsonl'
            : 'audit.jsonl';
      const record =
        kind === 'hook' ? { input: { tool_input: { content } } } : { files: [{ content }] };
      writeFileSync(join(f.root, file), JSON.stringify(record) + '\n');

      const result = f.clean();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('possible credentials');
      expect(result.stderr).not.toContain(secret);
      expect(existsSync(f.output)).toBe(false);
    },
  );
  it('rejects credential keys escaped inside nested JSON content', () => {
    const f = rawCapture();
    const content = '{"p\\u0061ssword":"synthetic-private-value"}';
    writeFileSync(
      join(f.root, 'after.snapshot.json'),
      JSON.stringify({ content: JSON.stringify({ content }) }),
    );
    const result = f.clean();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('possible credentials');
    expect(result.stderr).not.toContain('synthetic-private-value');
    expect(existsSync(f.output)).toBe(false);
  });
  it('relocates Windows paths inside a captured hooks.json without changing path forms', () => {
    const f = rawCapture();
    const root = 'C:\\Users\\alice\\AppData\\Local\\Temp\\stroq-cursor-capture-ABC123';
    const project = root + '\\project';
    writeFileSync(join(f.root, 'location.json'), JSON.stringify({ root, project }));
    writeFileSync(
      join(f.root, 'version.json'),
      JSON.stringify({ version: '3.24.18', os: 'win32' }),
    );
    const original = {
      hooks: { preToolUse: [{ command: `node "${root}\\record-hook.mjs"` }] },
    };
    writeFileSync(
      join(f.root, 'after.snapshot.json'),
      JSON.stringify({
        files: [{ path: project + '\\.cursor\\hooks.json', content: JSON.stringify(original) }],
      }),
    );
    const result = f.clean();
    expect(result.status, result.stderr).toBe(0);
    const snapshot = JSON.parse(readFileSync(join(f.output, 'after.snapshot.json'), 'utf8'));
    expect(snapshot.files[0].path).toBe('C:\\stroq-live-fixture\\project\\.cursor\\hooks.json');
    expect(JSON.parse(snapshot.files[0].content).hooks.preToolUse[0].command).toBe(
      'node "C:\\stroq-live-fixture\\record-hook.mjs"',
    );
  });
  it('fails closed when the requested Cursor executable is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'stroq-cursor-prepare-test-'));
    const output = join(root, 'raw');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('scripts/capture-cursor-fixture.ts'),
        'prepare',
        output,
        'stroq-missing-cursor',
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });
});
