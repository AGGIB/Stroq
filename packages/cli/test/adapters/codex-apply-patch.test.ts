import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleCodexHook } from '../../src/adapters/codex.js';
import { createEngine } from '../../src/engine-factory.js';

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-codex-patch-'));
  process.env['STROQ_HOME'] = home;
  cwd = mkdtempSync(join(tmpdir(), 'stroq-codex-patch-cwd-'));
});

const patch = (...headers: string[]): string =>
  ['*** Begin Patch', ...headers, '*** End Patch'].join('\n');

const event = (fields: Record<string, unknown>): Record<string, unknown> => ({
  session_id: 'codex-1',
  hook_event_name: 'PreToolUse',
  cwd,
  turn_id: 'turn-1',
  tool_use_id: 'call-1',
  model: 'gpt-5-codex',
  permission_mode: 'auto',
  tool_name: 'apply_patch',
  ...fields,
});
const run = (fields: Record<string, unknown>) => handleCodexHook(createEngine(), event(fields));
const reasonOf = (stdout: string) =>
  String(
    (JSON.parse(stdout) as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput[
      'permissionDecisionReason'
    ],
  );

describe('apply_patch', () => {
  it('denies a patch that touches Stroq or Codex security config', async () => {
    for (const path of [
      '.codex/hooks.json',
      '.codex/config.toml',
      '.claude/settings.json',
      '.stroq/policy.yaml',
    ]) {
      const out = await run({ tool_input: { command: patch(`*** Update File: ${path}`) } });
      expect(reasonOf(out.stdout), path).toContain('Stroq blocked this action (deny-self-tamper)');
    }
  });

  it('denies a multi-file patch on its worst path and audits every path', async () => {
    const out = await run({
      tool_input: {
        command: patch(
          '*** Add File: src/new.ts',
          '*** Update File: docs/readme.md',
          '*** Delete File: .codex/hooks.json',
        ),
      },
    });
    expect(reasonOf(out.stdout)).toContain('deny-self-tamper');
    const audit = readFileSync(join(home, 'audit.jsonl'), 'utf8');
    for (const path of ['src/new.ts', 'docs/readme.md', '.codex/hooks.json'])
      expect(audit, path).toContain(path);
    expect(audit).toContain('config.self');
    expect(audit).toContain('"tool":"Write"');
  });

  it('allows an ordinary patch and one whose headers it cannot read', async () => {
    expect(
      await run({
        tool_input: { command: patch('*** Add File: src/app.ts', '+export const a = 1;') },
      }),
    ).toEqual({ stdout: '', exitCode: 0 });
    expect(await run({ tool_input: { command: 'no headers at all' } })).toEqual({
      stdout: '',
      exitCode: 0,
    });
  });

  it('denies a string-shaped tool_input the same way it denies the object-shaped one', async () => {
    // Codex's own `{ command: '...' }` wrapper is sometimes absent; a bare string
    // `tool_input` must still be read as patch text, or the path is silently dropped
    // and deny-self-tamper never fires.
    const out = await run({ tool_input: patch('*** Update File: .codex/hooks.json') });
    expect(reasonOf(out.stdout)).toContain('Stroq blocked this action (deny-self-tamper)');
  });

  it('finds a self-tamper path even in a patch far larger than the old 200 000-char cap', async () => {
    // A character cap applied before scanning would let a patch pad its early lines
    // past the cutoff and hide this header from ever being classified — an allowed
    // write to Codex's own hook file, which is exactly the bypass this guards against.
    const filler = 'x'.repeat(210_000);
    const out = await run({
      tool_input: { command: patch(filler, '*** Update File: .codex/hooks.json') },
    });
    expect(reasonOf(out.stdout)).toContain('Stroq blocked this action (deny-self-tamper)');
  });

  it('denies a patch too large to classify inside the hook timeout, and records it', async () => {
    const headers = Array.from({ length: 65 }, (_, i) => `*** Add File: src/f${i}.ts`);
    const out = await run({ tool_input: { command: patch(...headers) } });
    expect(reasonOf(out.stdout)).toContain('codex-patch-too-large');
    const audit = readFileSync(join(home, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('codex-patch-too-large');
    expect(audit).toContain('apply_patch: 65 files');
  });

  it('allows a patch that declares exactly the maximum number of paths', async () => {
    const headers = Array.from({ length: 64 }, (_, i) => `*** Add File: src/f${i}.ts`);
    const out = await run({ tool_input: { command: patch(...headers) } });
    expect(out).toEqual({ stdout: '', exitCode: 0 });
  });
});
