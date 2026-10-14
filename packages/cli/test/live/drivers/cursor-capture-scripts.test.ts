import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
