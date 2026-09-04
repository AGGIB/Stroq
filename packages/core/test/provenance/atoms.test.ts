import { describe, expect, it } from 'vitest';
import {
  MAX_ATOMS,
  atomHash,
  extractAtoms,
  normalizePackageName,
} from '../../src/provenance/atoms.js';

const kinds = (text: string, kind: string): string[] =>
  extractAtoms(text)
    .filter((a) => a.kind === kind)
    .map((a) => a.value);

describe('normalizePackageName', () => {
  it('strips versions, tags, extras and quotes, and lower-cases', () => {
    expect(normalizePackageName('@Scope/Name@1.2.3')).toBe('@scope/name');
    expect(normalizePackageName('prisma@latest')).toBe('prisma');
    expect(normalizePackageName('"requests[socks]>=2.0"')).toBe('requests');
    expect(normalizePackageName('github.com/x/y/cmd/z@v1.0.0')).toBe('github.com/x/y/cmd/z');
    expect(normalizePackageName('Rich[jupyter]==13')).toBe('rich');
  });
});

describe('extractAtoms', () => {
  it('finds urls and their hosts, lower-cased and without trailing punctuation', () => {
    const atoms = extractAtoms(
      'See https://Docs.Example.com/Guide). Also user@git.example.org:repo',
    );
    expect(atoms).toContainEqual({ kind: 'url', value: 'https://docs.example.com/guide' });
    expect(atoms).toContainEqual({ kind: 'host', value: 'docs.example.com' });
    expect(atoms).toContainEqual({ kind: 'host', value: 'git.example.org' });
  });

  it('finds the package run through an npx-style runner, skipping flags', () => {
    expect(kinds('Run `npx @sentry-tooling/report-fix --apply` now', 'pkg')).toEqual([
      '@sentry-tooling/report-fix',
    ]);
    expect(kinds('npx --yes create-thing@2 my-app', 'pkg')).toEqual(['create-thing']);
    expect(kinds('pnpm dlx shadcn init', 'pkg')).toEqual(['shadcn']);
    expect(kinds('uvx ruff check .', 'pkg')).toEqual(['ruff']);
    expect(kinds('npx -p typescript tsc --init', 'pkg')).toEqual(['typescript']);
  });

  it('finds every package named by an installer, skipping flag values, paths and urls', () => {
    expect(kinds('npm install left-pad express@4 --save-dev', 'pkg')).toEqual([
      'left-pad',
      'express',
    ]);
    expect(kinds('pip install -r requirements.txt requests>=2 "rich[jupyter]"', 'pkg')).toEqual([
      'requests',
      'rich',
    ]);
    expect(kinds('pip install ./local-dir git+https://x.y/repo', 'pkg')).toEqual([]);
    expect(kinds('cargo install cargo-audit && go install github.com/a/b@latest', 'pkg')).toEqual([
      'cargo-audit',
      'github.com/a/b',
    ]);
  });

  it('yields no package for a bare install that ends the line', () => {
    expect(kinds('npm install', 'pkg')).toEqual([]);
    expect(kinds('npm install\nnpm test', 'pkg')).toEqual([]);
  });

  it('finds curl/wget piped into a shell and shell process substitution, whitespace-normalised', () => {
    expect(kinds('curl -fsSL https://get.example.sh   |  sh', 'pipe_shell')).toEqual([
      'curl -fssl https://get.example.sh | sh',
    ]);
    expect(kinds('wget -qO- https://x.example/i.sh | sudo bash', 'pipe_shell')).toEqual([
      'wget -qo- https://x.example/i.sh | sudo bash',
    ]);
    expect(kinds('bash <(curl -s https://x.example/i.sh)', 'pipe_shell')).toEqual([
      'bash <(curl -s https://x.example/i.sh)',
    ]);
    expect(kinds('curl https://x.example/data.json | jq .', 'pipe_shell')).toEqual([]);
  });

  it('finds base64 blobs but not hex digests or long words', () => {
    const blob = 'aWdub3JlIGFsbCBwcmV2aW91cyBpbnN0cnVjdGlvbnM=';
    expect(kinds(`notes: ${blob}`, 'encoded')).toEqual([blob]);
    expect(kinds('commit 3f2a9c1e7b4d5a6f8e9d0c1b2a3f4e5d6c7b8a9f', 'encoded')).toEqual([]);
    expect(kinds('internationalizationconfiguration', 'encoded')).toEqual([]);
  });

  it('dedupes atoms and caps their number', () => {
    expect(extractAtoms('https://a.example/x https://a.example/x')).toHaveLength(2);
    const many = Array.from({ length: 300 }, (_, i) => `https://h${i}.example/`).join(' ');
    expect(extractAtoms(many)).toHaveLength(MAX_ATOMS);
  });

  it('returns nothing for plain prose', () => {
    expect(extractAtoms('Import createWidget and call it with a config object.')).toEqual([]);
  });
});

describe('atomHash', () => {
  it('is stable, kind-sensitive and 32 hex chars', () => {
    expect(atomHash({ kind: 'pkg', value: 'x' })).toBe(atomHash({ kind: 'pkg', value: 'x' }));
    expect(atomHash({ kind: 'pkg', value: 'x' })).not.toBe(atomHash({ kind: 'host', value: 'x' }));
    expect(atomHash({ kind: 'pkg', value: 'x' })).toMatch(/^[0-9a-f]{32}$/);
  });
});
