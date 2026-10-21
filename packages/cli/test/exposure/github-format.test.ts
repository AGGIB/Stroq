import { describe, expect, it } from 'vitest';
import type { TaggedHit } from '../../src/exposure/agent-change.js';
import { hit, type AgentKind } from '../../src/exposure/agent-kinds.js';
import {
  MAX_ANNOTATIONS,
  annotations,
  escapeData,
  escapeProperty,
  githubSummary,
} from '../../src/exposure/github-format.js';

const tagged = (
  kind: AgentKind,
  name: string,
  value: string,
  status: TaggedHit['status'] = 'new',
  file = '.claude/settings.json',
): TaggedHit => ({ ...hit(kind, file, 4, name, value), status });

describe('escaping, exactly as the GitHub Actions toolkit does it', () => {
  it('escapes %, CR and LF in data', () => {
    expect(escapeData('100% done\r\nnext')).toBe('100%25 done%0D%0Anext');
  });

  it('also escapes : and , in a property', () => {
    expect(escapeProperty('a:b,c%d\n')).toBe('a%3Ab%2Cc%25d%0A');
  });
});

describe('annotations', () => {
  it('writes one line per finding, failing ones as errors', () => {
    const lines = annotations(
      [tagged('agent-hook', 'SessionStart', 'node .vscode/setup.mjs')],
      'new',
    );
    expect(lines).toEqual([
      '::error file=.claude/settings.json,line=4,title=stroq inspect%3A agent-hook::new: SessionStart hook runs: node .vscode/setup.mjs',
    ]);
  });

  it('writes at most ten, the failing ones first, and none for what was already there', () => {
    const many = [
      ...Array.from({ length: 12 }, (_, i) => tagged('mcp-server', `s${i}`, 'npx s')),
      tagged('agent-hook', 'Stop', './old.sh', 'present'),
      tagged('agent-hook', 'Stop', './x.sh'),
    ];
    const lines = annotations(many, 'new');
    expect(lines).toHaveLength(MAX_ANNOTATIONS);
    expect(lines[0]).toMatch(/^::error /);
    expect(lines.slice(1).every((l) => l.startsWith('::warning '))).toBe(true);
    expect(lines.join('\n')).not.toContain('old.sh');
  });

  // Every value comes from the repository, which is the attacker's. A value must never start a
  // line of its own, close the properties early, or decode back into a newline.
  it('keeps hostile values inside their own line', () => {
    const hostile = [
      'x\n::error file=README.md::forged',
      'y\r::add-mask::secret',
      'z %0A::warning::decoded',
      '\u001b[2J\u001b]52;c;aGk=\u0007',
      'w'.repeat(10_000),
      '::stop-commands::token',
    ];
    const lines = annotations(
      hostile.map((value, i) =>
        tagged('agent-hook', `E${i}\n::x`, value, 'new', `.github/hooks/a,b:${i}\n.json`),
      ),
      'new',
    );
    expect(lines).toHaveLength(hostile.length);
    for (const line of lines) {
      expect(line).not.toMatch(/[\r\n\u001b\u0007]/);
      expect(line.length).toBeLessThan(800);
      const [, properties = ''] = /^::error ([^:]*)::/.exec(line) ?? [];
      expect(properties.split(',').map((p) => p.split('=')[0])).toEqual(['file', 'line', 'title']);
    }
    expect(lines[2]).toContain('%250A');
  });
});

describe('githubSummary', () => {
  const hits = [
    tagged('agent-hook', 'SessionStart', 'node .vscode/setup.mjs'),
    tagged('mcp-server', 'docs', 'npx -y docs-mcp', 'new', '.mcp.json'),
    tagged('agent-hook', 'PreToolUse', 'npx stroq hook claude-code', 'present'),
    tagged('instruction-file', 'content', 'sha256:00', 'present', 'CLAUDE.md'),
  ];

  it('says the result first, then what fails, what to review and what was already there', () => {
    const text = githubSummary(hits, {
      failOn: 'new',
      changedFrom: 'HEAD^1',
      base: 'a'.repeat(40),
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('### stroq inspect');
    expect(text).toContain('**Fails.** 1 new entry takes effect by itself');
    expect(text.indexOf('#### Fails')).toBeLessThan(text.indexOf('#### To review'));
    expect(text.indexOf('#### To review')).toBeLessThan(text.indexOf('#### Already there'));
    expect(text).toContain('`aaaaaaaaaaaa`');
    expect(text).not.toContain('CLAUDE.md');
  });

  // 437 instruction-file notices in 96 of 600 routine commits of 30 public repositories: an
  // edit to a dozen skills must not bury the one entry that runs something.
  it('lists changed instruction files by name only, apart from what runs', () => {
    const skills = Array.from({ length: 12 }, (_, i) =>
      tagged(
        'instruction-file',
        'content',
        `sha256:${i}`,
        'changed',
        `.claude/skills/s${i}/SKILL.md`,
      ),
    );
    const text = githubSummary(skills, {
      failOn: 'new',
      changedFrom: 'main',
      base: 'd'.repeat(40),
    });
    expect(text).toContain('**Passes.** Nothing in this change runs by itself');
    expect(text).not.toContain('#### To review');
    expect(text).toContain('#### Instruction files new or changed (12, not failing)');
    expect(text.split('\n').filter((l) => l.includes('SKILL.md'))).toHaveLength(1);
  });

  it('passes plainly when nothing came with the change', () => {
    const text = githubSummary([], { failOn: 'new', changedFrom: 'main', base: 'b'.repeat(40) });
    expect(text).toContain('**Passes.**');
  });

  it('keeps markdown, mentions and HTML from the repository inert', () => {
    const evil = tagged(
      'agent-hook',
      'Stop` **bold** @org/team',
      '`x` [link](https://evil.invalid) <img src=x> ![p](https://evil.invalid/p.png)\n# heading',
      'new',
      'a`b|c.json',
    );
    const text = githubSummary([evil], {
      failOn: 'new',
      changedFrom: 'main',
      base: 'c'.repeat(40),
    });
    const line = text.split('\n').find((l) => l.includes('Stop')) ?? '';
    // Every piece of repository text sits in a code span with no backtick of its own inside it.
    const outside = line.replace(/`[^`]*`/g, '');
    expect(outside).not.toMatch(/@org|\[link\]|<img|!\[|\*\*bold/);
    expect(text).not.toMatch(/\n# heading/);
  });
});
