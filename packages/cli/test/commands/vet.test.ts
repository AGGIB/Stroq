import { mkdirSync, symlinkSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PassportSchema, type Passport } from '../../src/install/types.js';
import { removeTempRoots, tempRoot, writeFiles } from '../helpers/install-dir.js';
import {
  folder,
  mcpFolder,
  PLATFORM_NOTE,
  pluginFolder,
  skillFolder,
  vet,
} from '../helpers/vet-world.js';

afterEach(removeTempRoots);

const CLOSING =
  'This is a reading of the files, not a security certificate: an absent line means nothing was seen, not that nothing is there.';
const SKILL_DIGEST = '32bb90d578d8f26224c2f87ec67ce6672c92091d108eb655a652feda5076d3f6';

/** The passport that `--json` prints for a folder. */
async function passportOf(dir: string, ...flags: string[]): Promise<Passport> {
  const run = await vet(['--from', dir, '--json', ...flags]);
  expect(run.code, run.stderr).toBe(0);
  return PassportSchema.parse(JSON.parse(run.stdout));
}

describe('stroq vet --from <skill folder>', () => {
  it('exits 0 and prints the kind and the name first, then the digest with the size', async () => {
    const run = await vet(['--from', skillFolder()]);
    const lines = run.stdout.split('\n');

    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toBe('');
    expect(lines[0]).toBe(
      'skill pdf-forms 1.2.0 (name and version declared by the artifact, not checked)',
    );
    expect(lines[1]).toBe(
      `stroq-tree/1 sha256:${SKILL_DIGEST}  4 files, 945 bytes${PLATFORM_NOTE}`,
    );
  });

  it('puts the lines that are sensitive first, each with its basis, kind, subject and first place', async () => {
    const out = (await vet(['--from', skillFolder()])).stdout;

    const sensitive = out.indexOf('SENSITIVE (');
    const other = out.indexOf('OTHER (');
    expect(sensitive).toBeGreaterThan(0);
    expect(other).toBeGreaterThan(sensitive);
    expect(out.slice(sensitive, other)).toMatch(
      /\[declared\] allowed-tools\s+Bash\(python3:\*\)\s+SKILL\.md:5/,
    );
    expect(out.slice(sensitive, other)).toMatch(
      /\[observed\] cred\.env\s+PDF_API_KEY\s+scripts\/fill\.py:5/,
    );
    expect(out.slice(sensitive, other)).toMatch(
      /\[observed\] net\s+api\.pdf-tools\.example\s+SKILL\.md:20 \(\+1 more\)/,
    );
    expect(out.slice(other)).toMatch(/\[declared\] allowed-tools\s+Grep\s+SKILL\.md:5/);
    // A line that is not sensitive is not among the ones that are.
    expect(out.slice(sensitive, other)).not.toContain('PDF_REGION');
  });

  it('lists every blind spot of the passport, whatever else it leaves out of the screen', async () => {
    const dir = skillFolder();
    const passport = await passportOf(dir);
    const out = (await vet(['--from', dir])).stdout;

    expect(passport.blindSpots.length).toBeGreaterThan(3);
    for (const spot of passport.blindSpots) expect(out, spot).toContain(`- ${spot}`);
    expect(out).toContain(`BLIND SPOTS (${passport.blindSpots.length})`);
  });

  it('counts the signals, and names the rule of each kind', async () => {
    const out = (await vet(['--from', skillFolder()])).stdout;

    expect(out).toMatch(/^SIGNALS \(1\): process-spawn$/m);
  });

  it('ends with the sentence that says what a reading is not, and takes about a screen', async () => {
    const out = (await vet(['--from', skillFolder()])).stdout;
    const lines = out.split('\n');

    expect(lines.at(-1)).toBe('');
    expect(lines.at(-2)).toBe(CLOSING);
    expect(lines.length).toBeLessThanOrEqual(27);
  });

  it('names no path of this machine, only the folder and the files in it', async () => {
    const dir = skillFolder();
    const run = await vet(['--from', dir]);

    expect(run.stdout).not.toContain(dirname(dir));
  });

  // The golden screen is one of a platform that has the executable bit: Windows adds a note and a blind spot.
  it.skipIf(process.platform === 'win32')(
    'prints the same lines as a golden file, for the folder of the inspector tests',
    async () => {
      const golden = readFileSync(new URL('./golden/vet-pdf-skill.txt', import.meta.url), 'utf8');

      const run = await vet(['--from', skillFolder()]);

      expect(run.stdout).toBe(golden);
    },
  );

  it('is the screen that the guide shows for it, so that the guide cannot drift from the command', () => {
    const golden = readFileSync(new URL('./golden/vet-pdf-skill.txt', import.meta.url), 'utf8');
    const guide = readFileSync(new URL('../../../../docs/GUIDE.md', import.meta.url), 'utf8');

    expect(guide).toContain(`\`\`\`text\n${golden}\`\`\``);
  });

  it('names the folder when the artifact does not name itself', async () => {
    const dir = folder('plain-notes', { 'SKILL.md': '---\ndescription: notes\n---\n# n\n' });
    const first = (await vet(['--from', dir])).stdout.split('\n')[0];

    expect(first).toBe('skill plain-notes (named after the folder)');
  });
});

