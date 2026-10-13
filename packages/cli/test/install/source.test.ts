import { describe, expect, it } from 'vitest';
import { isHostName, parseOnlineSource, SourceSyntaxError } from '../../src/install/source.js';

describe('isHostName', () => {
  it('accepts valid domain names', () => {
    expect(isHostName('registry.npmjs.org')).toBe(true);
    expect(isHostName('codeload.github.com')).toBe(true);
    expect(isHostName('example.com')).toBe(true);
    expect(isHostName('sub.domain.example.co.uk')).toBe(true);
  });

  it('rejects localhost', () => {
    expect(isHostName('localhost')).toBe(false);
  });

  it('rejects IPv4 addresses in dotted and hex formats', () => {
    expect(isHostName('127.0.0.1')).toBe(false);
    expect(isHostName('192.168.1.1')).toBe(false);
    expect(isHostName('0x7f000001')).toBe(false);
    expect(isHostName('10.0.0.1')).toBe(false);
  });

  it('rejects host names exceeding 253 characters or with labels over 63 characters', () => {
    expect(isHostName('a'.repeat(64) + '.com')).toBe(false);
    expect(isHostName(('a'.repeat(50) + '.').repeat(6))).toBe(false);
  });
});

describe('parseOnlineSource', () => {
  describe('npm sources', () => {
    it('parses unscoped packages with and without versions', () => {
      expect(parseOnlineSource('npm:lodash')).toEqual({
        type: 'npm',
        name: 'lodash',
        version: 'latest',
      });
      expect(parseOnlineSource('npm:lodash@4.17.21')).toEqual({
        type: 'npm',
        name: 'lodash',
        version: '4.17.21',
      });
      expect(parseOnlineSource('npm:react@next')).toEqual({
        type: 'npm',
        name: 'react',
        version: 'next',
      });
    });

    it('parses scoped packages with and without versions', () => {
      expect(parseOnlineSource('npm:@types/node')).toEqual({
        type: 'npm',
        name: '@types/node',
        version: 'latest',
      });
      expect(parseOnlineSource('npm:@types/node@24.19.2')).toEqual({
        type: 'npm',
        name: '@types/node',
        version: '24.19.2',
      });
      expect(parseOnlineSource('npm:@modelcontextprotocol/sdk@1.0.0')).toEqual({
        type: 'npm',
        name: '@modelcontextprotocol/sdk',
        version: '1.0.0',
      });
    });

    it('parses packages with uppercase letters such as JSONStream', () => {
      expect(parseOnlineSource('npm:JSONStream')).toEqual({
        type: 'npm',
        name: 'JSONStream',
        version: 'latest',
      });
      expect(parseOnlineSource('npm:JSONStream@1.3.5')).toEqual({
        type: 'npm',
        name: 'JSONStream',
        version: '1.3.5',
      });
      expect(parseOnlineSource('npm:@Scope/Package@1.0.0')).toEqual({
        type: 'npm',
        name: '@Scope/Package',
        version: '1.0.0',
      });
    });

    it('refuses malformed npm package names and versions', () => {
      expect(() => parseOnlineSource('npm:')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('npm:@types')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('npm:../bad')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('npm:a..b')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('npm:@scope/a..b')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('npm:@..scope/pkg')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('npm:pkg with space')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('npm:pkg/nested/slash')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('npm:pkg@')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('npm:pkg@1.0/2')).toThrow(SourceSyntaxError);
    });
  });

  describe('github sources', () => {
    it('parses owner/repo with default HEAD ref', () => {
      expect(parseOnlineSource('github:AGGIB/Stroq')).toEqual({
        type: 'github',
        owner: 'AGGIB',
        repo: 'Stroq',
        ref: 'HEAD',
      });
    });

    it('parses ref tag or branch', () => {
      expect(parseOnlineSource('github:AGGIB/Stroq#v0.25.0')).toEqual({
        type: 'github',
        owner: 'AGGIB',
        repo: 'Stroq',
        ref: 'v0.25.0',
      });
      expect(parseOnlineSource('github:AGGIB/Stroq#main')).toEqual({
        type: 'github',
        owner: 'AGGIB',
        repo: 'Stroq',
        ref: 'main',
      });
    });

    it('identifies 40-hex commit ref', () => {
      const commit = '11477cb31c3413cfd29f8c14d9980a37e1994625';
      expect(parseOnlineSource(`github:AGGIB/Stroq#${commit}`)).toEqual({
        type: 'github',
        owner: 'AGGIB',
        repo: 'Stroq',
        ref: commit,
        commit,
      });
    });

    it('parses subdir with and without ref', () => {
      expect(parseOnlineSource('github:AGGIB/Stroq:packages/cli')).toEqual({
        type: 'github',
        owner: 'AGGIB',
        repo: 'Stroq',
        ref: 'HEAD',
        subdir: 'packages/cli',
      });
      expect(parseOnlineSource('github:AGGIB/Stroq#v1.0:packages/cli')).toEqual({
        type: 'github',
        owner: 'AGGIB',
        repo: 'Stroq',
        ref: 'v1.0',
        subdir: 'packages/cli',
      });
    });

    it('refuses invalid owner, repo, ref, and subdirs', () => {
      expect(() => parseOnlineSource('github:')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('github:onlyowner')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('github:bad owner/repo')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('github:owner/repo.git')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('github:owner/repo#')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('github:owner/repo:../outside')).toThrow(SourceSyntaxError);
      expect(() => parseOnlineSource('github:owner/repo:/absolute')).toThrow(SourceSyntaxError);
    });
  });

  describe('url sources', () => {
    it('accepts valid https URLs ending with supported tar archive extensions', () => {
      const res1 = parseOnlineSource('https://example.com/downloads/package.tgz');
      expect(res1.type).toBe('url');
      if (res1.type === 'url') {
        expect(res1.host).toBe('example.com');
      }

      const res2 = parseOnlineSource('https://dist.example.org/v1/archive.tar.gz');
      expect(res2.type).toBe('url');
      if (res2.type === 'url') {
        expect(res2.host).toBe('dist.example.org');
      }

      const res3 = parseOnlineSource('https://storage.googleapis.com/bucket/file.tar');
      expect(res3.type).toBe('url');
      if (res3.type === 'url') {
        expect(res3.host).toBe('storage.googleapis.com');
      }
    });

    it('refuses http URLs and non-archive URLs', () => {
      expect(() => parseOnlineSource('http://example.com/file.tgz')).toThrow(/https only/);
      expect(() => parseOnlineSource('https://example.com/file.zip')).toThrow(/tar archive/);
      expect(() => parseOnlineSource('https://example.com/file.json')).toThrow(/tar archive/);
    });

    it('refuses localhost, IP literals, credentials, queries, and non-standard ports', () => {
      expect(() => parseOnlineSource('https://localhost/file.tgz')).toThrow(/localhost/);
      expect(() => parseOnlineSource('https://127.0.0.1/file.tgz')).toThrow(/IP address/);
      expect(() => parseOnlineSource('https://user:pass@example.com/file.tgz')).toThrow(
        /credentials/,
      );
      expect(() => parseOnlineSource('https://example.com:8443/file.tgz')).toThrow(
        /non-standard ports/,
      );
      expect(() => parseOnlineSource('https://example.com/file.tgz?token=abc')).toThrow(
        /query parameters/,
      );
    });
  });

  it('refuses unknown source prefixes', () => {
    expect(() => parseOnlineSource('git@github.com:foo/bar.git')).toThrow(SourceSyntaxError);
    expect(() => parseOnlineSource('file:///local/path')).toThrow(SourceSyntaxError);
    expect(() => parseOnlineSource('something-else')).toThrow(SourceSyntaxError);
  });
});
