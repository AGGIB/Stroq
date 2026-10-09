import {
  chmodSync,
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
import { readHostResult, writeHostResult } from '../../src/live/store.js';
import { liveDirIn, liveResultFileIn } from '../../src/paths.js';
import { inChild } from './child.js';
import { validResult } from './helpers.js';

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
    writeHostResult(home, validResult({ agent: 'codex', state: 'inconclusive' }));
    expect(readFileSync(fileOf('claude-code'), 'utf8')).toContain('"claude-code"');
    expect(readHostResult(home, 'codex').result?.state).toBe('inconclusive');
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