describe('stroq vet --from <MCP server folder> and <plugin folder>', () => {
  it('reads an MCP server: the install script, the address it reaches and the package it names', async () => {
    const run = await vet(['--from', mcpFolder()]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout.split('\n')[0]).toBe(
      'mcp @acme/weather-mcp 1.2.0 (name and version declared by the artifact, not checked)',
    );
    expect(run.stdout).toMatch(/\[declared\] install-script\s+postinstall\b/);
    expect(run.stdout).toMatch(/\[observed\] net\s+api\.weather\.example\b/);
    expect(run.stdout).toMatch(/\[observed\] cred\.env\s+WEATHER_API_KEY\b/);
    expect(run.stdout).toContain('non-registry-dependency');
  });

  it('reads a plugin by its manifest', async () => {
    const run = await vet(['--from', pluginFolder()]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout.split('\n')[0]).toMatch(/^plugin formatter 0\.3\.0 \(/);
    expect(run.stdout).toMatch(/\[declared\] exec\s+node server\.js\s+\.mcp\.json/);
    expect(run.stdout).toMatch(/\[declared\] cred\.env\s+FMT_PAT\b/);
  });

  it('takes the kind it is told, even where the files say another', async () => {
    const passport = await passportOf(skillFolder(), '--kind', 'mcp');

    expect(passport.artifact.kind).toBe('mcp');
  });
});

describe('a folder that cannot be read as an artifact', () => {
  it('exits 3 and says to name the kind, when the files do not say what the folder is', async () => {
    const dir = folder('notes', { 'README.md': '# only prose\n' });
    const run = await vet(['--from', dir]);

    expect(run.code).toBe(3);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/^stroq vet: the files do not say what kind of artifact this is/);
    expect(run.stderr).toContain('--kind skill, --kind mcp or --kind plugin');
  });

  it('reads the same folder when it is told the kind', async () => {
    const dir = folder('notes', { 'README.md': '# only prose\n' });
    const run = await vet(['--from', dir, '--kind', 'skill']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout.split('\n')[0]).toBe('skill notes (named after the folder)');
  });

  it('exits 3 and says which kind to choose, when the files look like two', async () => {
    const dir = folder('both', {
      'SKILL.md': '---\nname: both\n---\n# b\n',
      '.mcp.json': '{"mcpServers":{}}',
    });
    const run = await vet(['--from', dir]);

    expect(run.code).toBe(3);
    expect(run.stderr).toContain('more than one kind');
  });

  it('exits 3 for a path that is a file, and for one that is nothing, and prints neither path', async () => {
    const root = tempRoot('vet');
    writeFiles(root, { 'a-file.txt': 'x' });
    const file = await vet(['--from', join(root, 'a-file.txt')]);
    const nothing = await vet(['--from', join(root, 'not-there')]);

    expect(file.code).toBe(3);
    expect(file.stderr).toContain('the path is not a folder');
    expect(nothing.code).toBe(3);
    expect(nothing.stderr).toContain('there is nothing at the path to read');
    for (const run of [file, nothing]) {
      expect(run.stdout).toBe('');
      expect(run.stderr).not.toContain(root);
    }
  });

  it('exits 3 for a folder over a limit of the reader, with the fixed phrase of the limit', async () => {
    const dir = folder('big', {
      'SKILL.md': '# s\n',
      'data.bin': new Uint8Array(8 * 1024 * 1024 + 1),
    });
    const run = await vet(['--from', dir]);

    expect(run.code).toBe(3);
    expect(run.stderr).toMatch(/over the 8388608 bytes a file may be/);
    expect(run.stderr).not.toContain(dir);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'exits 3 for a file that cannot be opened, and names it quoted, without the path of the folder',
    async () => {
      const dir = skillFolder();
      chmodSync(join(dir, 'reference.md'), 0o000);
      const run = await vet(['--from', dir]);

      expect(run.code).toBe(3);
      expect(run.stderr).toContain('"reference.md" could not be read (EACCES)');
      expect(run.stderr).not.toContain(dir);
    },
  );

  it('does not follow a link: it records it, and says in a blind spot that it did not look', async () => {
    const dir = skillFolder();
    const outside = tempRoot('outside');
    writeFileSync(join(outside, 'secret.txt'), 'SECRET_TOKEN_VALUE_FROM_OUTSIDE\n');
    try {
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'notes.txt'));
    } catch {
      return; // a platform that does not allow links to a person without the right
    }
    const run = await vet(['--from', dir]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('1 symbolic link was recorded and not followed');
    expect(run.stdout).not.toContain('SECRET_TOKEN_VALUE_FROM_OUTSIDE');
    expect(run.stdout).not.toContain(outside);
    expect((await passportOf(dir)).artifact.digest).not.toBe(SKILL_DIGEST);
  });

  it('leaves a .git folder and a node_modules folder out, and says so', async () => {
    const dir = skillFolder();
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'config'), '[core]\n');
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'process.env.NOT_READ;\n');
    const run = await vet(['--from', dir]);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('a .git entry was left out');
    expect(run.stdout).toContain('node_modules entry was left out');
    expect(run.stdout).not.toContain('NOT_READ');
    expect(run.stdout).toContain(`sha256:${SKILL_DIGEST}`);
  });
});
