import { describe, expect, it } from 'vitest';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { withDeadline } from '../../src/actions/deadline.js';
import {
  CLOCK_SIGNALS,
  LIMIT_SIGNALS,
  isClockSignal,
  isLimitSignal,
} from '../../src/actions/limit-signals.js';
import * as core from '../../src/index.js';

const CWD = '/home/dev/project';

/**
 * The names are the classifier's own. A list that names a signal the classifier does not emit would
 * never match, and a rename on the classifier's side would turn a limit back into an ordinary ask
 * without any test noticing; so each name is produced here by the real classification.
 */
describe('the signals that say how a call was read', () => {
  it('names the signals whose occurrence depends on the clock', () => {
    expect(CLOCK_SIGNALS).toEqual(['reading-took-too-long', 'instruction-scan-took-too-long']);
  });

  it('names the limits that give the same answer for the same input', () => {
    expect(LIMIT_SIGNALS).toEqual([
      'command-too-large',
      'shell-command-unreadable',
      'mcp-args-unreadable',
    ]);
  });

  it('keeps the clock and the limits apart: a limit never depends on the clock', () => {
    for (const signal of CLOCK_SIGNALS) expect(LIMIT_SIGNALS).not.toContain(signal);
  });

  it.each([
    ['reading-took-too-long', true, false],
    ['instruction-scan-took-too-long', true, false],
    ['command-too-large', false, true],
    ['shell-command-unreadable', false, true],
    ['mcp-args-unreadable', false, true],
    ['function-call-not-read', false, false],
    ['secret-path', false, false],
    ['', false, false],
    ['READING-TOOK-TOO-LONG', false, false],
    ['reading-took-too-long ', false, false],
  ])('tells %j apart (clock %s, limit %s)', (signal, clock, limit) => {
    expect(isClockSignal(signal)).toBe(clock);
    expect(isLimitSignal(signal)).toBe(limit);
  });

  it('is exported from the package, so the harness can use the same names', () => {
    expect(core.CLOCK_SIGNALS).toBe(CLOCK_SIGNALS);
    expect(core.LIMIT_SIGNALS).toBe(LIMIT_SIGNALS);
    expect(core.isClockSignal).toBe(isClockSignal);
    expect(core.isLimitSignal).toBe(isLimitSignal);
  });

  describe('as the classifier emits them', () => {
    it('command-too-large: a command too costly to read', () => {
      const out = classifyTool('Bash', { command: 'echo x;'.repeat(100_000) }, CWD);
      expect(out.signals.filter(isLimitSignal)).toEqual(['command-too-large']);
      expect(out.signals.some(isClockSignal)).toBe(false);
    });

    it('shell-command-unreadable: a shell tool with no command to read', () => {
      const out = classifyTool('Bash', { cmd: 'ls' }, CWD);
      expect(out.signals.filter(isLimitSignal)).toEqual(['shell-command-unreadable']);
    });

    it('mcp-args-unreadable: more paths than are read', () => {
      const files = Array.from({ length: 5000 }, (_, i) => `/tmp/f${i}`);
      const out = classifyTool('mcp__fs__write_file', { files, path: 'a.txt' }, CWD);
      expect(out.signals.filter(isLimitSignal)).toEqual(['mcp-args-unreadable']);
    });

    it('reading-took-too-long: the clock stopped the reading', () => {
      const command = Array.from({ length: 200 }, (_, i) => `echo ${i} | cat; ls ${i}`).join('\n');
      const out = withDeadline(
        -1,
        () => classifyTool('Bash', { command }, CWD),
        () => null,
      );
      expect(out?.signals.filter(isClockSignal)).toEqual(['reading-took-too-long']);
      expect(out?.signals.some(isLimitSignal)).toBe(false);
    });
  });
});
