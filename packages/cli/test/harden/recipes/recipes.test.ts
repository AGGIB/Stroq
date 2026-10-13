import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTargetText } from '../../../src/harden/atomic.js';
import { planJsonEdits } from '../../../src/harden/json-edit.js';
import { planTextBlock } from '../../../src/harden/textblock.js';
import { CLAUDE_READ_DENY_RULES } from '../../../src/harden/recipes/credential-paths.js';
import { claudeReadDeny } from '../../../src/harden/recipes/claude-read-deny.js';
import { cursorIgnore } from '../../../src/harden/recipes/cursor-ignore.js';
import {
  RECIPES,
  findRecipe,
  recipeForAgent,
  type RecipeTarget,
} from '../../../src/harden/recipes/index.js';
import { removeTempDirs, tempDir } from '../helpers.js';

afterEach(removeTempDirs);

/** The settings file `claude-read-deny` makes of an empty folder, written out in full. */
const GOLDEN_SETTINGS = `{
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.config/gcloud/**)",
      "Read(~/.config/gh/hosts.yml)",
      "Read(~/.kube/**)",
      "Read(~/.docker/config.json)",
      "Read(~/.npmrc)",
      "Read(~/.netrc)",
      "Read(~/.pgpass)",
      "Read(~/.git-credentials)",
      "Read(~/.gnupg/**)"
    ]
  }
}
`;

const GOLDEN_SNIPPET = `"permissions": {
  "deny": [
    "Read(./.env)",
    "Read(./.env.*)",
    "Read(~/.ssh/**)",
    "Read(~/.aws/**)",
    "Read(~/.config/gcloud/**)",
    "Read(~/.config/gh/hosts.yml)",
    "Read(~/.kube/**)",
    "Read(~/.docker/config.json)",
    "Read(~/.npmrc)",
    "Read(~/.netrc)",
    "Read(~/.pgpass)",
    "Read(~/.git-credentials)",
    "Read(~/.gnupg/**)"
  ]
}`;

function jsonChange(target: RecipeTarget) {
  if (target.change.kind !== 'json') throw new Error('expected a JSON change');
  return target.change;
}

function blockChange(target: RecipeTarget) {
  if (target.change.kind !== 'text-block') throw new Error('expected a text block');
  return target.change;
}

describe('claude-read-deny', () => {
  it('belongs to Claude Code and says what it is', () => {
    expect(claudeReadDeny.name).toBe('claude-read-deny');
    expect(claudeReadDeny.agent).toBe('claude-code');
    expect(claudeReadDeny.scopes).toEqual(['user', 'project']);
    expect(claudeReadDeny.defaultScope).toBe('user');
  });

  it('edits the user settings file at user scope, inside the home', () => {
    const target = claudeReadDeny.target({ cwd: '/work/app', home: '/home/me', scope: 'user' });
    expect(target.file).toBe(join('/home/me', '.claude', 'settings.json'));
    expect(target.root).toBe('/home/me');
    expect(target.scope).toBe('user');
    expect(target.agent).toBe('claude-code');
    expect(target.recipe).toBe('claude-read-deny');
  });

  it('edits the local project settings file at project scope, inside the project', () => {
    const target = claudeReadDeny.target({ cwd: '/work/app', home: '/home/me', scope: 'project' });
    expect(target.file).toBe(join('/work/app', '.claude', 'settings.local.json'));
    expect(target.root).toBe('/work/app');
    expect(target.scope).toBe('project');
  });

  it('asks for one array-add per rule, in order, to permissions.deny', () => {
    const target = claudeReadDeny.target({ cwd: '/w', home: '/h', scope: 'user' });
    expect(jsonChange(target).edits).toEqual(
      CLAUDE_READ_DENY_RULES.map((value) => ({
        kind: 'json-array-add',
        path: ['permissions', 'deny'],
        value,
      })),
    );
    expect(target.items).toEqual(CLAUDE_READ_DENY_RULES);
  });

  it('makes exactly the golden settings file when there is none', () => {
    const dir = tempDir('golden');
    const target = claudeReadDeny.target({ cwd: dir, home: dir, scope: 'project' });
    const plan = planJsonEdits(target.file, jsonChange(target).edits, {
      read: readTargetText,
      recipe: target.recipe,
      root: target.root,
    });
    expect(plan.refused).toBeUndefined();
    expect(plan.after).toBe(GOLDEN_SETTINGS);
  });

  it('keeps every other setting, and the rules the file already has, exactly as they were', () => {
    const dir = tempDir('merge');
    mkdirSync(join(dir, '.claude'));
    const file = join(dir, '.claude', 'settings.local.json');
    writeFileSync(
      file,
      `{\n  "model": "opus",\n  "permissions": {\n    "allow": ["Bash(ls)"],\n    "deny": ["Bash(rm:*)", "Read(~/.npmrc)"]\n  }\n}\n`,
    );
    const target = claudeReadDeny.target({ cwd: dir, home: dir, scope: 'project' });

    const plan = planJsonEdits(file, jsonChange(target).edits, {
      read: readTargetText,
      recipe: target.recipe,
      root: target.root,
    });

    const after = JSON.parse(plan.after) as {
      model: string;
      permissions: { allow: string[]; deny: string[] };
    };
    expect(after.model).toBe('opus');
    expect(after.permissions.allow).toEqual(['Bash(ls)']);
    // Theirs first and untouched; ours after, with the one they had not repeated.
    expect(after.permissions.deny.slice(0, 2)).toEqual(['Bash(rm:*)', 'Read(~/.npmrc)']);
    expect(after.permissions.deny.filter((rule) => rule === 'Read(~/.npmrc)')).toHaveLength(1);
    expect(after.permissions.deny).toHaveLength(2 + CLAUDE_READ_DENY_RULES.length - 1);
    const kept = plan.edits.filter((edit) => edit.kind === 'json-array-add' && edit.preexisting);
    expect(kept.map((edit) => edit.value)).toEqual(['Read(~/.npmrc)']);
  });

  it('gives the snippet to add by hand, which is the same rules and nothing from the file', () => {
    const target = claudeReadDeny.target({ cwd: '/w', home: '/h', scope: 'user' });
    expect(jsonChange(target).snippet).toBe(GOLDEN_SNIPPET);
  });

  it('says what it does and what it does not, in plain sentences', () => {
    const target = claudeReadDeny.target({ cwd: '/w', home: '/h', scope: 'user' });
    const said = target.limits.join('\n');
    expect(said).toMatch(/refuse.*Read tool/);
    expect(said).toMatch(/cat/);
    expect(said).toMatch(/not a guarantee/);
    expect(said).toMatch(/python -c/);
    expect(said).toMatch(/sandbox/);
    expect(target.unverified).toBeNull();
    for (const line of target.limits) expect(line).not.toMatch(/[^\x20-\x7e]/);
  });
});

