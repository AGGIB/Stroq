import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Transport } from '../../src/install/fetch.js';
import { PassportSchema, type Passport } from '../../src/install/types.js';
import { concat, paxBlocks, tarOf } from '../helpers/tar-writer.js';
import { vet } from '../helpers/vet-world.js';

function makeTarball(
  files: readonly { name: string; content?: string }[],
  options?: { globalComment?: string },
): Uint8Array {
  const entries: any[] = [];
  if (options?.globalComment) {
    entries.push(concat(paxBlocks({ comment: options.globalComment }, 'g')));
  }
  for (const f of files) {
    entries.push({
      name: `package/${f.name}`,
      data: Buffer.from(f.content ?? 'test content\n', 'utf8'),
    });
  }
  return gzipSync(tarOf(entries));
}

function sha512Of(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

interface MockRoute {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

function createMockTransport(
  routes: Record<string, MockRoute | ((url: URL) => MockRoute)>,
): Transport {
  return async (url: URL) => {
    const key = url.toString();
    const routeOrFn = routes[key] ?? routes[url.pathname] ?? routes[url.hostname + url.pathname];
    if (!routeOrFn) {
      return {
        status: 404,
        headers: { get: () => null },
        body: new Uint8Array(),
      };
    }
    const route = typeof routeOrFn === 'function' ? routeOrFn(url) : routeOrFn;
    const bodyBytes =
      typeof route.body === 'string'
        ? Buffer.from(route.body, 'utf8')
        : (route.body ?? new Uint8Array());
    const headerMap: Record<string, string> = {
      'content-length': String(bodyBytes.length),
      ...(route.headers ?? {}),
    };
    return {
      status: route.status ?? 200,
      headers: {
        get(name: string) {
          const lower = name.toLowerCase();
          return headerMap[lower] ?? null;
        },
      },
      body: bodyBytes,
    };
  };
}

describe('stroq vet --online', () => {
  describe('npm packages', () => {
    it('fetches an npm package, prints registry host on stderr, and outputs passport', async () => {
      const tarball = makeTarball([
        {
          name: 'SKILL.md',
          content: '---\nname: my-skill\ndescription: demo\n---\n# My Skill\n',
        },
      ]);
      const integrity = sha512Of(tarball);

      const transport = createMockTransport({
        'https://registry.npmjs.org/my-skill/latest': {
          body: JSON.stringify({
            name: 'my-skill',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/my-skill/-/my-skill-1.0.0.tgz',
              integrity,
            },
          }),
        },
        'https://registry.npmjs.org/my-skill/-/my-skill-1.0.0.tgz': {
          body: tarball,
        },
      });

      const run = await vet(['--online', 'npm:my-skill', '--json'], { transport });
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('registry.npmjs.org\n');

      const passport: Passport = PassportSchema.parse(JSON.parse(run.stdout));
      expect(passport.artifact.kind).toBe('skill');
      expect(passport.artifact.name).toBe('my-skill');
      expect(passport.artifact.source).toEqual({
        type: 'npm',
        name: 'my-skill',
        version: '1.0.0',
        integrity,
      });
    });

    it('vets package with uppercase name such as JSONStream', async () => {
      const tarball = makeTarball([
        {
          name: 'SKILL.md',
          content: '---\nname: JSONStream\ndescription: json stream demo\n---\n# JSONStream\n',
        },
      ]);
      const integrity = sha512Of(tarball);

      const transport = createMockTransport({
        'https://registry.npmjs.org/JSONStream/latest': {
          body: JSON.stringify({
            name: 'JSONStream',
            version: '1.3.5',
            dist: {
              tarball: 'https://registry.npmjs.org/JSONStream/-/JSONStream-1.3.5.tgz',
              integrity,
            },
          }),
        },
        'https://registry.npmjs.org/JSONStream/-/JSONStream-1.3.5.tgz': {
          body: tarball,
        },
      });

      const run = await vet(['--online', 'npm:JSONStream', '--json'], { transport });
      expect(run.code).toBe(0);
      const passport: Passport = PassportSchema.parse(JSON.parse(run.stdout));
      expect(passport.artifact.name).toBe('JSONStream');
    });

    it('renders a markdown card with online reproduction command', async () => {
      const tarball = makeTarball([
        {
          name: 'SKILL.md',
          content: '---\nname: my-skill\ndescription: demo\n---\n# My Skill\n',
        },
      ]);
      const integrity = sha512Of(tarball);

      const transport = createMockTransport({
        'https://registry.npmjs.org/my-skill/latest': {
          body: JSON.stringify({
            name: 'my-skill',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/my-skill/-/my-skill-1.0.0.tgz',
              integrity,
            },
          }),
        },
        'https://registry.npmjs.org/my-skill/-/my-skill-1.0.0.tgz': {
          body: tarball,
        },
      });

      const run = await vet(['--online', 'npm:my-skill', '--card'], { transport });
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('registry.npmjs.org\n');
      expect(run.stdout).toContain('**Stroq vet** `my-skill` (skill)');
      expect(run.stdout).toContain(
        `Reproduce: \`stroq vet --online npm:my-skill@1.0.0 --expect sha256:`,
      );
    });
  });

  describe('github repositories', () => {
    it('fetches a github tarball, extracts commit from pax header, and vets tree', async () => {
      const commit = '0123456789abcdef0123456789abcdef01234567';
      const tarball = makeTarball(
        [
          {
            name: 'SKILL.md',
            content: '---\nname: gh-skill\ndescription: demo\n---\n# GH Skill\n',
          },
        ],
        { globalComment: commit },
      );

      const transport = createMockTransport({
        'https://codeload.github.com/my-org/my-repo/tar.gz/v2.0.0': {
          body: tarball,
        },
      });

      const run = await vet(['--online', 'github:my-org/my-repo#v2.0.0', '--json'], { transport });
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('codeload.github.com\n');

      const passport: Passport = PassportSchema.parse(JSON.parse(run.stdout));
      expect(passport.artifact.name).toBe('my-org/my-repo');
      expect(passport.artifact.source).toEqual({
        type: 'github',
        owner: 'my-org',
        repo: 'my-repo',
        ref: 'v2.0.0',
        commit,
      });
    });

    it('scopes inspection to a subdirectory when specified in github source', async () => {
      const commit = '0123456789abcdef0123456789abcdef01234567';
      const tarball = makeTarball(
        [
          {
            name: 'packages/my-tool/SKILL.md',
            content: '---\nname: scoped-skill\ndescription: sub\n---\n# Scoped\n',
          },
          {
            name: 'other/file.txt',
            content: 'outside\n',
          },
        ],
        { globalComment: commit },
      );

      const transport = createMockTransport({
        'https://codeload.github.com/my-org/mono/tar.gz/main': {
          body: tarball,
        },
      });

      const run = await vet(['--online', 'github:my-org/mono#main:packages/my-tool', '--json'], {
        transport,
      });
      expect(run.code).toBe(0);

      const passport: Passport = PassportSchema.parse(JSON.parse(run.stdout));
      expect(passport.artifact.name).toBe('my-org/mono');
      expect(passport.artifact.files).toBe(1);
      expect(passport.artifact.source).toEqual({
        type: 'github',
        owner: 'my-org',
        repo: 'mono',
        ref: 'main',
        commit,
        subdir: 'packages/my-tool',
      });
    });
  });

  describe('url archives', () => {
    it('fetches an https tarball URL and reports host', async () => {
      const tarball = makeTarball([
        {
          name: 'SKILL.md',
          content: '---\nname: url-skill\ndescription: demo\n---\n# URL Skill\n',
        },
      ]);

      const transport = createMockTransport({
        'https://downloads.example.org/releases/tool-1.0.tgz': {
          body: tarball,
        },
      });

      const run = await vet(
        ['--online', 'https://downloads.example.org/releases/tool-1.0.tgz', '--json'],
        { transport },
      );
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('downloads.example.org\n');

      const passport: Passport = PassportSchema.parse(JSON.parse(run.stdout));
      expect(passport.artifact.name).toBe('url-skill');
      expect(passport.artifact.source).toEqual({
        type: 'url',
        host: 'downloads.example.org',
      });
    });
  });

  describe('--expect with --online', () => {
    it('exits 0 when the digest matches --expect', async () => {
      const tarball = makeTarball([
        {
          name: 'SKILL.md',
          content: '---\nname: expect-skill\ndescription: demo\n---\n# Expect\n',
        },
      ]);
      const integrity = sha512Of(tarball);

      const transport = createMockTransport({
        'https://registry.npmjs.org/expect-skill/latest': {
          body: JSON.stringify({
            name: 'expect-skill',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/expect-skill/-/expect-skill-1.0.0.tgz',
              integrity,
            },
          }),
        },
        'https://registry.npmjs.org/expect-skill/-/expect-skill-1.0.0.tgz': {
          body: tarball,
        },
      });

      const initial = await vet(['--online', 'npm:expect-skill', '--json'], { transport });
      const passport: Passport = PassportSchema.parse(JSON.parse(initial.stdout));
      const digest = passport.artifact.digest;

      const checked = await vet(['--online', 'npm:expect-skill', '--expect', digest], {
        transport,
      });
      expect(checked.code).toBe(0);
    });

    it('exits 1 and prints mismatch when digest differs from --expect', async () => {
      const tarball = makeTarball([
        {
          name: 'SKILL.md',
          content: '---\nname: expect-skill\ndescription: demo\n---\n# Expect\n',
        },
      ]);
      const integrity = sha512Of(tarball);

      const transport = createMockTransport({
        'https://registry.npmjs.org/expect-skill/latest': {
          body: JSON.stringify({
            name: 'expect-skill',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/expect-skill/-/expect-skill-1.0.0.tgz',
              integrity,
            },
          }),
        },
        'https://registry.npmjs.org/expect-skill/-/expect-skill-1.0.0.tgz': {
          body: tarball,
        },
      });

      const wrongDigest = '0000000000000000000000000000000000000000000000000000000000000000';
      const checked = await vet(['--online', 'npm:expect-skill', '--expect', wrongDigest], {
        transport,
      });
      expect(checked.code).toBe(1);
      expect(checked.stderr).toContain('the digest of the files is not the one expected');
      expect(checked.stderr).toContain(`expected: sha256:${wrongDigest}`);
    });
  });

  describe('error conditions and safety limits', () => {
    it('exits 3 when the package is not found (404)', async () => {
      const transport = createMockTransport({});
      const run = await vet(['--online', 'npm:nonexistent-package'], { transport });
      expect(run.code).toBe(3);
      expect(run.stderr).toContain('stroq vet:');
      expect(run.stderr).toContain('HTTP 404');
    });

    it('exits 3 when sha512 integrity check fails', async () => {
      const tarball = makeTarball([
        {
          name: 'SKILL.md',
          content: '---\nname: skill\ndescription: test\n---\n',
        },
      ]);
      const fakeIntegrity =
        'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

      const transport = createMockTransport({
        'https://registry.npmjs.org/skill/latest': {
          body: JSON.stringify({
            name: 'skill',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/skill/-/skill-1.0.0.tgz',
              integrity: fakeIntegrity,
            },
          }),
        },
        'https://registry.npmjs.org/skill/-/skill-1.0.0.tgz': {
          body: tarball,
        },
      });

      const run = await vet(['--online', 'npm:skill'], { transport });
      expect(run.code).toBe(3);
      expect(run.stderr).toContain('integrity mismatch');
    });

    it('exits 2 when both --from and --online are supplied', async () => {
      const run = await vet(['--from', 'local/dir', '--online', 'npm:pkg']);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(
        'give either --from <dir or .tgz> or --online <source>, not both',
      );
    });

    it('exits 2 for disallowed protocols like plain http', async () => {
      const run = await vet(['--online', 'http://insecure.example.com/tool.tgz']);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain('https only');
    });
  });
});
