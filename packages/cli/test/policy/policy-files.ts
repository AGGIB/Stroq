import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { DEFAULT_POLICY, type Policy } from '@stroq/core';
import { vi } from 'vitest';

/**
 * What the `stroq policy` tests share: a temporary directory per test file, policies written to it,
 * and the command run in this process with its output and exit code captured.
 */

export interface Workspace {
  /** The directory every file of the test is written under. */
  readonly dir: string;
  /** Writes `text` to `name` under `dir` and returns the path. */
  readonly write: (name: string, text: string) => string;
  /** Writes a policy as YAML. */
  readonly writePolicy: (name: string, policy: unknown) => string;
  readonly cleanup: () => void;
}

export function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-policy-test-'));
  const write = (name: string, text: string): string => {
    const file = join(dir, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text, 'utf8');
    return file;
  };
  return {
    dir,
    write,
    writePolicy: (name, policy) => write(name, stringify(policy)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The default policy with the rules of the given ids left out, as a value that can be written. */
export function defaultWithout(...ids: readonly string[]): Policy {
  return { ...DEFAULT_POLICY, rules: DEFAULT_POLICY.rules.filter((r) => !ids.includes(r.id)) };
}

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command that returns an exit code, capturing what it writes to the two streams. */
export async function capture(run: () => Promise<number> | number): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  try {
    const code = await run();
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

/** Any C0 or C1 control other than the tab and the newline, a direction override or isolate. */
export const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
