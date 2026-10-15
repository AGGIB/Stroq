import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copilotRecorderSource } from '../../../../../scripts/copilot-capture-recorder.js';
import { createThrowawayRoot } from '../../../src/live/throwaway.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function rawCapture() {
  const raw = mkdtempSync(join(tmpdir(), 'stroq-copilot-clean-test-'));
  roots.push(raw);
  const location = { root: '/tmp/copilot-capture', project: '/tmp/copilot-capture/project' };
  writeFileSync(join(raw, 'location.json'), JSON.stringify(location));
  writeFileSync(join(raw, 'version.json'), JSON.stringify({ version: '1.0.98', os: 'darwin' }));
  writeFileSync(
    join(raw, 'hooks.jsonl'),
    JSON.stringify({
      phase: 'pre',
      input: {
        sessionId: 'synthetic-session',
        toolName: 'bash',
        toolArgs: { command: 'echo synthetic' },
      },
      stdout: '',
      exitCode: 0,
    }) + '\n',
  );
  for (const label of ['before', 'after']) {
    writeFileSync(join(raw, `${label}.snapshot.json`), JSON.stringify({ files: [] }));
  }
  const output = join(raw, 'candidate');
  const clean = () =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('scripts/clean-copilot-fixture.ts'), raw, output],
      { encoding: 'utf8', timeout: 15_000 },
    );
  const manifest = () => JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  return { raw, output, clean, manifest };
}

