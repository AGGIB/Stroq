import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FetchError, fetchSourceTree, type Transport } from '../../src/install/fetch.js';
import { parseOnlineSource, SourceSyntaxError } from '../../src/install/source.js';
import { tarOf } from '../helpers/tar-writer.js';

/**
 * What a fetch will follow and what it will ask for. Every hop of a redirect is held to the host, the
 * scheme, the port and the user information of the first request, and a GitHub ref that would change the
 * path of the request (`.` or `..`, or one with a separator) is refused where the source is read and again
 * where the URL is made. Only injected transports are used: nothing here reaches a network.
 */
const good = gzipSync(
  tarOf([
    { name: 'package/SKILL.md', data: '---\nname: x\n---\n# x\n' },
    { name: 'package/package.json', data: '{"name":"x","version":"1.0.0"}' },
  ]),
);
const integrity = `sha512-${createHash('sha512').update(good).digest('base64')}`;
const meta = JSON.stringify({
  name: 'x',
  version: '1.0.0',
  dist: { tarball: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity },
});

const answer = (
  status: number,
  body: Uint8Array | string,
  headers: Record<string, string> = {},
) => ({
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  body: typeof body === 'string' ? Buffer.from(body) : body,
});

/** A transport that records the URL of every request and answers by `route`. */
function recording(route: (url: URL) => ReturnType<typeof answer>) {
  const requests: string[] = [];
  const transport: Transport = async (url) => {
    requests.push(url.href);
    return route(url);
  };
  return { transport, requests };
}

const redirectedTo = (location: string) =>
  recording((url) =>
    url.pathname.endsWith('.tgz') ? answer(200, good) : answer(302, '', { location }),
  );

async function failure(promise: Promise<unknown>): Promise<FetchError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FetchError);
  return error as FetchError;
}

describe('a redirect is held to the first request', () => {
  it.each([
    ['another port of the same host', '//registry.npmjs.org:8443/y', /port/],
    ['the same host with a port written out', 'https://registry.npmjs.org:444/y', /port/],
    ['user information', 'https://user@registry.npmjs.org/y', /user information/],
    [
      'user information with a password',
      'https://user:secret@registry.npmjs.org/y',
      /user information/,
    ],
    ['an empty user and a password', 'https://:secret@registry.npmjs.org/y', /user information/],
    ['plain http', 'http://registry.npmjs.org/y', /https/],
    ['another scheme', 'ftp://registry.npmjs.org/y', /https/],
    ['another host', 'https://evil.example/y', /allowlist/],
    ['a look-alike host', 'https://registry.npmjs.org.evil.example/y', /allowlist/],
    ['the host with a trailing dot', 'https://registry.npmjs.org./y', /refused|allowlist/],
    ['an IP address', 'https://127.0.0.1/y', /refused/],
  ])('refuses a redirect to %s, and does not make the request', async (_what, location, why) => {
    const { transport, requests } = redirectedTo(location);

    const error = await failure(fetchSourceTree(parseOnlineSource('npm:x@1.0.0'), { transport }));

    expect(error.message).toMatch(why);
    expect(requests).toEqual(['https://registry.npmjs.org/x/1.0.0']);
  });

  it('follows a redirect that stays on the host, without a port or user information', async () => {
    const { transport, requests } = recording((url) => {
      if (url.pathname === '/x/1.0.0') return answer(302, '', { location: '/moved/x/1.0.0' });
      if (url.pathname === '/moved/x/1.0.0') return answer(200, meta);
      return answer(200, good);
    });

    const fetched = await fetchSourceTree(parseOnlineSource('npm:x@1.0.0'), { transport });

    expect(fetched.tree.entries.length).toBe(2);
    expect(requests[1]).toBe('https://registry.npmjs.org/moved/x/1.0.0');
  });

  it('does not repeat what the redirect said in the error', async () => {
    const { transport } = redirectedTo('https://user:hunter2@registry.npmjs.org/y');

    const error = await failure(fetchSourceTree(parseOnlineSource('npm:x@1.0.0'), { transport }));

    expect(error.message).not.toContain('hunter2');
  });

  it('holds a URL source to the same', async () => {
    const { transport, requests } = recording((url) =>
      url.port === ''
        ? answer(302, '', { location: 'https://example.com:8443/b.tgz' })
        : answer(200, good),
    );

    const error = await failure(
      fetchSourceTree(parseOnlineSource('https://example.com/a.tgz'), { transport }),
    );

    expect(error.message).toMatch(/port/);
    expect(requests).toEqual(['https://example.com/a.tgz']);
  });
});

describe('a GitHub ref that would change the path', () => {
  it.each(['.', '..', '../x', 'a/../b', 'a..b', 'feature/x', 'a\\b', '/', 'x/', '/x', '...'])(
    'is refused where the source is read: %j',
    (ref) => {
      expect(() => parseOnlineSource(`github:o/r#${ref}`)).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource(`github:o/r#${ref}`)).toThrow(/ref/);
    },
  );

  it.each([
    'main',
    'v1.2.3',
    'release-1.0',
    'a.b',
    'HEAD',
    'feature_x',
    '0123456789abcdef0123456789abcdef01234567',
  ])('accepts %j', (ref) => {
    expect(parseOnlineSource(`github:o/r#${ref}`)).toMatchObject({ type: 'github', ref });
  });

  it.each(['.', '..', 'a/../b', 'x/y', 'x\\y'])(
    'is refused where the URL is made, for a source that was not read by the parser: %j',
    async (ref) => {
      const { transport, requests } = recording(() => answer(200, good));

      const error = await failure(
        fetchSourceTree({ type: 'github', owner: 'o', repo: 'r', ref }, { transport }),
      );

      expect(error.code).toBe('bad-source');
      expect(requests).toEqual([]);
    },
  );

  it('asks codeload for exactly owner, repo and ref', async () => {
    const { transport, requests } = recording(() => answer(200, good));

    await fetchSourceTree(parseOnlineSource('github:o/r#main'), { transport });

    expect(requests).toEqual(['https://codeload.github.com/o/r/tar.gz/main']);
  });
});
