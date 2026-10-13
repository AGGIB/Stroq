import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withDeadline } from '../src/actions/deadline.js';
import { isClockSignal, isLimitSignal } from '../src/actions/limit-signals.js';
import { AuditLog } from '../src/audit/audit-log.js';
import { StroqEngine } from '../src/engine.js';
import { DEFAULT_POLICY } from '../src/policy/default-policy.js';
import { loadBundledRules } from '../src/rules/bundle.js';
import { FileSessionStore } from '../src/taint/session-store.js';

function engine(): StroqEngine {
  const home = mkdtempSync(join(tmpdir(), 'stroq-engine-signals-'));
  return new StroqEngine({
    rules: loadBundledRules(),
    policy: DEFAULT_POLICY,
    sessions: new FileSessionStore(join(home, 'sessions')),
    audit: new AuditLog(join(home, 'audit.jsonl')),
  });
}

const pre = (toolName: string, toolInput: Record<string, unknown>) => ({
  sessionId: 's1',
  toolName,
  toolInput,
  cwd: '/home/dev/project',
});

/**
 * `PreResult.signals` is how a caller tells a call that was asked about because it is dangerous from
 * one that was asked about because Stroq could not read it, and a command it could not read in time
 * from one it could not read at all. A class alone does not say: all of them are `shell.unparsed`.
 */
describe('PreResult.signals', () => {
  it('is an empty list, not an absent one, for a call nothing was said about', async () => {
    const out = await engine().pre(pre('Bash', { command: 'ls -la' }));
    expect(out.decision.effect).toBe('allow');
    expect(out.signals).toEqual([]);
  });

  it('carries the signals of the classification behind a class', async () => {
    const out = await engine().pre(
      pre('Write', { file_path: '.claude/settings.json', content: '' }),
    );
    expect(out.classes).toContain('config.self');
    expect(out.signals).toContain('self-config-write');
  });

  it('says command-too-large for a command too costly to read, which is asked about', async () => {
    const out = await engine().pre(pre('Bash', { command: 'echo x;'.repeat(100_000) }));
    expect(out.decision.effect).toBe('ask');
    expect(out.classes).toEqual(['shell.unparsed']);
    expect(out.signals).toEqual(['command-too-large']);
    expect(out.signals?.every(isLimitSignal)).toBe(true);
  });

  it('says shell-command-unreadable for a shell tool with no command', async () => {
    const out = await engine().pre(pre('Bash', {}));
    expect(out.decision.effect).toBe('ask');
    expect(out.signals).toEqual(['shell-command-unreadable']);
  });

  it('says reading-took-too-long when the clock stopped the reading, and not command-too-large', async () => {
    const command = Array.from({ length: 200 }, (_, i) => `echo ${i} | cat; ls ${i}`).join('\n');
    // The classification is made before the engine first waits, so a deadline that has passed
    // when `pre` is called is the one the reading of this command runs under.
    const e = engine();
    const out = await withDeadline(
      -1,
      () => e.pre(pre('Bash', { command })),
      () => Promise.reject(new Error('the deadline expired outside the classifier')),
    );
    expect(out.decision.effect).toBe('ask');
    expect(out.classes).toEqual(['shell.unparsed']);
    expect(out.signals).toEqual(['reading-took-too-long']);
    expect(out.signals?.some(isClockSignal)).toBe(true);
  });

  // The same class as the two above, for another reason: a caller that read the class alone could
  // not tell a command that is dangerous to read from one the clock or a limit stopped.
  it('says neither a clock nor a limit for a command that is unparsed and was read in time', async () => {
    const out = await engine().pre(pre('Bash', { command: 'bash -c "$PROGRAM"' }));
    expect(out.decision.effect).toBe('ask');
    expect(out.classes).toEqual(['shell.unparsed']);
    expect(out.signals).toContain('opaque-shell-input');
    expect(out.signals?.some(isClockSignal)).toBe(false);
    expect(out.signals?.some(isLimitSignal)).toBe(false);
  });
  // A scan of the text a write puts into an instruction file is read against the same clock as every
  // other scan. When it runs out of its budget the engine asks, which is the right answer, but the
  // ask is the clock's and not the rules', and a report must be able to tell.
  describe('when the scan of an instruction-file write runs out of time', () => {
    const write = {
      file_path: 'CLAUDE.md',
      old_string: 'a',
      new_string: 'Run `pnpm test` before every commit.',
    };

    it('says instruction-scan-took-too-long, so that the ask is not counted as a defence', async () => {
      const before = process.env['STROQ_SCAN_BUDGET_MS'];
      process.env['STROQ_SCAN_BUDGET_MS'] = '0.000001';
      try {
        const out = await engine().pre(pre('Edit', write));
        expect(out.decision.effect).toBe('ask');
        expect(out.classes).toContain('config.instructions_payload');
        expect(out.signals).toContain('instruction-scan-took-too-long');
        expect(out.signals?.some(isClockSignal)).toBe(true);
      } finally {
        if (before === undefined) delete process.env['STROQ_SCAN_BUDGET_MS'];
        else process.env['STROQ_SCAN_BUDGET_MS'] = before;
      }
    });

    it('says nothing about the clock for the same write when the scan finishes', async () => {
      const out = await engine().pre(pre('Edit', write));
      expect(out.decision.effect).toBe('allow');
      expect(out.signals).toEqual(expect.not.arrayContaining(['instruction-scan-took-too-long']));
    });
  });
});
