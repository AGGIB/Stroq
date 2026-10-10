import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDiagnosticResult, readHostResult, writeHostResult } from '../../src/live/store.js';
import { liveDirIn, liveLastFileIn, liveResultFileIn, liveStandInFileIn } from '../../src/paths.js';
import { inChild } from './child.js';
import { resultOf, validResult } from './helpers.js';

/**
 * `stroq doctor` reads this file on every run and must never be taken down by it: a bad file reads as
 * "no result" and says what is wrong, whoever made it bad. The file is under `~/.stroq`, which the
 * guard keeps an agent out of, but the check is the same for a file that a crash, an older Stroq or a
 * hand edit left behind.
 */
let home: string;
const SOURCE = fileURLToPath(new URL('../../src/live/store.ts', import.meta.url));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-live-store-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const fileOf = (agent = 'claude-code'): string => liveResultFileIn(home, agent);
const plant = (text: string, agent = 'claude-code'): void => {
  mkdirSync(liveDirIn(home), { recursive: true });
  writeFileSync(fileOf(agent), text);
};

describe('writing and reading a result', () => {
  it('reads back what was written', () => {
    writeHostResult(home, validResult());
    expect(readHostResult(home, 'claude-code')).toEqual({ result: validResult(), problem: null });
  });

  it('keeps one file for each agent, in the live directory of the home', () => {
    writeHostResult(home, validResult());
    writeHostResult(home, validResult({ agent: 'codex', state: 'failed' }));
    expect(readFileSync(fileOf('claude-code'), 'utf8')).toContain('"claude-code"');
    expect(readHostResult(home, 'codex').result?.state).toBe('failed');
    expect(readHostResult(home, 'claude-code').result?.state).toBe('verified');
  });

  it('writes plain JSON that ends in a newline', () => {
    writeHostResult(home, validResult());
    const text = readFileSync(fileOf(), 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ version: 1, agent: 'claude-code' });
  });

  it('replaces the result of an agent with the next one', () => {
    writeHostResult(home, validResult());
    writeHostResult(home, validResult({ state: 'failed', at: '2026-10-11T00:00:00.000Z' }));
    expect(readHostResult(home, 'claude-code').result).toMatchObject({
      state: 'failed',
      at: '2026-10-11T00:00:00.000Z',
    });
  });

  it.skipIf(process.platform === 'win32')('keeps the file and the directory to their owner', () => {
    writeHostResult(home, validResult());
    expect(statSync(fileOf()).mode & 0o777).toBe(0o600);
    expect(statSync(liveDirIn(home)).mode & 0o777).toBe(0o700);
  });

  it('leaves nothing but the result in the directory', () => {
    writeHostResult(home, validResult());
    writeHostResult(home, validResult());
    expect(readdirSync(liveDirIn(home))).toEqual(['claude-code.json']);
  });

  it('will not write a result that does not fit the format, and keeps the one that was there', () => {
    writeHostResult(home, validResult());
    const before = readFileSync(fileOf(), 'utf8');
    expect(() =>
      writeHostResult(home, { ...validResult(), state: 'observed' as 'verified' }),
    ).toThrow(/does not match/);
    expect(readFileSync(fileOf(), 'utf8')).toBe(before);
  });

  it.each(['../claude-code', 'a/b', 'Claude', '', 'a'.repeat(40), 'x.json'])(
    'will not write for an agent called %j, which is not an agent name',
    (agent) => {
      expect(() => writeHostResult(home, validResult({ agent }))).toThrow();
    },
  );
});

