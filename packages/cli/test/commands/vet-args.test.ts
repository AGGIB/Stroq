import { describe, expect, it } from 'vitest';
import { parseVetArgs, VET_KINDS } from '../../src/commands/vet.js';
import { ARTIFACT_KINDS } from '../../src/install/types.js';
import { vet } from '../helpers/vet-world.js';

const HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function problemOf(args: readonly string[]): string {
  const parsed = parseVetArgs(args);
  if (parsed.ok) throw new Error(`expected a usage problem, got ${JSON.stringify(parsed.options)}`);
  return parsed.error;
}

function optionsOf(args: readonly string[]) {
  const parsed = parseVetArgs(args);
  if (!parsed.ok) throw new Error(`expected options, got "${parsed.error}"`);
  return parsed.options;
}

describe('the command line of stroq vet', () => {
  it('takes the kinds the passport has, no more and no fewer', () => {
    expect([...VET_KINDS]).toEqual([...ARTIFACT_KINDS]);
  });

  it('reads a folder or an archive, and leaves everything else off', () => {
    expect(optionsOf(['--from', 'some/dir'])).toEqual({
      from: 'some/dir',
      online: null,
      kind: 'auto',
      json: false,
      card: false,
      expect: null,
      out: null,
      probe: false,
      entrypoint: undefined,
    });
  });

  it('reads an online package or repository, and leaves everything else off', () => {
    expect(optionsOf(['--online', 'npm:my-pkg'])).toEqual({
      from: null,
      online: 'npm:my-pkg',
      kind: 'auto',
      json: false,
      card: false,
      expect: null,
      out: null,
      probe: false,
      entrypoint: undefined,
    });
    expect(optionsOf(['--online', 'github:owner/repo#v1.0.0']).online).toBe(
      'github:owner/repo#v1.0.0',
    );
    expect(optionsOf(['--online', 'https://example.com/archive.tgz']).online).toBe(
      'https://example.com/archive.tgz',
    );
  });

  it('needs a folder or an archive to read, and says how to give it', () => {
    expect(problemOf([])).toContain('--from <dir or .tgz>');
    expect(problemOf(['--json'])).toContain('--from <dir or .tgz>');
    expect(problemOf(['--from', ''])).toContain('--from');
    expect(problemOf(['--online', ''])).toContain('--online');
  });

  it('refuses --from and --online together', () => {
    expect(problemOf(['--from', 'some/dir', '--online', 'npm:foo'])).toContain(
      'give either --from <dir or .tgz> or --online <source>, not both',
    );
  });

  it('refuses malformed or disallowed online sources', () => {
    expect(problemOf(['--online', 'http://example.com/thing.tgz'])).toContain('https only');
    expect(problemOf(['--online', 'unknown:thing'])).toContain('unknown source format');
  });

  it('takes the path only after --from or --online', () => {
    expect(problemOf(['./pdf-forms'])).toContain('--from');
    expect(problemOf(['npm:some-package'])).toContain('--from');
    expect(problemOf(['--from', 'a', 'b'])).toContain('--from');
  });

  it.each(['skill', 'mcp', 'plugin'] as const)('takes --kind %s', (kind) => {
    expect(optionsOf(['--from', 'd', '--kind', kind]).kind).toBe(kind);
  });

  it.each(['', 'Skill', 'server', 'auto', 'skill,mcp'])('refuses --kind "%s"', (kind) => {
    const problem = problemOf(['--from', 'd', '--kind', kind]);
    expect(problem).toContain('--kind');
    expect(problem).toContain('skill');
  });

  it('refuses --json and --card together, because each is the whole output', () => {
    expect(problemOf(['--from', 'd', '--json', '--card'])).toMatch(/--json.*--card|--card.*--json/);
  });

  it('refuses --out with nothing to name a file', () => {
    expect(problemOf(['--from', 'd', '--out', ''])).toContain('--out');
  });

  it('says what a flag it does not have is, and what a missing value is', () => {
    expect(problemOf(['--from', 'd', '--bogus'])).toContain('--bogus');
    expect(problemOf(['--from'])).toContain('--from');
  });
});

describe('--expect', () => {
  it('takes 64 hexadecimal digits, bare or written as sha256:<hex>', () => {
    expect(optionsOf(['--from', 'd', '--expect', HEX]).expect).toBe(HEX);
    expect(optionsOf(['--from', 'd', '--expect', `sha256:${HEX}`]).expect).toBe(HEX);
  });

  it('writes the digest in lower case, which is how a digest is spelled', () => {
    expect(optionsOf(['--from', 'd', '--expect', HEX.toUpperCase()]).expect).toBe(HEX);
    expect(optionsOf(['--from', 'd', '--expect', `SHA256:${HEX.toUpperCase()}`]).expect).toBe(HEX);
  });

  it.each([
    ['nothing', ''],
    ['a prefix and nothing else', 'sha256:'],
    ['63 digits', HEX.slice(1)],
    ['65 digits', `${HEX}0`],
    ['a letter that is not a digit', `g${HEX.slice(1)}`],
    ['another algorithm', `sha1:${HEX}`],
    ['a blank around it', ` ${HEX}`],
    ['a line break in it', `${HEX}\n`],
    ['a short digest, which is a prefix and not a digest', HEX.slice(0, 12)],
  ])('refuses %s', (_label, value) => {
    const problem = problemOf(['--from', 'd', '--expect', value]);
    expect(problem).toContain('--expect');
    expect(problem).toContain('64');
  });

  // A folder read on Windows has no executable bit and an archive has its own, so the refusal on Windows
  // belongs to what the path turns out to be (`vet-archive.test.ts` and `vet-json-expect.test.ts`), not to the
  // words of the command line, which are the same for both.
  it('is not judged by the platform when the command line is read, because only the path says if it is a folder', () => {
    expect(parseVetArgs(['--from', 'd', '--expect', HEX]).ok).toBe(true);
  });

  it('is judged for its syntax, so that a typo is told as a typo whatever the path is', () => {
    expect(problemOf(['--from', 'd', '--expect', 'nope'])).toContain('64');
  });
});

describe('the usage problems as the command prints them', () => {
  it('exits 2 and prints the problem, with the way to the help, on stderr and nothing on stdout', async () => {
    const run = await vet(['--json']);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/^stroq vet: .*--from <dir or \.tgz>/);
    expect(run.stderr).toContain('Run "stroq vet --help" to see its options.');
  });

  it('exits 2 for a flag it does not have, as a parse error and not as a crash', async () => {
    const run = await vet(['--from', 'd', '--nonsense']);

    expect(run.code).toBe(2);
    expect(run.stderr).not.toMatch(/TypeError|ERR_PARSE_ARGS/);
    expect(run.stderr).toContain('--nonsense');
  });
});
