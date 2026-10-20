import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadKeys } from '../../src/sent/keys.js';
import { NAME_NOT_SHOWN } from '../../src/sent/names.js';
import { treeOf } from '../helpers/tree.js';

/**
 * The keys `stroq sent` compares sessions with, built in memory from the files the live guard's
 * index reads. Every value here is made up for the test; the HOME is a temporary folder.
 */

const AWS = 'FAKEawsSecretValue0123456789abcdefABCDEF';
const NPM = 'npm_FAKEnpmTokenValue0123456789abcdef';
const NETRC = 'FAKEnetrcPassword0123456789';
const DOCKER_PASSWORD = 'FAKEdockerPassword0123456789';
const PROJECT = 'FAKEprojectApiKey0123456789abcdef';
const LOCAL = 'FAKElocalOverride0123456789abcdef';
const ENV_ONLY = 'FAKEenvOnlyToken0123456789abcdef';

function machine(): { home: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'stroq-sent-keys-'));
  const home = join(root, 'home');
  const project = join(root, 'work', 'app');
  mkdirSync(join(home, '.aws'), { recursive: true });
  mkdirSync(join(home, '.docker'), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, '.aws', 'credentials'), `[default]\naws_secret_access_key = ${AWS}\n`);
  writeFileSync(join(home, '.npmrc'), `//registry.npmjs.org/:_authToken=${NPM}\n`);
  writeFileSync(join(home, '.netrc'), `machine api.example.test login me password ${NETRC}\n`);
  const auth = Buffer.from(`me:${DOCKER_PASSWORD}`).toString('base64');
  writeFileSync(
    join(home, '.docker', 'config.json'),
    JSON.stringify({ auths: { 'registry.example.test': { auth } } }),
  );
  writeFileSync(join(project, '.env'), `API_KEY=${PROJECT}\nPORT=3000\n`);
  writeFileSync(join(project, '.env.local'), `SECRET_TOKEN=${LOCAL}\n`);
  writeFileSync(join(project, '.env.example'), 'API_KEY=FAKEexampleOnlyValue0123456789\n');
  return { home, project };
}

describe('loadKeys', () => {
  it('reads the same files the guard reads, and the credential-shaped environment', () => {
    const { home, project } = machine();
    const set = loadKeys({
      home,
      env: { GITHUB_TOKEN: ENV_ONLY, PATH: '/usr/bin' },
      projectDirs: [project],
    });
    const byName = new Map(set.keys.map((k) => [k.name, k]));

    expect(byName.get('aws_secret_access_key')?.source).toBe('~/.aws/credentials');
    expect(byName.get('//registry.npmjs.org/:_authToken')?.source).toBe('~/.npmrc');
    expect(byName.get('password (api.example.test)')?.source).toBe('~/.netrc');
    expect(byName.get('docker password (registry.example.test)')?.source).toBe(
      '~/.docker/config.json',
    );
    expect(byName.get('API_KEY')?.source).toBe(join(project, '.env'));
    expect(byName.get('SECRET_TOKEN')?.source).toBe(join(project, '.env.local'));
    expect(byName.get('GITHUB_TOKEN')?.source).toBe('env');
    expect(set.keys.some((k) => k.value === 'FAKEexampleOnlyValue0123456789')).toBe(false);
    expect(set.keys.some((k) => k.name === 'PORT')).toBe(false);
    expect(set.envKeys).toBe(1);
    expect(set.files).toContain('~/.aws/credentials');
    expect(set.files).toContain(join(project, '.env'));
  });

  it('keeps one key per value, named after the file before the environment', () => {
    const { home, project } = machine();
    const set = loadKeys({ home, env: { SOME_API_KEY: PROJECT }, projectDirs: [project] });
    const matching = set.keys.filter((k) => k.value === PROJECT);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.name).toBe('API_KEY');
  });

  it('reads the .env files of every project folder it is given, once each', () => {
    const { home, project } = machine();
    const other = mkdtempSync(join(tmpdir(), 'stroq-sent-keys-other-'));
    writeFileSync(join(other, '.env'), 'OTHER_SECRET=FAKEotherProjectSecret012345\n');
    const set = loadKeys({ home, env: {}, projectDirs: [project, other, project] });
    expect(set.keys.map((k) => k.name)).toContain('OTHER_SECRET');
    expect(set.files.filter((f) => f === join(project, '.env'))).toHaveLength(1);
  });

  // A name is read from a file or the environment, and is printed: one with a terminal escape or
  // a line break in it is replaced with a fixed label, wherever it came from.
  it('keeps a name only when it has the shape of one', () => {
    const { home, project } = machine();
    writeFileSync(
      join(home, '.netrc'),
      `machine evil\u001b[2J.example login me password ${NETRC}\n`,
    );
    const auth = Buffer.from(`me:${DOCKER_PASSWORD}`).toString('base64');
    writeFileSync(
      join(home, '.docker', 'config.json'),
      JSON.stringify({ auths: { 'registry\nSTRIPE_KEY: fine': { auth } } }),
    );
    const stroqHome = join(home, '..', 'stroq');
    mkdirSync(stroqHome, { recursive: true });
    const decoy = join(home, 'decoy.env');
    writeFileSync(decoy, 'BAD\u001b]0;x\u0007_KEY=stroq_canary_FAKEcanary0123456789abcdefABCDEF\n');
    writeFileSync(join(stroqHome, 'canary-files.json'), JSON.stringify({ files: [decoy] }));
    const set = loadKeys({
      home,
      env: { 'EVIL\u001b[31m_TOKEN': ENV_ONLY },
      projectDirs: [project],
      stroqHome,
    });
    const names = set.keys.map((k) => k.name);
    const control = (n: string): boolean =>
      [...n].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
    expect(names.some(control)).toBe(false);
    for (const value of [NETRC, DOCKER_PASSWORD, ENV_ONLY])
      expect(set.keys.find((k) => k.value === value)?.name).toBe(NAME_NOT_SHOWN);
    expect(set.keys.find((k) => k.canary === true)?.name).toBe(NAME_NOT_SHOWN);
    expect(names).toContain('API_KEY');
  });

  it('finds nothing, and says so, on a machine with no credential files', () => {
    const empty = mkdtempSync(join(tmpdir(), 'stroq-sent-keys-empty-'));
    const set = loadKeys({ home: empty, env: {}, projectDirs: [empty] });
    expect(set.keys).toEqual([]);
    expect(set.files).toEqual([]);
  });

  it('writes nothing, anywhere under HOME or the project', () => {
    const { home, project } = machine();
    const before = treeOf(join(home, '..'));
    loadKeys({ home, env: { GITHUB_TOKEN: ENV_ONLY }, projectDirs: [project] });
    expect(treeOf(join(home, '..'))).toEqual(before);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'counts a file it cannot read, and goes on with the others',
    () => {
      const { home, project } = machine();
      chmodSync(join(home, '.npmrc'), 0o000);
      const set = loadKeys({ home, env: {}, projectDirs: [project] });
      chmodSync(join(home, '.npmrc'), 0o600);
      expect(set.unreadable).toBe(1);
      expect(set.keys.some((k) => k.name === 'aws_secret_access_key')).toBe(true);
    },
  );
});
