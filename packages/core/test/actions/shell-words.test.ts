import { describe, expect, it } from 'vitest';
import { argv, groupMarks, resolve, withoutRedirects } from '../../src/actions/shell-words.js';
import { globbedCommands, plainText } from '../../src/actions/shell-plain.js';
import { cpuNow } from '../cpu-time.js';

const values = (text: string): string[] => argv(text).map((w) => w.value);

describe('argv: the words of a stage, cut where a shell cuts them', () => {
  it.each<[string, string[]]>([
    ["bash<<<'x'", ['bash', '<<<x']],
    ['bash>/dev/null', ['bash', '>/dev/null']],
    ['bash&>/dev/null', ['bash', '&>/dev/null']],
    ['bash<x.sh', ['bash', '<x.sh']],
    ["bash</dev/null<<<'x'", ['bash', '</dev/null', '<<<x']],
    ['bash 2>&1', ['bash', '2>&1']],
    ['bash 0<<<x', ['bash', '0<<<x']],
    ['bash 3>&1 4<&- 5<>f', ['bash', '3>&1', '4<&-', '5<>f']],
    ['echo x >| f', ['echo', 'x', '>|', 'f']],
    ['cat <(echo x) >(tee y)', ['cat', '<(echo x)', '>(tee y)']],
    ['echo a&>f', ['echo', 'a', '&>f']],
  ])('%s', (text, words) => {
    expect(values(text)).toEqual(words);
  });

  it('marks the words that begin with a redirect, and only those', () => {
    const words = argv("bash 2>/dev/null <<< 'x' y");
    expect(words.map((w) => w.redirect)).toEqual([false, true, true, false, false]);
    // A quoted operator is a name, not a redirect.
    expect(argv("bash '>x'").map((w) => w.redirect)).toEqual([false, false]);
    expect(argv('bash \\>x').map((w) => w.redirect)).toEqual([false, false]);
  });

  it('keeps a digit that is part of a name out of the descriptor', () => {
    expect(values('bash0<<<x')).toEqual(['bash0', '<<<x']);
  });

  it('takes the quotes and the escapes off, as a shell does', () => {
    expect(values('echo a\\ b')).toEqual(['echo', 'a b']);
    expect(values('"a b"c')).toEqual(['a bc']);
    expect(values("$'a\\x20b'")).toEqual(['a b']);
    expect(values('b"as"h')).toEqual(['bash']);
    expect(values("$'\\x62ash'")).toEqual(['bash']);
  });

  it('keeps a substitution, a process substitution and an extended glob as one word', () => {
    expect(values('x=$(date; echo a) bash')).toEqual(['x=$(date; echo a)', 'bash']);
    expect(values('echo @(a|b)')).toEqual(['echo', '@(a|b)']);
    expect(values('echo "$(echo a b)" c')).toEqual(['echo', '$(echo a b)', 'c']);
  });

  it('makes a parenthesis a word of its own', () => {
    const words = argv('(bash) <<< x');
    expect(words.map((w) => [w.value, w.group])).toEqual([
      ['(', true],
      ['bash', false],
      [')', true],
      ['<<<', false],
      ['x', false],
    ]);
  });

  it('makes the words a brace expansion makes, quotes taken off after', () => {
    const values = (text: string): string[] => argv(text).map((w) => w.value);
    expect(values('echo {a,b}x')).toEqual(['echo', 'ax', 'bx']);
    expect(values("{bash,-c,'rm -rf ~'}")).toEqual(['bash', '-c', 'rm -rf ~']);
    expect(values("x'{a,b}'")).toEqual(['x{a,b}']);
    expect(values('{a,b}')).toEqual(['a', 'b']);
    expect(values('{bash,}')).toEqual(['bash']);
    expect(values('{a,"b c"}')).toEqual(['a', 'b c']);
    // A redirect's target is not expanded.
    expect(values('cat <<< {a,b}')).toEqual(['cat', '<<<', '{a,b}']);
    expect(values('cat<<<{a,b}')).toEqual(['cat', '<<<{a,b}']);
    expect(argv('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}')[0]?.expands).toBe(true);
  });

  it('says which words the shell would expand', () => {
    const [, plain, variable, glob, brace, quoted, escaped, ansi] = argv(
      "echo a $x /bin/ba* {1..99999} '$x' \\$x $'$x'",
    );
    expect([plain, variable, glob, brace, quoted, escaped, ansi].map((w) => w?.expands)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('reads a long text of one kind of character in one pass', () => {
    for (const unit of ['{', '${', '$(', '"', "'", '`', '<(', '\\', "$'", ' ']) {
      const text = `echo ${unit.repeat(100_000)}`;
      const started = cpuNow();
      argv(text);
      expect(cpuNow() - started, unit).toBeLessThan(1500);
    }
  });
});

describe('resolve: the command a stage runs', () => {
  const run = (text: string) => {
    const found = resolve(text);
    return found === null
      ? null
      : { name: found.name, args: found.args.map((w) => w.value), wrappers: found.wrappers };
  };

  it.each<[string, string, string[]]>([
    ["bash<<<'rm -rf ~'", 'bash', ['<<<rm -rf ~']],
    ["flock x.lock -c 'rm -rf ~'", 'sh', ['-c', 'rm -rf ~']],
    ["flock -n x.lock -c 'rm -rf ~'", 'sh', ['-c', 'rm -rf ~']],
    ['flock x.lock --command=rm\\ -rf\\ ~', 'sh', ['-c', 'rm -rf ~']],
    ["flock x.lock --command 'rm -rf ~'", 'sh', ['-c', 'rm -rf ~']],
    ['flock x.lock rm -rf ~', 'rm', ['-rf', '~']],
    ['2>/dev/null bash', 'bash', ['2>/dev/null']],
    ['< x.sh bash', 'bash', ['<', 'x.sh']],
    ['FOO=1 BAR=2 bash', 'bash', []],
    ['"bash"', 'bash', []],
    ['b"as"h', 'bash', []],
    ["$'\\x62ash'", 'bash', []],
    ['/bin/bash -s', 'bash', ['-s']],
    ['(bash) <<< x', 'bash', ['<<<', 'x']],
    ['bash )', 'bash', []],
  ])('finds the command word of %s', (text, name, args) => {
    expect(run(text)).toMatchObject({ name, args });
  });

  it.each<[string, string, readonly string[]]>([
    ['sudo -u root bash -s', 'bash', ['sudo']],
    ['sudo --user=root bash', 'bash', ['sudo']],
    ['env -S"bash -s"', 'bash', ['env']],
    ["env -S 'bash -s'", 'bash', ['env']],
    ['env - bash', 'bash', ['env']],
    ['env --split-string=bash', 'bash', ['env']],
    ['env A=1 B=2 bash', 'bash', ['env']],
    ['exec -a x bash', 'bash', ['exec']],
    ['setsid bash', 'bash', ['setsid']],
    ['unbuffer bash', 'bash', ['unbuffer']],
    ['flock /tmp/lk bash', 'bash', ['flock']],
    ['nohup nice -n 5 timeout 5 bash', 'bash', ['nohup', 'nice', 'timeout']],
    ['time { bash', 'bash', ['time']],
    ['coproc bash', 'bash', ['coproc']],
    ['/usr/bin/env bash', 'bash', ['env']],
    ['sshpass -p x ssh host', 'ssh', ['sshpass']],
    ['eval bash', 'bash', ['eval']],
  ])('looks through the wrappers of %s', (text, name, wrappers) => {
    expect(run(text)).toMatchObject({ name, wrappers });
  });

  // A number after `-n`, `-j` or `--jobs` is the option's value and not the command, and `-u`, `-o`
  // and `-e` are flags of these wrappers, not options that take the word after them.
  it.each<[string, string, string[]]>([
    ['watch -n 5 rm -rf ~', 'rm', ['watch']],
    ['watch --interval 5 rm -rf ~', 'rm', ['watch']],
    ['watch -n5 rm -rf ~', 'rm', ['watch']],
    ['parallel -j 4 rm -rf ::: ~', 'rm', ['parallel']],
    ['parallel --jobs 4 -k rm -rf ::: ~', 'rm', ['parallel']],
    ['parallel -S host -j 4 rm -rf ::: ~', 'rm', ['parallel']],
    ['parallel -a list.txt --colsep , rm -rf', 'rm', ['parallel']],
    ['parallel -u rm -rf ::: ~', 'rm', ['parallel']],
    ['xargs -o rm -rf', 'rm', ['xargs']],
    ['xargs -e rm -rf', 'rm', ['xargs']],
    ['xargs -n 1 -P 4 rm -rf', 'rm', ['xargs']],
  ])('finds the command behind the options of %s', (text, name, wrappers) => {
    expect(run(text)).toMatchObject({ name, wrappers });
  });

  it('has no command for parallel that is given only options', () => {
    expect(run('parallel -j 4')?.name ?? '').not.toMatch(/^[A-Za-z_./~]/);
    expect(run('parallel -S server -j 4')?.name ?? '').not.toMatch(/^[A-Za-z_./~]/);
  });

  it('does not take a program that has a wrapper name in a directory anyone writes for one', () => {
    expect(run('./env bash')?.name).toBe('env');
    expect(run('/tmp/w/time bash')?.name).toBe('time');
  });

  it('says `sh` for sudo -s and sudo -i, which are shells with no shell word', () => {
    expect(run('sudo -s')?.name).toBe('sh');
    expect(run('sudo -i')?.name).toBe('sh');
    expect(run('sudo -u root -s')?.name).toBe('sh');
    expect(run('sudo ls')?.name).toBe('ls');
  });

  it('names an expansion `$`, because nobody can say what it runs', () => {
    for (const text of [
      '$SHELL',
      '$0',
      '${BASH}',
      '$(which bash)',
      '/bin/ba*',
      '/bin/ba[s]h',
      '=bash',
    ])
      expect(run(text)?.name, text).toBe('$');
  });

  it('records the functions a stage defines, and the command after the head', () => {
    for (const head of ['f() { bash', 'f () { bash', 'function f { bash', 'function f() { bash'])
      expect(resolve(head)).toMatchObject({ defined: ['f'], name: 'bash' });
    expect(resolve('f() ( bash )')).toMatchObject({ defined: ['f'] });
    expect(resolve('f() {')?.defined).toEqual(['f']);
  });

  it('ends the command at a brace that closes its group, as zsh does with no semicolon before it', () => {
    expect(run('bash } always { :')).toMatchObject({ name: 'bash', args: [] });
    expect(run("bash } <<< 'x'")).toMatchObject({ name: 'bash', args: ['<<<', 'x'] });
    expect(run("echo '}' a")).toMatchObject({ name: 'echo', args: ['}', 'a'] });
  });

  it('gives a stage of only redirects an empty command, with the redirects', () => {
    expect(run("<<< 'rm -rf ~'")).toEqual({ name: '', args: ['<<<', 'rm -rf ~'], wrappers: [] });
  });

  it('has `exec` with only redirects hand them on', () => {
    expect(run("exec <<< 'x'")).toMatchObject({ name: 'exec', args: ['<<<', 'x'] });
  });

  it('reads the argument of eval as the command line it makes', () => {
    const found = resolve("eval 'bash -s'");
    expect(found?.name).toBe('bash');
    expect(found?.evalProgram).toEqual({ text: 'bash -s', dynamic: false });
    expect(resolve('eval "$x"')?.evalProgram?.dynamic).toBe(true);
  });

  it('stops at a nesting it does not read, and says so', () => {
    const nested = `${'eval '.repeat(40)}bash`;
    expect(resolve(nested)?.deep).toBe(true);
  });

  it('is null when there is no word at all', () => {
    expect(resolve('')).toBeNull();
    expect(resolve('FOO=1')).toBeNull();
  });
});

describe('withoutRedirects and groupMarks', () => {
  it('takes a redirect and its target out of the words that are text', () => {
    const words = resolve('echo a 2>&1 b > out c')?.args ?? [];
    expect(withoutRedirects(words).map((w) => w.value)).toEqual(['a', 'b', 'c']);
  });

  it('counts the subshells a stage opens and the ones it closes', () => {
    expect(groupMarks('(cd sub)')).toEqual({ opens: 1, closes: 1 });
    expect(groupMarks('(cd sub && cat x.sh')).toEqual({ opens: 1, closes: 0 });
    expect(groupMarks('bash)')).toEqual({ opens: 0, closes: 1 });
    expect(groupMarks('echo $(date)')).toEqual({ opens: 0, closes: 0 });
    expect(groupMarks('{ echo x; }')).toEqual({ opens: 0, closes: 0 });
  });
});

describe('plainText: a stage as the shell reads its words', () => {
  it.each<[string, string]>([
    ['git re""set --hard', 'git reset --hard'],
    ['"GIT" reset --hard', 'git reset --hard'],
    ['FOO=1 RM -rf x', 'FOO=1 rm -rf x'],
    ['sudo -u root RM -rf x', 'sudo -u root rm -rf x'],
    ['SUDO NICE -n 5 RM x', 'SUDO NICE -n 5 rm x'],
    ["echo 'rm -rf ~'", "echo 'rm -rf ~'"],
    ['echo "it\'s here"', 'echo "it\'s here"'],
    ['{git,reset,--hard}', 'git reset --hard'],
    ['(rm -rf ~)', '( rm -rf ~ )'],
    ["$'git' reset", 'git reset'],
    ['then GIT push', 'then git push'],
    ['eval RM -rf x', 'eval rm -rf x'],
    ['env -S "RM -rf x"', 'env -S "RM -rf x"'],
  ])('%s', (text, expected) => {
    expect(plainText(text)).toBe(expected);
  });

  it('keeps a word as it is written, unless a quote hides a plain word', () => {
    for (const text of [
      'printf \'%s\\n\' "a b"',
      'echo "$HOME/x" \'*.log\' "a b"',
      "grep -E 'a|b' file",
    ])
      expect(plainText(text).replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
    expect(plainText('g"i"t "reset" \'--hard\'')).toBe('git reset --hard');
  });

  it('returns a text that ends inside a quote as it is: it is a piece of a string', () => {
    expect(plainText('set"')).toBe('set"');
    expect(plainText('baseRef" "/x/settings.json" 2>/dev/null')).toBe(
      'baseRef" "/x/settings.json" 2>/dev/null',
    );
    expect(plainText("echo 'unclosed")).toBe("echo 'unclosed");
  });
});

describe('globbedCommands: a wildcard in the path of a command names the commands it could', () => {
  it.each<[string, string[]]>([
    ['/bin/r[m] -rf ~', ['rm -rf ~']],
    ['/bin/r? -rf ~', ['rm -rf ~']],
    ['/bin/[r]m -rf ~', ['rm -rf ~']],
    ['/usr/bin/gi? reset --hard', ['git reset --hard']],
    ['sudo /usr/bin/cur? -d x', ['sudo curl -d x']],
    ['/usr/bin/r*', ['rm', 'rmdir', 'ruby', 'rsync']],
    ['FOO=1 /bin/r? x', ['FOO=1 rm x']],
    ["/bin/r? 'a b'", ["rm 'a b'"]],
  ])('%s', (text, texts) => {
    expect(globbedCommands(text)).toEqual({ texts, broad: false });
  });

  it('says where it could name too many to say which, in a directory of commands', () => {
    expect(globbedCommands('/bin/* -rf ~')).toEqual({ texts: [], broad: true });
    expect(globbedCommands('/usr/bin/?* x')).toEqual({ texts: [], broad: true });
    expect(globbedCommands('./node_modules/.bin/* x')).toEqual({ texts: [], broad: false });
    expect(globbedCommands('/*) x')).toEqual({ texts: [], broad: false });
    expect(globbedCommands('/opt/tools/* x')).toEqual({ texts: [], broad: false });
  });

  it.each([
    'rm -rf ~',
    '/bin/rm -rf ~',
    'r? -rf ~',
    '*.sh',
    './scripts/run*.sh',
    '/tmp/*/run.sh',
    '/bin/ls *.log',
    "'/bin/r?' x",
    '/bin/r$x y',
    '/bin/r`x` y',
    'echo "unclosed /bin/r?',
    '/bin/zzz? x',
  ])('leaves %s alone', (text) => {
    expect(globbedCommands(text)).toEqual({ texts: [], broad: false });
  });
});