// What the doctor shows for a host is the last live check that could say something. A later one that
// could not (the limit was hit, the model refused) must not wipe out a failure or a verification, and
// the answers of a stand-in are about the stand-in and are never mistaken for the host's.
describe('which result is kept', () => {
  const later = '2026-10-11T00:00:00.000Z';
  const stored = (): string | undefined => readHostResult(home, 'claude-code').result?.state;

  it('names the file a result went to', () => {
    expect(writeHostResult(home, resultOf('verified'))).toBe('live');
    expect(writeHostResult(home, resultOf('failed'))).toBe('live');
    expect(writeHostResult(home, resultOf('inconclusive'))).toBe('last');
    expect(writeHostResult(home, resultOf('not-attempted'))).toBe('last');
    expect(writeHostResult(home, resultOf('verified', { mode: 'stand-in' }))).toBe('stand-in');
  });

  it.each(['inconclusive', 'not-attempted'] as const)(
    'keeps a failed result when a later live check is %s, and keeps that one for diagnosis',
    (state) => {
      writeHostResult(home, resultOf('failed'));
      writeHostResult(home, resultOf(state, { at: later }));
      expect(stored()).toBe('failed');
      expect(readDiagnosticResult(home, 'claude-code', 'last').result).toMatchObject({
        state,
        at: later,
      });
    },
  );

  it.each(['inconclusive', 'not-attempted'] as const)(
    'keeps a verified result when a later live check is %s',
    (state) => {
      writeHostResult(home, resultOf('verified'));
      writeHostResult(home, resultOf(state, { at: later }));
      expect(stored()).toBe('verified');
      expect(readHostResult(home, 'claude-code').result?.at).toBe('2026-10-10T01:02:03.456Z');
    },
  );

  it('does not store a check that could not tell as the result, even when there is none yet', () => {
    writeHostResult(home, resultOf('inconclusive'));
    expect(readHostResult(home, 'claude-code')).toEqual({ result: null, problem: null });
    expect(readDiagnosticResult(home, 'claude-code', 'last').result?.state).toBe('inconclusive');
  });

  it('replaces a verified result with a failed one', () => {
    writeHostResult(home, resultOf('verified'));
    writeHostResult(home, resultOf('failed', { at: later }));
    expect(readHostResult(home, 'claude-code').result).toMatchObject({
      state: 'failed',
      at: later,
    });
  });

  it('replaces a failed result with a verified one', () => {
    writeHostResult(home, resultOf('failed'));
    writeHostResult(home, resultOf('verified', { at: later }));
    expect(readHostResult(home, 'claude-code').result).toMatchObject({
      state: 'verified',
      at: later,
    });
  });

  it('replaces a verified result with a later verified one', () => {
    writeHostResult(home, resultOf('verified'));
    writeHostResult(home, resultOf('verified', { at: later, hostVersion: '2.2.0' }));
    expect(readHostResult(home, 'claude-code').result).toMatchObject({
      at: later,
      hostVersion: '2.2.0',
    });
  });

  it('does not touch the live file with the answers of a stand-in, whatever they say', () => {
    writeHostResult(home, resultOf('failed'));
    const before = readFileSync(fileOf(), 'utf8');
    for (const state of ['verified', 'failed', 'inconclusive', 'not-attempted'] as const)
      expect(writeHostResult(home, resultOf(state, { mode: 'stand-in', at: later }))).toBe(
        'stand-in',
      );
    expect(readFileSync(fileOf(), 'utf8')).toBe(before);
    expect(readFileSync(liveStandInFileIn(home, 'claude-code'), 'utf8')).toContain('stand-in');
  });

  it('shows a stand-in nowhere that the live result is read from', () => {
    writeHostResult(home, resultOf('verified', { mode: 'stand-in' }));
    expect(readHostResult(home, 'claude-code')).toEqual({ result: null, problem: null });
    expect(existsSync(fileOf())).toBe(false);
    expect(readDiagnosticResult(home, 'claude-code', 'stand-in').result?.mode).toBe('stand-in');
  });

  it('keeps the files of different agents apart', () => {
    writeHostResult(home, resultOf('failed', { agent: 'codex' }));
    writeHostResult(home, resultOf('inconclusive', { agent: 'claude-code' }));
    expect(readHostResult(home, 'codex').result?.state).toBe('failed');
    expect(readHostResult(home, 'claude-code').result).toBeNull();
    expect(readdirSync(liveDirIn(home)).sort()).toEqual(['claude-code.last.json', 'codex.json']);
  });

  it('writes the three files to their owner alone', () => {
    if (process.platform === 'win32') return;
    writeHostResult(home, resultOf('verified'));
    writeHostResult(home, resultOf('inconclusive'));
    writeHostResult(home, resultOf('verified', { mode: 'stand-in' }));
    for (const file of [
      liveResultFileIn(home, 'claude-code'),
      liveLastFileIn(home, 'claude-code'),
      liveStandInFileIn(home, 'claude-code'),
    ])
      expect(statSync(file).mode & 0o777, file).toBe(0o600);
  });

  it('reads a diagnostic file as strictly as the result: a bad one is no result', () => {
    mkdirSync(liveDirIn(home), { recursive: true });
    writeFileSync(liveLastFileIn(home, 'claude-code'), '{"version":1,');
    expect(readDiagnosticResult(home, 'claude-code', 'last')).toEqual({
      result: null,
      problem: 'not JSON',
    });
    expect(readDiagnosticResult(home, '../x', 'last')).toEqual({
      result: null,
      problem: 'not an agent name',
    });
  });

  it('will not store a result whose state does not follow from its probes', () => {
    expect(() => writeHostResult(home, { ...resultOf('failed'), state: 'verified' })).toThrow(
      /state-inconsistent/,
    );
    expect(existsSync(fileOf())).toBe(false);
  });
});

