import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInspect } from '../../src/commands/inspect.js';

/**
 * Exit 1 means findings. A CI recipe such as `stroq inspect ... || [ $? -eq 1 ]` lets findings
 * through to the report, so a check that stops on an error must never exit 1 as well: it would
 * read as a report that was written, when none was.
 */
vi.mock('../../src/exposure/agent-surface.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/exposure/agent-surface.js')>();
  return {
    ...actual,
    agentSurface: () => {
      throw new RangeError('Maximum call stack size exceeded');
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function inspect(...argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => out.push(String(chunk)) > 0) as typeof stdout;
  process.stderr.write = ((chunk: string) => err.push(String(chunk)) > 0) as typeof stderr;
  try {
    return { code: runInspect(argv), out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

describe('stroq inspect when the check stops on an error', () => {
  it('exits 3 and says the check did not finish, never 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-inspect-crash-'));
    dirs.push(dir);
    const run = inspect(dir);
    expect(run.code).toBe(3);
    expect(run.out).toBe('');
    expect(run.err).toContain('the check stopped before it finished');
    expect(run.err).toContain('Maximum call stack size exceeded');
  });
});
