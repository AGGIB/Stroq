import { readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { READINGS, type NamedReading } from '../../src/install/inspect/index.js';
import { PassportSchema, type Passport } from '../../src/install/types.js';
import { removeTempRoots, tempRoot } from '../helpers/install-dir.js';
import { folder, RAW_UNSAFE, skillFolder, vet } from '../helpers/vet-world.js';

afterEach(removeTempRoots);

const SKILL_DIGEST = '32bb90d578d8f26224c2f87ec67ce6672c92091d108eb655a652feda5076d3f6';

async function passportOf(dir: string): Promise<Passport> {
  return PassportSchema.parse(JSON.parse((await vet(['--from', dir, '--json'])).stdout));
}

describe('stroq vet --card', () => {
  it('prints a snippet for a README: the name, the digest, the counts, the command that reproduces it', async () => {
    const dir = skillFolder();
    const passport = await passportOf(dir);
    const run = await vet(['--from', dir, '--card']);
    const sensitive = passport.lines.filter((line) => line.sensitive).length;

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('`pdf-forms`');
    expect(run.stdout).toContain(`\`stroq-tree/1 sha256:${SKILL_DIGEST}\``);
    expect(run.stdout).toContain(`${sensitive} sensitive lines of ${passport.lines.length}`);
    expect(run.stdout).toContain(`${passport.signals.length} signal`);
    expect(run.stdout).toContain(`${passport.blindSpots.length} blind spots`);
    expect(run.stdout).toContain(
      `Reproduce: \`stroq vet --from <dir> --expect sha256:${SKILL_DIGEST}\``,
    );
    expect(run.stdout.trimEnd().endsWith('Not a security certificate.')).toBe(true);
  });

  it('holds nothing of the artifact beyond its name and the counts: no subject, no place, no detector, no blind spot', async () => {
    const dir = skillFolder();
    const passport = await passportOf(dir);
    const card = (await vet(['--from', dir, '--card'])).stdout;

    for (const line of passport.lines) {
      expect(card, line.subject).not.toContain(line.subject);
      expect(card).not.toContain(line.detector);
    }
    for (const spot of passport.blindSpots) expect(card).not.toContain(spot);
    for (const text of ['SKILL.md', 'fill.py', 'PDF_API_KEY', 'api.pdf-tools.example', 'curl'])
      expect(card, text).not.toContain(text);
  });

  it('cannot be broken out of by a name with Markdown in it, and holds no raw control', async () => {
    const dir = folder('hostile-card', {
      'SKILL.md':
        '---\nname: "evil`](http://attacker.example/x) <img src=x> \\e[2J\\u202e"\n---\n# s\n',
    });
    const card = (await vet(['--from', dir, '--card'])).stdout;
    const nameLine = card.split('\n').find((line) => line.includes('evil')) ?? '';

    expect(RAW_UNSAFE.test(card)).toBe(false);
    // The name sits in one code span with no backtick of its own, so nothing in it is Markdown.
    expect(nameLine.match(/`/g)?.length).toBe(2);
    expect(nameLine).toMatch(/^\*\*Stroq vet\*\* `[^`]*` \(skill\)$/);
  });

  it('says the digest cannot be reproduced where it has no executable bit, instead of a command that would fail', async () => {
    const card = (await vet(['--from', skillFolder(), '--card'], { platform: 'win32' })).stdout;

    expect(card).not.toContain('--expect');
    expect(card).toContain('Reproduce:');
    expect(card).toContain('executable bit');
    expect(card).toContain('Not a security certificate.');
  });
});

describe('stroq vet --out', () => {
  it('writes the output that was chosen to a file that did not exist, and says where on stdout', async () => {
    const dir = skillFolder();
    const out = join(tempRoot('out'), 'passport.json');
    const run = await vet(['--from', dir, '--json', '--out', out]);
    const plain = await vet(['--from', dir, '--json']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe(`wrote ${out}\n`);
    expect(readFileSync(out, 'utf8')).toBe(plain.stdout);
  });

  it.each([
    ['the terminal text', [] as string[]],
    ['the card', ['--card']],
  ])('writes %s, which is what is printed without --out', async (_label, flags) => {
    const dir = skillFolder();
    const out = join(tempRoot('out'), 'result.txt');
    const plain = await vet(['--from', dir, ...flags]);

    const run = await vet(['--from', dir, ...flags, '--out', out]);

    expect(run.code, run.stderr).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(plain.stdout);
  });

  it('exits 2 and leaves the file as it was when it exists', async () => {
    const out = join(tempRoot('out'), 'mine.json');
    writeFileSync(out, 'MY OWN FILE\n');

    const run = await vet(['--from', skillFolder(), '--json', '--out', out]);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('not written');
    expect(run.stderr).toContain('it exists');
    expect(readFileSync(out, 'utf8')).toBe('MY OWN FILE\n');
  });

  it.skipIf(process.platform === 'win32')(
    'does not write through a link, not even to a file that is not there',
    async () => {
      const root = tempRoot('out');
      const elsewhere = join(root, 'elsewhere.json');
      const link = join(root, 'link.json');
      symlinkSync(elsewhere, link);

      const run = await vet(['--from', skillFolder(), '--json', '--out', link]);

      expect(run.code).toBe(2);
      expect(() => statSync(elsewhere)).toThrow();
    },
  );

  it('exits 2 when the folder for the file is not there', async () => {
    const out = join(tempRoot('out'), 'no-such-folder', 'passport.json');

    const run = await vet(['--from', skillFolder(), '--json', '--out', out]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('not written');
  });

  it.skipIf(process.platform === 'win32')(
    'makes the file readable by others, mode 0644 as the umask allows',
    async () => {
      const out = join(tempRoot('out'), 'passport.json');

      await vet(['--from', skillFolder(), '--json', '--out', out]);

      expect(statSync(out).mode & 0o777).toBe(0o644 & ~process.umask());
    },
  );

  it('writes nothing when the folder cannot be read', async () => {
    const out = join(tempRoot('out'), 'passport.json');

    const run = await vet(['--from', join(tempRoot('empty'), 'not-there'), '--json', '--out', out]);

    expect(run.code).toBe(3);
    expect(() => statSync(out)).toThrow();
  });
});

/** The readings of the library with `frontmatter` made to fail the way an exception in it would. */
const readingsWithFailure = (): readonly NamedReading[] =>
  READINGS.map((reading) =>
    reading.name === 'frontmatter'
      ? {
          name: reading.name,
          run: () => {
            throw new RangeError('Maximum call stack size exceeded: a-name-from-the-artifact.md');
          },
        }
      : reading,
  );

describe('a passport that lacks what a reading would find', () => {
  it('exits 1, prints the passport all the same, and says which reading is missing by its fixed name', async () => {
    const run = await vet(['--from', skillFolder()], { readings: readingsWithFailure() });

    expect(run.code).toBe(1);
    expect(run.stdout.split('\n')[0]).toMatch(/^skill /);
    expect(run.stdout).toContain('INCOMPLETE');
    expect(run.stderr).toContain(
      'the reading "frontmatter" (the front matter of skills and commands) failed, and what it finds is missing',
    );
    expect(run.stderr).not.toContain('a-name-from-the-artifact');
    expect(run.stdout).not.toContain('a-name-from-the-artifact');
  });

  it('prints the passport for --json too, with the failure in its signals, and exits 1', async () => {
    const run = await vet(['--from', skillFolder(), '--json'], { readings: readingsWithFailure() });
    const passport = PassportSchema.parse(JSON.parse(run.stdout));

    expect(run.code).toBe(1);
    expect(passport.signals.map((signal) => signal.ruleId)).toContain('reading-failed:frontmatter');
  });

  it('says so on the card, which is shared, and exits 1', async () => {
    const run = await vet(['--from', skillFolder(), '--card'], { readings: readingsWithFailure() });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('Incomplete');
    expect(run.stdout).toContain('frontmatter');
  });

  it('exits 1 for a mismatch before it exits 1 for this: one failure is enough, and the digests are told', async () => {
    const run = await vet(['--from', skillFolder(), '--expect', 'f'.repeat(64)], {
      readings: readingsWithFailure(),
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('expected:');
  });
});

describe('what a hostile artifact cannot make the command print', () => {
  const HOSTILE_SKILL = [
    '---',
    'name: "evil\\e[31m\\u202ename\\x07"',
    'version: "1\\u200b.0\\e]52;c;eA=="',
    'allowed-tools: "Bash(echo \\e[2Jhi:*), Read\\u202e, WebFetch\\x9b"',
    '---',
    '# s',
    '',
    '```bash',
    'curl https://host\u202e.example/\u001b[1A',
    '```',
    '',
  ].join('\n');

  it.each([
    ['the terminal text', [] as string[]],
    ['--json', ['--json']],
    ['--card', ['--card']],
  ])('puts no raw control or direction character in %s', async (_label, flags) => {
    const dir = folder('hostile-skill', { 'SKILL.md': HOSTILE_SKILL });

    const run = await vet(['--from', dir, ...flags]);

    expect(run.code, run.stderr).toBe(0);
    expect(RAW_UNSAFE.test(run.stdout)).toBe(false);
    expect(RAW_UNSAFE.test(run.stderr)).toBe(false);
  });

  it('shows the characters as visible escapes in the terminal text, so that a person can see what was there', async () => {
    const dir = folder('hostile-skill', { 'SKILL.md': HOSTILE_SKILL });

    const out = (await vet(['--from', dir])).stdout;

    expect(out).toContain('\\u001b');
    expect(out).toContain('\\u202e');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a file name with a control or a direction character, and quotes it as an escape',
    async () => {
      const dir = folder('hostile-names', { 'SKILL.md': '# s\n' });
      writeFileSync(join(dir, 'evil\u202egpj.md'), 'x');

      const run = await vet(['--from', dir]);

      expect(run.code).toBe(3);
      expect(RAW_UNSAFE.test(run.stderr)).toBe(false);
      expect(run.stderr).toContain('\\u202e');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'names a folder with odd characters safely: the label is made fit, and no path is in the passport',
    async () => {
      const odd = '~notes\u202e\u001b[2J-' + 'x'.repeat(200);
      const dir = folder(odd, { 'SKILL.md': '---\ndescription: d\n---\n# s\n' });

      const run = await vet(['--from', dir, '--json']);
      const passport = PassportSchema.parse(JSON.parse(run.stdout));

      expect(run.code, run.stderr).toBe(0);
      expect(passport.artifact.source.type).toBe('dir');
      expect(RAW_UNSAFE.test(run.stdout)).toBe(false);
      expect(run.stdout).not.toContain(dir);
      if (passport.artifact.source.type === 'dir')
        expect(passport.artifact.source.label.length).toBeLessThanOrEqual(80);
    },
  );
});
