import { describe, expect, it } from 'vitest';
import { parseVetArgs, VET_KINDS } from '../../src/commands/vet.js';
import { ARTIFACT_KINDS } from '../../src/install/types.js';
import { vet } from '../helpers/vet-world.js';

const HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function problemOf(args: readonly string[], platform: NodeJS.Platform = 'linux'): string {
  const parsed = parseVetArgs(args, platform);
  if (parsed.ok) throw new Error(`expected a usage problem, got ${JSON.stringify(parsed.options)}`);
  return parsed.error;
}

function optionsOf(args: readonly string[], platform: NodeJS.Platform = 'linux') {
  const parsed = parseVetArgs(args, platform);
  if (!parsed.ok) throw new Error(`expected options, got "${parsed.error}"`);
  return parsed.options;
}

describe('the command line of stroq vet', () => {
  it('takes the kinds the passport has, no more and no fewer', () => {
    expect([...VET_KINDS]).toEqual([...ARTIFACT_KINDS]);
  });

  it('reads a folder, and leaves everything else off', () => {
    expect(optionsOf(['--from', 'some/dir'])).toEqual({
      from: 'some/dir',
      kind: 'auto',
      json: false,
      card: false,
      expect: null,
      out: null,
    });
  });

  it('needs a folder to read, and says how to give it', () => {
    expect(problemOf([])).toContain('--from <dir>');
    expect(problemOf(['--json'])).toContain('--from <dir>');
    expect(problemOf(['--from', ''])).toContain('--from');
  });

  it('takes the folder only after --from, because a bare word could be a package or an address', () => {
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
    expect(problemOf(['--from', 'd', '--online'])).toContain('--online');
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

  it('is refused on Windows for a folder, with the reason, because a folder read there has no executable bit', () => {
    const problem = problemOf(['--from', 'd', '--expect', HEX], 'win32');
    expect(problem).toContain('--expect');
    expect(problem).toContain('Windows');
    expect(problem).toContain('executable bit');
    for (const platform of ['linux', 'darwin'] as const) {
      expect(parseVetArgs(['--from', 'd', '--expect', HEX], platform).ok, platform).toBe(true);
    }
  });

  it('is judged for its syntax before its platform, so that a typo is told as a typo', () => {
    expect(problemOf(['--from', 'd', '--expect', 'nope'], 'win32')).toContain('64');
  });
});

describe('the usage problems as the command prints them', () => {
  it('exits 2 and prints the problem, with the way to the help, on stderr and nothing on stdout', async () => {
    const run = await vet(['--json']);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/^stroq vet: .*--from <dir>/);
    expect(run.stderr).toContain('Run "stroq vet --help" to see its options.');
  });

  it('exits 2 for a flag it does not have, as a parse error and not as a crash', async () => {
    const run = await vet(['--from', 'd', '--nonsense']);

    expect(run.code).toBe(2);
    expect(run.stderr).not.toMatch(/TypeError|ERR_PARSE_ARGS/);
    expect(run.stderr).toContain('--nonsense');
  });
});
