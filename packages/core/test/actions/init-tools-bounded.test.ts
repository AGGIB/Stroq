import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isInitSubstitution } from '../../src/actions/init-tools.js';

describe('zoxide initialization arguments', () => {
  it.each([
    'init zsh',
    'init bash --cmd cd',
    'init fish --hook prompt --no-cmd',
    'init zsh --cmd --hook prompt',
    'init zsh --cmd --hook --no-cmd',
    'init zsh --cmdcd --hookprompt',
    'init zsh --cmd --',
    'init zsh --cmd _name-1.2',
  ])('keeps the previously accepted plain arguments: %s', (args) => {
    expect(isInitSubstitution(`$(zoxide ${args})`)).toBe(true);
  });

  it.each([
    'init',
    'init ZSH',
    'init zsh extra',
    'init zsh --unknown',
    'init zsh --cmd=cd',
    'init zsh --cmdcd extra',
    'init zsh --cmd --hookprompt extra',
    'init zsh --cmd /tmp/custom',
    'init zsh --hook value extra',
    'init zsh --cmd $NAME',
    'init zsh --cmd cd; echo extra',
  ])('does not exempt other arguments from classification: %s', (args) => {
    expect(isInitSubstitution(`$(zoxide ${args})`)).toBe(false);
  });

  it('finishes rejecting long ambiguous argument lists in a bounded process', () => {
    // A subprocess bounds a regression even if one synchronous pattern never returns.
    // This reads a command string only: it never starts zoxide, eval, or a shell.
    const source = new URL('../../src/actions/init-tools.ts', import.meta.url).href;
    const program = `
      const { isInitSubstitution } = await import(process.argv[1]);
      for (const count of [64, 512, 4096]) {
        const text = '$(zoxide init zsh ' + '--cmd '.repeat(count) + ':)';
        if (isInitSubstitution(text)) throw new Error('invalid arguments were accepted');
      }
      process.stdout.write('rejected');
    `;
    expect(
      execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', program, source],
        { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    ).toBe('rejected');
  });
});