describe('reading what is not a result', () => {
  it('says nothing is wrong when there is nothing', () => {
    expect(readHostResult(home, 'claude-code')).toEqual({ result: null, problem: null });
    mkdirSync(liveDirIn(home), { recursive: true });
    expect(readHostResult(home, 'claude-code')).toEqual({ result: null, problem: null });
  });

  it('says nothing is wrong when the home itself is not there', () => {
    expect(readHostResult(join(home, 'no', 'such', 'home'), 'codex')).toEqual({
      result: null,
      problem: null,
    });
  });

  it.each([
    ['not JSON', '{"version":1,'],
    ['empty', ''],
    ['a byte order mark and then JSON', `﻿${JSON.stringify(validResult())}`],
    ['text after the JSON', `${JSON.stringify(validResult())} and more`],
    ['half of a result', JSON.stringify(validResult()).slice(0, 80)],
    ['a list', '[]'],
    ['null', 'null'],
    ['the wrong version', JSON.stringify({ ...validResult(), version: 2 })],
    ['a state nobody can store', JSON.stringify({ ...validResult(), state: 'observed' })],
    ['an extra key', JSON.stringify({ ...validResult(), extra: true })],
    ['a bad probe', JSON.stringify({ ...validResult(), probes: [{ id: 'x' }] })],
  ])('reads %s as no result, and says so', (_name, text) => {
    plant(text);
    const read = readHostResult(home, 'claude-code');
    expect(read.result).toBeNull();
    expect(read.problem).toEqual(expect.any(String));
    expect(read.problem).toMatch(/^[\x20-\x7e]+$/);
  });

  it("reads a result that is another agent's as no result: a file moved into place proves nothing", () => {
    plant(JSON.stringify(validResult({ agent: 'codex' })));
    const read = readHostResult(home, 'claude-code');
    expect(read.result).toBeNull();
    expect(read.problem).toMatch(/another agent/);
  });

  it('reads a file of more than 64 KiB as no result, without reading it', () => {
    plant(`${JSON.stringify(validResult())}${' '.repeat(70_000)}`);
    expect(readHostResult(home, 'claude-code')).toEqual({
      result: null,
      problem: 'larger than 64 KiB',
    });
  });

  it('reads a directory in the place of the file as no result', () => {
    mkdirSync(fileOf(), { recursive: true });
    expect(readHostResult(home, 'claude-code')).toEqual({
      result: null,
      problem: 'not a regular file',
    });
  });

  it('names the field that is wrong and nothing the file said', () => {
    plant(JSON.stringify({ ...validResult(), policySha256: 'EVIL \u001b[2J' }));
    const read = readHostResult(home, 'claude-code');
    expect(read.problem).toContain('policySha256');
    expect(read.problem).not.toContain('EVIL');
  });

  it.skipIf(process.platform === 'win32')(
    'reads a link as no result, even to a good result',
    () => {
      mkdirSync(liveDirIn(home), { recursive: true });
      const real = join(home, 'elsewhere.json');
      writeFileSync(real, JSON.stringify(validResult()));
      symlinkSync(real, fileOf());
      expect(readHostResult(home, 'claude-code')).toEqual({
        result: null,
        problem: 'not a regular file',
      });
    },
  );

  it.skipIf(process.platform === 'win32')('reads a link to a device as no result', () => {
    mkdirSync(liveDirIn(home), { recursive: true });
    symlinkSync('/dev/zero', fileOf());
    expect(readHostResult(home, 'claude-code').result).toBeNull();
  });

  // In a child, so that a read that waits for a writer is a failure with a time limit.
  it.skipIf(process.platform === 'win32')(
    'does not wait for a FIFO in the place of the file',
    () => {
      mkdirSync(liveDirIn(home), { recursive: true });
      execFileSync('mkfifo', [fileOf()]);
      expect(inChild(SOURCE, 'readHostResult', [home, 'claude-code'])).toEqual({
        result: null,
        problem: 'not a regular file',
      });
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reads a file it may not open as no result',
    () => {
      plant(JSON.stringify(validResult()));
      chmodSync(fileOf(), 0o000);
      try {
        expect(readHostResult(home, 'claude-code')).toEqual({
          result: null,
          problem: 'unreadable',
        });
      } finally {
        chmodSync(fileOf(), 0o600);
      }
    },
  );

  it.each(['../claude-code', 'a/b', 'Claude', '', 'a'.repeat(40), '..'])(
    'does not look at the disk for an agent called %j',
    (agent) => {
      expect(readHostResult(home, agent)).toEqual({ result: null, problem: 'not an agent name' });
    },
  );

  it('never throws, whatever the home is', () => {
    const notADirectory = join(home, 'a-file');
    writeFileSync(notADirectory, 'x');
    expect(() => readHostResult(notADirectory, 'claude-code')).not.toThrow();
    expect(readHostResult(notADirectory, 'claude-code').result).toBeNull();
  });
});
