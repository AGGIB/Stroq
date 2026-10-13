import { describe, expect, it } from 'vitest';
import {
  allowedOptions,
  chooseRecipe,
  chooseSubcommand,
  optionsNotAllowed,
} from '../../src/commands/harden-select.js';

/**
 * Which recipe and which scope a command line asks for, and which words and options it may use. All
 * decided here with nothing read from the disk, so that every refusal has a test of its own.
 */

describe('chooseSubcommand', () => {
  it('is plan when none is given, and plan writes nothing', () => {
    expect(chooseSubcommand([])).toEqual({ ok: true, subcommand: 'plan' });
  });

  it.each(['plan', 'apply', 'undo', 'status'])('knows %s', (word) => {
    expect(chooseSubcommand([word])).toEqual({ ok: true, subcommand: word });
  });

  it('refuses a word it does not know, naming the four it does', () => {
    const result = chooseSubcommand(['forget']);
    expect(result).toMatchObject({ ok: false, code: 2 });
    expect(result.ok ? '' : result.message).toContain('"forget"');
    expect(result.ok ? '' : result.message).toMatch(/plan, apply, undo or status/);
  });

  it('refuses a second word', () => {
    expect(chooseSubcommand(['apply', 'undo'])).toMatchObject({ ok: false, code: 2 });
  });

  it('does not take a name every object has for a subcommand', () => {
    expect(chooseSubcommand(['constructor'])).toMatchObject({ ok: false, code: 2 });
    expect(chooseSubcommand(['__proto__'])).toMatchObject({ ok: false, code: 2 });
  });
});

describe('optionsNotAllowed', () => {
  it('lets plan use the choice of recipe, --json and --acknowledge-link, and nothing that writes', () => {
    expect(allowedOptions('plan')).toEqual([
      'agent',
      'scope',
      'recipe',
      'json',
      'acknowledge-link',
    ]);
    expect(optionsNotAllowed('plan', ['yes'])).toEqual(['yes']);
    expect(optionsNotAllowed('plan', ['acknowledge-credential-loss'])).toEqual([
      'acknowledge-credential-loss',
    ]);
  });

  it('lets apply use every option', () => {
    expect(
      optionsNotAllowed('apply', [
        'agent',
        'scope',
        'recipe',
        'json',
        'yes',
        'acknowledge-link',
        'acknowledge-credential-loss',
        'acknowledge-reformat',
      ]),
    ).toEqual([]);
  });

  it('lets undo name the file and say yes, and nothing else', () => {
    expect(optionsNotAllowed('undo', ['agent', 'scope', 'recipe', 'yes'])).toEqual([]);
    expect(optionsNotAllowed('undo', ['json', 'acknowledge-link'])).toEqual([
      'json',
      'acknowledge-link',
    ]);
  });

  it('lets status use --json only', () => {
    expect(optionsNotAllowed('status', ['json'])).toEqual([]);
    expect(optionsNotAllowed('status', ['agent', 'yes'])).toEqual(['agent', 'yes']);
  });
});

describe('chooseRecipe', () => {
  it('is Claude Code and the user scope when nothing is said', () => {
    const result = chooseRecipe({});
    expect(result).toMatchObject({ ok: true, scope: 'user' });
    expect(result.ok ? result.recipe.name : '').toBe('claude-read-deny');
  });

  it('takes the agent`s recipe', () => {
    const result = chooseRecipe({ agent: 'cursor' });
    expect(result.ok ? result.recipe.name : '').toBe('cursor-ignore');
    expect(result.ok ? result.scope : '').toBe('project');
  });

  it('takes the recipe by name, and the agent from it', () => {
    const result = chooseRecipe({ recipe: 'cursor-ignore' });
    expect(result.ok ? result.recipe.agent : '').toBe('cursor');
  });

  it('accepts an agent and a recipe that go together', () => {
    expect(chooseRecipe({ agent: 'claude-code', recipe: 'claude-read-deny' }).ok).toBe(true);
  });

  it('refuses an agent and a recipe that do not, as a usage error', () => {
    const result = chooseRecipe({ agent: 'cursor', recipe: 'claude-read-deny' });
    expect(result).toMatchObject({ ok: false, code: 2 });
    expect(result.ok ? '' : result.message).toMatch(/claude-read-deny.*claude-code.*cursor/);
  });

  it('refuses a recipe it does not have, naming the ones it has', () => {
    const result = chooseRecipe({ recipe: 'sandbox' });
    expect(result).toMatchObject({ ok: false, code: 2 });
    expect(result.ok ? '' : result.message).toMatch(/claude-read-deny, cursor-ignore/);
  });

  it('refuses an agent that does not exist as a usage error', () => {
    expect(chooseRecipe({ agent: 'emacs' })).toMatchObject({ ok: false, code: 2 });
  });

  it('refuses an agent that exists but has no recipe yet, saying so, and not as a usage error', () => {
    const result = chooseRecipe({ agent: 'codex' });
    expect(result).toMatchObject({ ok: false, code: 1 });
    expect(result.ok ? '' : result.message).toMatch(/no recipe for codex/);
  });

  it('accepts the project scope for Claude Code', () => {
    const result = chooseRecipe({ scope: 'project' });
    expect(result.ok ? result.scope : '').toBe('project');
  });

  it('refuses a scope that is neither, as a usage error', () => {
    expect(chooseRecipe({ scope: 'global' })).toMatchObject({ ok: false, code: 2 });
  });

  it('refuses the user scope for Cursor, which has no user-level ignore file', () => {
    const result = chooseRecipe({ agent: 'cursor', scope: 'user' });
    expect(result).toMatchObject({ ok: false, code: 1 });
    expect(result.ok ? '' : result.message).toMatch(/project only/);
  });
});
