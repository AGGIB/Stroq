import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomsForAction, knownPackages, originClasses } from '../../src/provenance/action-atoms.js';
import type { AtomKind, ProvenanceHit } from '../../src/types.js';

const project = (): string => mkdtempSync(join(tmpdir(), 'stroq-proj-'));
const hit = (kind: AtomKind, suspect = false): ProvenanceHit => ({
  atom: { kind, value: 'v' },
  record: {
    seq: 1,
    at: '2026-09-04T00:00:00.000Z',
    tool: 'Read',
    source: 'README.md',
    kind,
    hash: 'h',
    excerpt: 'v',
    suspect,
  },
});

describe('knownPackages', () => {
  it('collects dependency names, the project name, installed bins and python requirements', () => {
    const cwd = project();
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({
        name: 'my-app',
        dependencies: { express: '^4' },
        devDependencies: { typescript: '5' },
      }),
    );
    mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', '.bin', 'tsc'), '');
    writeFileSync(
      join(cwd, 'requirements.txt'),
      '# deps\nrequests>=2\n-r other.txt\nRich[jupyter]==13\n',
    );
    writeFileSync(join(cwd, 'pyproject.toml'), 'dependencies = ["httpx>=0.27", "typer"]\n');
    const known = knownPackages(cwd);
    for (const name of [
      'my-app',
      'express',
      'typescript',
      'tsc',
      'requests',
      'rich',
      'httpx',
      'typer',
    ])
      expect(known.has(name)).toBe(true);
    expect(known.has('r')).toBe(false);
    expect(known.has('other.txt')).toBe(false);
  });

  it('is empty for a directory without manifests and tolerates a broken package.json', () => {
    expect(knownPackages(project()).size).toBe(0);
    const cwd = project();
    writeFileSync(join(cwd, 'package.json'), '{broken');
    expect(knownPackages(cwd).size).toBe(0);
  });

  it('tolerates package.json that parses to a non-object', () => {
    for (const content of ['null', '[]', '42']) {
      const cwd = project();
      writeFileSync(join(cwd, 'package.json'), content);
      expect(knownPackages(cwd).size).toBe(0);
    }
  });

  it('ignores pyproject strings that are not dependencies', () => {
    const cwd = project();
    writeFileSync(
      join(cwd, 'pyproject.toml'),
      [
        '[project]',
        'name = "myapp"',
        'version = "1.0.0"',
        'readme = "README.md"',
        'license = "MIT"',
        'requires-python = ">=3.9"',
        'dependencies = ["httpx>=0.27", "typer"]',
        '',
        '[project.optional-dependencies]',
        'dev = ["pytest>=7.0", "ruff"]',
        '',
      ].join('\n'),
    );
    const known = knownPackages(cwd);
    for (const name of ['httpx', 'typer', 'pytest', 'ruff']) expect(known.has(name)).toBe(true);
    for (const name of ['myapp', '1.0.0', 'readme.md', 'mit']) expect(known.has(name)).toBe(false);
  });
});

describe('atomsForAction', () => {
  it('extracts atoms from a Bash command and drops packages the project already knows', () => {
    const cwd = project();
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ devDependencies: { prisma: '5' } }));
    expect(atomsForAction('Bash', { command: 'npx prisma migrate dev' }, cwd)).toEqual([]);
    expect(atomsForAction('Bash', { command: 'npx @evil/pkg --run' }, cwd)).toEqual([
      { kind: 'pkg', value: '@evil/pkg' },
    ]);
  });

  it('extracts atoms from MCP arguments and nothing from other tools', () => {
    expect(
      atomsForAction('mcp__github__create_issue', { body: 'see https://x.example/p' }, project()),
    ).toEqual([
      { kind: 'url', value: 'https://x.example/p' },
      { kind: 'host', value: 'x.example' },
    ]);
    expect(atomsForAction('Read', { file_path: 'https://x.example/p' }, project())).toEqual([]);
    expect(atomsForAction('WebFetch', { url: 'https://x.example/p' }, project())).toEqual([]);
    expect(atomsForAction('Bash', {}, project())).toEqual([]);
  });
});

describe('originClasses', () => {
  it('counts package, pipe-to-shell and encoded hits regardless of action classes', () => {
    expect(originClasses([hit('pkg')], []).classes).toEqual(['origin.untrusted']);
    expect(originClasses([hit('pipe_shell')], []).classes).toEqual(['origin.untrusted']);
    expect(originClasses([hit('encoded')], []).classes).toEqual(['origin.untrusted']);
  });

  it('counts url and host hits only for network-shaped actions', () => {
    expect(originClasses([hit('url')], []).classes).toEqual([]);
    expect(originClasses([hit('host')], ['network.fetch']).classes).toEqual([]);
    expect(originClasses([hit('url')], ['shell.network']).classes).toEqual(['origin.untrusted']);
    expect(originClasses([hit('host')], ['git.push_external']).classes).toEqual([
      'origin.untrusted',
    ]);
    expect(originClasses([hit('url')], ['shell.exec_encoded']).classes).toEqual([
      'origin.untrusted',
    ]);
  });

  it('adds origin.suspect when any counted hit came from flagged content', () => {
    const r = originClasses([hit('pkg'), hit('pkg', true)], []);
    expect(r.classes).toEqual(['origin.untrusted', 'origin.suspect']);
    expect(r.counted).toHaveLength(2);
    expect(originClasses([hit('url', true)], []).classes).toEqual([]);
    expect(originClasses([], ['shell.network'])).toEqual({ classes: [], counted: [] });
  });
});
