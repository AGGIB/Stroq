import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  FetchError,
  fetchSourceTree,
  type FetchOptions,
  type HttpResponse,
  type Transport,
} from '../../src/install/fetch.js';
import { parseOnlineSource } from '../../src/install/source.js';
import { LIMITS } from '../../src/install/types.js';
import { concat, paxBlocks, tarOf } from '../helpers/tar-writer.js';

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

describe('fetchSourceTree', () => {
  describe('npm sources', () => {
    it('fetches unscoped package at latest version and verifies sha512 integrity', async () => {
      const tarball = makeTarball([{ name: 'SKILL.md', content: '# my skill\n' }]);
      const integrity = sha512Of(tarball);
      const reportedHosts: string[] = [];

      const transport = createMockTransport({
        'https://registry.npmjs.org/my-skill': {
          body: JSON.stringify({
            'dist-tags': { latest: '1.2.0' },
            versions: {
              '1.2.0': {
                dist: {
                  tarball: 'https://registry.npmjs.org/my-skill/-/my-skill-1.2.0.tgz',
                  integrity,
                },
              },
            },
          }),
        },
        'https://registry.npmjs.org/my-skill/-/my-skill-1.2.0.tgz': {
          body: tarball,
        },
      });

      const res = await fetchSourceTree(parseOnlineSource('npm:my-skill'), {
        transport,
        onHost: (h) => reportedHosts.push(h),
      });

      expect(reportedHosts).toEqual(['registry.npmjs.org']);
      expect(res.sourceRef).toEqual({
        type: 'npm',
        name: 'my-skill',
        version: '1.2.0',
        integrity,
      });
      expect(res.tree.entries.map((e) => e.path)).toEqual(['SKILL.md']);
    });

    it('fetches scoped package at specified version tag', async () => {
      const tarball = makeTarball([{ name: 'index.js', content: 'console.log(1);\n' }]);
      const integrity = sha512Of(tarball);

      const transport = createMockTransport({
        'https://registry.npmjs.org/@acme%2Fserver': {
          body: JSON.stringify({
            'dist-tags': { next: '2.0.0-beta.1' },
            versions: {
              '2.0.0-beta.1': {
                dist: {
                  tarball: 'https://registry.npmjs.org/@acme/server/-/server-2.0.0-beta.1.tgz',
                  integrity,
                },
              },
            },
          }),
        },
        'https://registry.npmjs.org/@acme/server/-/server-2.0.0-beta.1.tgz': {
          body: tarball,
        },
      });

      const res = await fetchSourceTree(parseOnlineSource('npm:@acme/server@next'), {
        transport,
      });

      expect(res.sourceRef).toEqual({
        type: 'npm',
        name: '@acme/server',
        version: '2.0.0-beta.1',
        integrity,
      });
    });

    it('refuses when package has no sha512 integrity', async () => {
      const tarball = makeTarball([{ name: 'SKILL.md' }]);

      const transport = createMockTransport({
        'https://registry.npmjs.org/no-sha': {
          body: JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': {
                dist: {
                  tarball: 'https://registry.npmjs.org/no-sha/-/no-sha-1.0.0.tgz',
                  shasum: '1234567890abcdef', // only legacy sha1
                },
              },
            },
          }),
        },
      });

      await expect(fetchSourceTree(parseOnlineSource('npm:no-sha'), { transport })).rejects.toThrow(
        /no sha-512 integrity/,
      );
    });

    it('refuses on integrity mismatch', async () => {
      const tarball = makeTarball([{ name: 'SKILL.md' }]);
      const bogusIntegrity = `sha512-${'B'.repeat(86)}==`;

      const transport = createMockTransport({
        'https://registry.npmjs.org/tampered': {
          body: JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': {
                dist: {
                  tarball: 'https://registry.npmjs.org/tampered/-/tampered-1.0.0.tgz',
                  integrity: bogusIntegrity,
                },
              },
            },
          }),
        },
        'https://registry.npmjs.org/tampered/-/tampered-1.0.0.tgz': {
          body: tarball,
        },
      });

      await expect(
        fetchSourceTree(parseOnlineSource('npm:tampered'), { transport }),
      ).rejects.toThrow(/integrity mismatch/);
    });

    it('refuses when tarball origin does not match npm registry', async () => {
      const transport = createMockTransport({
        'https://registry.npmjs.org/bad-origin': {
          body: JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': {
                dist: {
                  tarball: 'https://evil.example.com/bad-origin.tgz',
                  integrity: `sha512-${'A'.repeat(86)}==`,
                },
              },
            },
          }),
        },
      });

      await expect(
        fetchSourceTree(parseOnlineSource('npm:bad-origin'), { transport }),
      ).rejects.toThrow(/npm tarball origin .* does not match registry/);
    });

    it('refuses when package or version is 404', async () => {
      const transport = createMockTransport({});
      await expect(
        fetchSourceTree(parseOnlineSource('npm:missing-package'), { transport }),
      ).rejects.toThrow(/resource not found \(HTTP 404\)/);
    });
  });

  describe('github sources', () => {
    it('fetches codeload tarball and records commit ref', async () => {
      const commit = '11477cb31c3413cfd29f8c14d9980a37e1994625';
      const tarball = makeTarball([{ name: 'SKILL.md', content: '# gh skill\n' }]);
      const reportedHosts: string[] = [];

      const transport = createMockTransport({
        [`https://codeload.github.com/AGGIB/Stroq/tar.gz/${commit}`]: {
          body: tarball,
        },
      });

      const res = await fetchSourceTree(parseOnlineSource(`github:AGGIB/Stroq#${commit}`), {
        transport,
        onHost: (h) => reportedHosts.push(h),
      });

      expect(reportedHosts).toEqual(['codeload.github.com']);
      expect(res.sourceRef).toEqual({
        type: 'github',
        owner: 'AGGIB',
        repo: 'Stroq',
        ref: commit,
        commit,
      });
      expect(res.tree.entries.map((e) => e.path)).toEqual(['SKILL.md']);
    });

    it('extracts commit from pax global header when ref is a tag or branch', async () => {
      const commitFromPax = 'abcd0123456789abcdef0123456789abcdef0123';
      const tarball = makeTarball([{ name: 'README.md', content: 'hello\n' }], {
        globalComment: commitFromPax,
      });

      const transport = createMockTransport({
        'https://codeload.github.com/facebook/react/tar.gz/main': {
          body: tarball,
        },
      });

      const res = await fetchSourceTree(parseOnlineSource('github:facebook/react#main'), {
        transport,
      });

      expect(res.sourceRef).toEqual({
        type: 'github',
        owner: 'facebook',
        repo: 'react',
        ref: 'main',
        commit: commitFromPax,
      });
    });

    it('scopes tree to subdir when specified', async () => {
      const tarball = makeTarball([
        { name: 'packages/cli/src/index.ts', content: 'export const x = 1;\n' },
        { name: 'packages/cli/package.json', content: '{"name":"cli"}\n' },
        { name: 'packages/core/src/index.ts', content: 'export const y = 2;\n' },
        { name: 'README.md', content: '# repo\n' },
      ]);

      const transport = createMockTransport({
        'https://codeload.github.com/org/mono/tar.gz/HEAD': {
          body: tarball,
        },
      });

      const res = await fetchSourceTree(parseOnlineSource('github:org/mono:packages/cli'), {
        transport,
      });

      expect(res.sourceRef).toEqual({
        type: 'github',
        owner: 'org',
        repo: 'mono',
        ref: 'HEAD',
        subdir: 'packages/cli',
      });
      expect(res.tree.entries.map((e) => e.path)).toEqual(['package.json', 'src/index.ts']);
    });

    it('refuses when subdir is not found in archive', async () => {
      const tarball = makeTarball([{ name: 'README.md', content: '# repo\n' }]);

      const transport = createMockTransport({
        'https://codeload.github.com/org/mono/tar.gz/HEAD': {
          body: tarball,
        },
      });

      await expect(
        fetchSourceTree(parseOnlineSource('github:org/mono:missing/dir'), {
          transport,
        }),
      ).rejects.toThrow(/does not hold the subdirectory/);
    });
  });

  describe('url sources', () => {
    it('fetches https tarball from URL and records host', async () => {
      const tarball = makeTarball([{ name: 'SKILL.md', content: '# custom url\n' }]);
      const reportedHosts: string[] = [];

      const transport = createMockTransport({
        'https://cdn.example.org/downloads/skill-v1.tgz': {
          body: tarball,
        },
      });

      const res = await fetchSourceTree(
        parseOnlineSource('https://cdn.example.org/downloads/skill-v1.tgz'),
        {
          transport,
          onHost: (h) => reportedHosts.push(h),
        },
      );

      expect(reportedHosts).toEqual(['cdn.example.org']);
      expect(res.sourceRef).toEqual({
        type: 'url',
        host: 'cdn.example.org',
      });
      expect(res.tree.entries.map((e) => e.path)).toEqual(['SKILL.md']);
    });
  });

  describe('redirects and security policy', () => {
    it('follows up to 3 redirects within the source host allowlist', async () => {
      const tarball = makeTarball([{ name: 'SKILL.md' }]);

      const transport = createMockTransport({
        'https://example.com/one.tgz': {
          status: 302,
          headers: { location: 'https://example.com/two.tgz' },
        },
        'https://example.com/two.tgz': {
          status: 307,
          headers: { location: 'https://example.com/three.tgz' },
        },
        'https://example.com/three.tgz': {
          status: 301,
          headers: { location: 'https://example.com/final.tgz' },
        },
        'https://example.com/final.tgz': {
          body: tarball,
        },
      });

      const res = await fetchSourceTree(parseOnlineSource('https://example.com/one.tgz'), {
        transport,
      });
      expect(res.sourceRef.type).toBe('url');
    });

    it('refuses when redirect exceeds 3 hops', async () => {
      const transport = createMockTransport({
        'https://example.com/1.tgz': {
          status: 302,
          headers: { location: 'https://example.com/2.tgz' },
        },
        'https://example.com/2.tgz': {
          status: 302,
          headers: { location: 'https://example.com/3.tgz' },
        },
        'https://example.com/3.tgz': {
          status: 302,
          headers: { location: 'https://example.com/4.tgz' },
        },
        'https://example.com/4.tgz': {
          status: 302,
          headers: { location: 'https://example.com/5.tgz' },
        },
      });

      await expect(
        fetchSourceTree(parseOnlineSource('https://example.com/1.tgz'), { transport }),
      ).rejects.toThrow(/too many redirects/);
    });

    it('refuses when redirect leaves the source host allowlist', async () => {
      const transport = createMockTransport({
        'https://example.com/file.tgz': {
          status: 302,
          headers: { location: 'https://different.example.org/file.tgz' },
        },
      });

      await expect(
        fetchSourceTree(parseOnlineSource('https://example.com/file.tgz'), { transport }),
      ).rejects.toThrow(/not in the source allowlist/);
    });

    it('refuses when redirect attempts plain http', async () => {
      const transport = createMockTransport({
        'https://example.com/file.tgz': {
          status: 302,
          headers: { location: 'http://example.com/file.tgz' },
        },
      });

      await expect(
        fetchSourceTree(parseOnlineSource('https://example.com/file.tgz'), { transport }),
      ).rejects.toThrow(/https only/);
    });

    it('refuses when compressed download exceeds 20 MiB limit', async () => {
      const bigBuffer = new Uint8Array(LIMITS.maxCompressed + 1024);

      const transport = createMockTransport({
        'https://example.com/huge.tgz': {
          body: bigBuffer,
        },
      });

      await expect(
        fetchSourceTree(parseOnlineSource('https://example.com/huge.tgz'), { transport }),
      ).rejects.toThrow(/compressed archive is over 20971520 bytes/);
    });
  });
});