describe('Copilot fixture candidate scripts (synthetic inputs, no host)', () => {
  it('does not certify enforcement or a control from arbitrary records and empty snapshots', () => {
    const f = rawCapture();
    const result = f.clean();
    expect(result.status, result.stderr).toBe(0);
    expect(f.manifest()).toMatchObject({
      kind: 'unreviewed-host-candidate',
      scope: {
        observedPreToolNames: ['bash'],
        observedPostToolNames: [],
        enforcement: 'unverified',
        control: 'unverified',
      },
    });
    expect(f.manifest().stroqBuild.cliSha256).toBeUndefined();
    expect(f.manifest().stroqBuild.packageVersion).toBeUndefined();
    expect(f.manifest().recordedDate).toBeUndefined();
  });

  it('preserves capture-time build metadata and dates instead of inventing current ones', () => {
    const f = rawCapture();
    const build = { packageVersion: '0.1.2', cliSha256: 'a'.repeat(64) };
    const date = '2001-02-03T04:05:06.000Z';
    writeFileSync(
      join(f.raw, 'version.json'),
      JSON.stringify({ version: '1.0.98', os: 'darwin', preparedAt: date, stroqBuild: build }),
    );
    writeFileSync(
      join(f.raw, 'hooks.jsonl'),
      JSON.stringify({ phase: 'pre', at: date, input: { toolName: 'apply_patch' }, stdout: '' }) +
        '\n',
    );
    const result = f.clean();
    expect(result.status, result.stderr).toBe(0);
    expect(f.manifest()).toMatchObject({
      capturePreparedAt: date,
      observedDates: ['2001-02-03'],
      stroqBuild: build,
    });
    expect(f.manifest().scope.observedPreToolNames).toEqual(['apply_patch']);
    expect(f.manifest().scope.control).toBe('unverified');
  });

  it('keeps hook and audit session attribution correlated after anonymization', () => {
    const f = rawCapture();
    writeFileSync(
      join(f.raw, 'audit.jsonl'),
      JSON.stringify({ sessionId: 'synthetic-session', phase: 'pre' }) + '\n',
    );
    const result = f.clean();
    expect(result.status, result.stderr).toBe(0);
    const hooks = JSON.parse(readFileSync(join(f.output, 'hooks.jsonl'), 'utf8'));
    const audit = JSON.parse(readFileSync(join(f.output, 'audit.jsonl'), 'utf8'));
    expect(hooks.input.sessionId).toMatch(/^copilot-fixture-id-\d{4}$/);
    expect(audit.sessionId).toBe(hooks.input.sessionId);
  });

  it('refuses missing hook records before writing candidate output', () => {
    const f = rawCapture();
    writeFileSync(join(f.raw, 'hooks.jsonl'), '');
    expect(f.clean().status).not.toBe(0);
    expect(existsSync(f.output)).toBe(false);
  });

  it('refuses credential fields encoded inside captured file bodies', () => {
    const f = rawCapture();
    writeFileSync(
      join(f.raw, 'hooks.jsonl'),
      JSON.stringify({ input: { toolArgs: '{"\\u0061pi_key":"TEST_ONLY_VALUE"}' } }) + '\n',
    );
    const result = f.clean();
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('TEST_ONLY_VALUE');
    expect(existsSync(f.output)).toBe(false);
  });

  it('does not copy audit content from a different directory named by capture metadata', () => {
    const f = rawCapture();
    const made = createThrowawayRoot('stroq-copilot-clean-project-');
    roots.push(made.root);
    const outside = join(f.raw, 'outside-audit');
    mkdirSync(outside);
    writeFileSync(join(outside, 'audit.jsonl'), '{"synthetic":"outside"}\n');
    writeFileSync(join(f.raw, 'location.json'), JSON.stringify({ ...made, stroqHome: outside }));
    expect(f.clean().status).not.toBe(0);
    expect(existsSync(join(f.raw, 'audit.jsonl'))).toBe(false);
    expect(existsSync(f.output)).toBe(false);
  });

  it('checks metadata for possible credentials before including it in a candidate manifest', () => {
    const f = rawCapture();
    const possibleCredential = 'sk-proj-' + 'A'.repeat(32);
    writeFileSync(
      join(f.raw, 'version.json'),
      JSON.stringify({
        version: `1.0.98-${possibleCredential}`,
        os: 'darwin',
      }),
    );
    const result = f.clean();
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain(possibleCredential);
    expect(existsSync(f.output)).toBe(false);
  });

  it.each([false, true])('preserves recorder stdin and response bytes (BOM %s)', (bom) => {
    const f = rawCapture();
    const cli = join(f.raw, 'synthetic-cli.mjs');
    const log = join(f.raw, 'recorded.jsonl');
    const recorder = join(f.raw, 'record-hook.mjs');
    const response = '{"permissionDecision":"deny","permissionDecisionReason":"synthetic"}';
    writeFileSync(cli, `process.stdout.write(${JSON.stringify(response)});`);
    writeFileSync(
      recorder,
      copilotRecorderSource({ node: process.execPath, cli, log, home: f.raw, stroqHome: f.raw }),
    );
    const input = { sessionId: 'synthetic-session', toolName: 'bash' };
    const result = spawnSync(process.execPath, [recorder, 'pre'], {
      input: (bom ? '\uFEFF' : '') + JSON.stringify(input),
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(response);
    expect(JSON.parse(readFileSync(log, 'utf8'))).toMatchObject({
      input,
      inputHadBom: bom,
      stdout: response,
      exitCode: 0,
    });
  });

  it('never turns a failed child spawn into a recorded successful allow', () => {
    const f = rawCapture();
    const log = join(f.raw, 'recorded.jsonl');
    const recorder = join(f.raw, 'record-hook.mjs');
    writeFileSync(
      recorder,
      copilotRecorderSource({
        node: join(f.raw, 'missing-node'),
        cli: join(f.raw, 'missing-cli'),
        log,
        home: f.raw,
        stroqHome: f.raw,
      }),
    );
    const result = spawnSync(process.execPath, [recorder, 'pre'], {
      input: '{}',
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.status).not.toBe(0);
    const record = JSON.parse(readFileSync(log, 'utf8'));
    expect(record.exitCode).not.toBe(0);
    expect(record.error).toBeTruthy();
  });
});