describe('cursor-ignore', () => {
  it('belongs to Cursor and works on the project only', () => {
    expect(cursorIgnore.name).toBe('cursor-ignore');
    expect(cursorIgnore.agent).toBe('cursor');
    expect(cursorIgnore.scopes).toEqual(['project']);
    expect(cursorIgnore.defaultScope).toBe('project');
  });

  it('writes a block into .cursorignore in the project', () => {
    const target = cursorIgnore.target({ cwd: '/work/app', home: '/home/me', scope: 'project' });
    expect(target.file).toBe(join('/work/app', '.cursorignore'));
    expect(target.root).toBe('/work/app');
    expect(blockChange(target)).toEqual({
      kind: 'text-block',
      id: 'cursor-ignore',
      lines: ['.env', '.env.*'],
    });
    expect(target.items).toEqual(['.env', '.env.*']);
  });

  it('makes exactly the golden block when there is no file', () => {
    const dir = tempDir('ignore');
    const target = cursorIgnore.target({ cwd: dir, home: dir, scope: 'project' });
    const change = blockChange(target);
    const plan = planTextBlock(
      target.file,
      { id: change.id, lines: change.lines },
      { read: readTargetText, recipe: target.recipe, root: target.root },
    );
    expect(plan.after).toBe(
      '# >>> stroq harden: cursor-ignore >>>\n.env\n.env.*\n# <<< stroq harden: cursor-ignore <<<\n',
    );
  });

  it('keeps what the owner wrote and adds the block after it', () => {
    const dir = tempDir('ignore-merge');
    writeFileSync(join(dir, '.cursorignore'), 'dist/\nnode_modules/\n');
    const target = cursorIgnore.target({ cwd: dir, home: dir, scope: 'project' });
    const change = blockChange(target);
    const plan = planTextBlock(
      target.file,
      { id: change.id, lines: change.lines },
      { read: readTargetText, recipe: target.recipe, root: target.root },
    );
    expect(plan.after).toBe(
      'dist/\nnode_modules/\n\n# >>> stroq harden: cursor-ignore >>>\n.env\n.env.*\n# <<< stroq harden: cursor-ignore <<<\n',
    );
  });

  it('says in one plain sentence that it could not be checked against Cursor', () => {
    const target = cursorIgnore.target({ cwd: '/w', home: '/h', scope: 'project' });
    expect(target.unverified).toMatch(/not (?:been able to )?(?:test|check|verif)/i);
    expect(target.unverified).toMatch(/Cursor/);
    expect(target.unverified?.split(/(?<=\.)\s/)).toHaveLength(1);
    expect(target.unverified).not.toMatch(/[^\x20-\x7e]/);
  });
});

describe('the recipes together', () => {
  it('are the two, found by name and by agent', () => {
    expect(RECIPES.map((recipe) => recipe.name)).toEqual(['claude-read-deny', 'cursor-ignore']);
    expect(findRecipe('claude-read-deny')).toBe(claudeReadDeny);
    expect(findRecipe('cursor-ignore')).toBe(cursorIgnore);
    expect(findRecipe('nothing')).toBeUndefined();
    expect(recipeForAgent('claude-code')).toBe(claudeReadDeny);
    expect(recipeForAgent('cursor')).toBe(cursorIgnore);
    expect(recipeForAgent('codex')).toBeUndefined();
  });

  it('does not find a recipe through a name every object has', () => {
    expect(findRecipe('constructor')).toBeUndefined();
    expect(findRecipe('__proto__')).toBeUndefined();
    expect(recipeForAgent('toString')).toBeUndefined();
  });
});
