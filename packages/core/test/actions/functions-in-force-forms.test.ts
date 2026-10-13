import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { functionsDefinedIn, withArguments } from '../../src/actions/inlined-functions.js';
import { splitCommand } from '../../src/actions/shell-segments.js';

const CWD = '/home/dev/project';
const classes = (command: string): readonly string[] => classifyCommand(command, CWD).classes;
const signals = (command: string): readonly string[] => classifyCommand(command, CWD).signals;
const destructive = (command: string): boolean => classes(command).includes('shell.destructive');
const unread = (command: string): boolean =>
  signals(command).some((signal) => signal.endsWith('function-call-not-read'));
const reads = (command: string, reading: string): boolean =>
  splitCommand(command).texts.some((text) => text.includes(reading));

const R = 'rm "$@"';

/**
 * What a first reviewer of the reading of functions found by running the forms of a definition and a call
 * that the first version did not read: a name that is a wrapper, names that a shell accepts and a pattern
 * did not, an arm of `case`, a call spelled in pieces in a text of its own, a comment before the brace,
 * the forms of a parameter, a word of the call that has quotes in it.
 */

describe('a function named like a wrapper', () => {
  it.each([
    'sudo',
    'env',
    'timeout',
    'exec',
    'xargs',
    'watch',
    'command',
    'builtin',
    'nohup',
    'nice',
    'doas',
    'caffeinate',
    'flock',
    'stdbuf',
    'ionice',
    'setsid',
    'parallel',
    'noglob',
  ])('is the call, and not the program it is named for: %s', (name) => {
    expect(destructive(`${name}() { ${R}; }; ${name} -rf ~`), name).toBe(true);
  });

  it('is read for every kind of danger, as the same command typed is', () => {
    expect(classes('sudo() { echo x >> "$1"; }; sudo ~/.zshrc')).toContain('config.persistence');
    expect(classes(`sudo() { git "$@"; }; sudo -c core.fsmonitor='touch x' status`)).toContain(
      'config.git_exec',
    );
    expect(destructive('sudo() { terraform "$@"; }; sudo destroy -auto-approve')).toBe(true);
    expect(destructive('sudo() { git "$@"; }; sudo reset --hard')).toBe(true);
    expect(destructive('sudo() { dd "$@"; }; sudo if=/dev/zero of=/dev/disk2')).toBe(true);
  });

  it('is the call after the words that come before a command', () => {
    expect(destructive(`sudo() { ${R}; }; time sudo -rf ~`)).toBe(true);
    expect(destructive(`sudo() { ${R}; }; x=1 sudo -rf ~`)).toBe(true);
    expect(destructive(`sudo() { ${R}; }; ! sudo -rf ~`)).toBe(true);
    expect(destructive(`sudo() { ${R}; }; if sudo -rf ~; then :; fi`)).toBe(true);
    expect(destructive(`sudo() { ${R}; }; echo hi | sudo -rf ~`)).toBe(true);
    expect(destructive(`sudo() { ${R}; }; ( sudo -rf ~ )`)).toBe(true);
    expect(destructive(`sudo() { ${R}; }; echo $(sudo -rf ~)`)).toBe(true);
  });

  it('is not a call where the wrapper is not the function', () => {
    expect(destructive('sudo ls -la')).toBe(false);
    expect(destructive(`${'g() { rm "$@"; };'} command g -rf ~`)).toBe(false);
  });
});

describe('a name that a shell takes for a function', () => {
  it.each([
    '1f',
    'a+b',
    'a@b',
    'a,b',
    'a%b',
    'a/b',
    '.a',
    ':',
    '[',
    'a^b',
    '@',
    'a~',
    'é',
    'a-b',
    'a.b',
    'a:b',
    '_x',
  ])('is read: %s', (name) => {
    expect(destructive(`${name}() { ${R}; }; ${name} -rf ~`), name).toBe(true);
  });

  it('is read with the function keyword, and with the line break before the brace', () => {
    expect(destructive(`function a+b { ${R}; }; a+b -rf ~`)).toBe(true);
    expect(destructive(`function 1f() { ${R}; }; 1f -rf ~`)).toBe(true);
    expect(destructive(`é()\n{\n  ${R}\n}\né -rf ~`)).toBe(true);
  });

  it('is not made of what a shell does not take: a name with a quote, a bracket or an equals sign', () => {
    const names = (text: string): string[] =>
      functionsDefinedIn(text).definitions.map((definition) => definition.name);

    expect(names('a=b() { :; }')).toEqual([]);
    expect(names('echo a() { :; }')).toEqual([]);
    expect(names('(a)() { :; }')).toEqual([]);
  });
});

describe('a function defined where a command begins', () => {
  it.each([
    'case x in x) f() { rm "$@"; };; esac; f -rf ~',
    'case x in\nx) f() { rm "$@"; };;\nesac; f -rf ~',
    'case x in (x) f() { rm "$@"; };; esac; f -rf ~',
    'case x in x)\n  f() { rm "$@"; }\n  ;;\nesac\nf -rf ~',
    'if true; then f() { rm "$@"; }; fi; f -rf ~',
    'for i in 1; do f() { rm "$@"; }; done; f -rf ~',
    'true && f() { rm "$@"; }; f -rf ~',
    '{ f() { rm "$@"; }; }; f -rf ~',
  ])('is read: %s', (command) => {
    expect(destructive(command), command).toBe(true);
  });

  it('is read after a comment or an escaped line break between the header and the body', () => {
    expect(destructive(`f() # comment\n{ ${R}; }\nf -rf ~`)).toBe(true);
    expect(destructive(`f() \\\n{ ${R}; }\nf -rf ~`)).toBe(true);
    expect(destructive(`f()\n# one\n# two\n{ ${R}; }\nf -rf ~`)).toBe(true);
    expect(destructive(`function f # comment\n{ ${R}; }\nf -rf ~`)).toBe(true);
  });

  it.each([
    'export f() { rm "$@"; }; f -rf ~',
    'declare -f f() { rm "$@"; }; f -rf ~',
    'typeset -f f() { rm "$@"; }; f -rf ~',
    'readonly f() { rm "$@"; }; f -rf ~',
  ])('is read after a declaration that zsh allows: %s', (command) => {
    expect(destructive(command), command).toBe(true);
  });
});

describe('a call spelled in pieces, in a text of its own', () => {
  it.each([
    'echo $(f"f" -rf ~)',
    'echo $(f\\f -rf ~)',
    "echo $(f''f -rf ~)",
    'echo `f"f" -rf ~`',
    'x=$(f"f" -rf ~)',
    'cat <(f"f" -rf ~)',
    'trap \'f"f" -rf ~\' EXIT',
    'eval \'f"f" -rf ~\'',
    'bash -c \'f"f" -rf ~\'',
  ])('is read: %s', (call) => {
    expect(destructive(`ff() { ${R}; }; ${call}`), call).toBe(true);
  });

  it('is a question where it is made with $-quotes, in any text', () => {
    const command = `ff() { ${R}; }; echo $($'f'f -rf ~)`;

    expect(unread(command)).toBe(true);
  });
});

describe('the words of a call, put where a parameter is used', () => {
  it.each([
    ['unquoted $1, one quoted word', 'g() { $1; }; g "rm -rf $HOME"'],
    ['unquoted $@, one quoted word', 'g() { $@; }; g "rm -rf $HOME"'],
    ['two parameters, one quoted word', 'g() { rm $1 $2; }; g "-rf $HOME"'],
    ['$@, one quoted word', 'g() { rm $@; }; g "-rf $HOME"'],
    ['$1, one quoted word', 'g() { rm $1; }; g "-rf $HOME"'],
    ['inside a string', 'g() { sh -c "rm $1"; }; g "-rf $HOME"'],
    ['a string given to eval', 'g() { eval "$1 x"; }; g \'rm -rf ~\''],
    ['a word of its own', 'g() { eval "$1"; }; g \'rm -rf ~\''],
    ['shift, then the parameters', 'g() { shift; rm "$1" "$2"; }; g x -rf ~'],
    ['shift two', 'g() { shift 2; rm "$@"; }; g x y -rf ~'],
    ['the count', 'g() { [ $# -gt 1 ] && rm "$@"; }; g -rf ~'],
    ['a default', 'g() { rm "${1:--rf}" ~; }; g'],
    ['a default, the word given', 'g() { rm "${1:-x}" "$2"; }; g -rf ~'],
    ['a word where one is set', 'g() { rm ${1:+-rf} ~; }; g y'],
    ['the words from the second', 'g() { rm "${@:2}"; }; g x -rf ~'],
    ['a count of words', 'g() { rm ${@:2:2}; }; g x -rf ~'],
    ['a redirect among the words', 'g() { rm "$1" "$2"; }; g 2>/dev/null -rf ~'],
    ['a slice from the end', 'g() { rm ${@: -2}; }; g x -rf ~'],
    ['a substring', 'g() { rm ${1:0:3} ${2:-}; }; g -rf ~'],
    ['a trim', 'g() { rm ${1%x} ${2%x}; }; g -rfx ~x'],
    ['a substitution', 'g() { rm ${1/x/} ${2/x/}; }; g -rfx ~x'],
    ['an error where unset, set', 'g() { rm "${1:?}" ~; }; g -rf'],
    ['a trim of a prefix', 'g() { rm "${1#x}" ~; }; g x-rf'],
    ['a trim of what ends a name', 'g() { rm -rf "${1%/}"; }; g ~/'],
    ['the longest trim', 'g() { rm -rf "${1##*/}" ~; }; g a/b/c'],
    ['upper case', 'g() { rm "${1,,}" ~; }; g -RF'],
  ])('is read: %s', (_name, command) => {
    expect(destructive(command), command).toBe(true);
  });

  it('is put in place once: a word that has a parameter in it is not read again', () => {
    expect(reads('g() { rm "$1" "$2"; }; g \'$2\' -rf', "{ rm '$2' -rf; }")).toBe(true);
  });

  it('is a value where it is unquoted, and the word as written where it is quoted whole', () => {
    expect(reads('g() { $1; }; g "rm -rf $HOME"', '{ rm -rf $HOME; }')).toBe(true);
    expect(reads('g() { "$1"; }; g "rm -rf $HOME"', '{ "rm -rf $HOME"; }')).toBe(true);
    expect(reads('g() { c=$1; :; }; g "a b"', '{ c="a b"; :; }')).toBe(true);
  });

  it.each([
    ['a slice by a count', 'g() { rm ${@:$#}; }; g -rf ~'],
    ['two digits', 'g() { rm ${10} ~; }; g 1 2 3 4 5 6 7 8 9 -rf'],
    ['an assignment', 'g() { rm "${1:=-rf}" ~; }; g'],
    ['an indirection', 'g() { rm "${!1}" ~; }; g -rf'],
    ['a trim of a value that is not plain', 'g() { rm "${1#x}" ~; }; g "$HOME/x"'],
    ['a trim by a pattern that is not plain', 'g() { rm "${1#[a-z]}" ~; }; g x-rf'],
    ['a substitution that is anchored', 'g() { rm "${1/#x/y}" ~; }; g x-rf'],
    ['a slice with a length before the start', 'g() { rm "${@:1:-1}" ~; }; g -rf'],
    ['getopts', 'g() { OPTIND=1; while getopts r o; do rm -$o ~; done; }; g -r'],
    ['a new list of parameters', 'g() { set -- -rf ~; rm "$@"; }; g'],
    ['a shift in a loop', 'g() { while [ $# -gt 0 ]; do rm "$1"; shift; done; }; g -rf ~'],
    ['a shift in a branch', 'g() { if [ "$1" = -f ]; then shift; fi; rm "$1"; }; g -f ~'],
    ['a shift after &&', 'g() { [ -n "$1" ] && shift; rm "$1"; }; g ~'],
  ])('is a question where the body uses %s, which is not put in place', (_name, command) => {
    expect(unread(command), command).toBe(true);
  });

  it('is not a question for the uses of parameters that are put in place', () => {
    for (const command of [
      'g() { echo "$1" "${2:-x}" "${@:2}" $# ${#}; }; g a b c',
      'g() { shift; echo "$@"; }; g a b',
      'g() { local d="${1:-.}"; ls "$d"; }; g /tmp',
      "g() { echo 'it$1'; }; g a",
      'g() { cat <<EOF\n$1 and ${2:-x}\nEOF\n}; g a',
      "g() { cat <<'EOF'\n$1 ${1%x}\nEOF\n}; g a",
      'g() { cat <<EOF\ndon\'t "quote\nEOF\necho "$1"; }; g a',
    ]) {
      expect(unread(command), command).toBe(false);
    }
  });

  it('puts the parameters of a document in place where it expands, and not where it is literal', () => {
    expect(reads('g() { cat <<EOF\n$1\nEOF\n}; g "a b"', '\na b\n')).toBe(true);
    expect(reads('g() { cat <<\'EOF\'\n$1\nEOF\n}; g "a b"', '\n$1\n')).toBe(true);
  });
});

describe('the words of a call put in a body', () => {
  it('counts the words that are left after a shift, and not the ones that were given', () => {
    expect(withArguments('echo $# ${#}', ' a b c').text).toBe('echo 3 3');
    expect(withArguments('shift; echo $#', ' a b c').text).toBe('shift; echo 2');
    expect(withArguments('echo "$#"', '').text).toBe('echo 0');
  });

  it('puts the words in place of the forms of a parameter and nothing else', () => {
    expect(withArguments('echo "$1" $2 "${3:-z}" ${@:2}', ' a "b c" d').text).toBe(
      'echo a b c d b c d',
    );
    expect(withArguments("echo '$1' \\$1 $0 $$", ' a').text).toBe("echo '$1' \\$1 $0 $$");
  });

  it('does not read a comment as a body: its quotes are not quotes, and it expands nothing', () => {
    const body = 'echo ok # don\'t say "this $1\nrm "$1"';

    expect(withArguments(body, ' x')).toEqual({
      text: 'echo ok # don\'t say "this $1\nrm x',
      complete: true,
    });
  });

  it('reads an arithmetic expansion as an expansion: a shift in it is not a document', () => {
    expect(withArguments('echo $(( 1 << 2 ))\nrm "$@"\n', ' -rf ~')).toEqual({
      text: 'echo $(( 1 << 2 ))\nrm -rf ~\n',
      complete: true,
    });
    expect(withArguments('echo $(( $1 + 1 ))', ' 3').text).toBe('echo $(( 3 + 1 ))');
    expect(destructive('g() { echo $(( 1 << 2 ))\n  rm "$@"\n}\ng -rf ~')).toBe(true);
  });

  it('does not take a line break inside quotes for the end of the line that opened a document', () => {
    expect(withArguments('cat <<EOF "a\nb"\n$1\nEOF\n', ' x')).toEqual({
      text: 'cat <<EOF "a\nb"\nx\nEOF\n',
      complete: true,
    });
  });

  it('says where it did not follow the body to its end: a quote that does not close', () => {
    expect(withArguments('echo "a', ' x').complete).toBe(false);
    expect(withArguments('echo "a" "$1"', ' x').complete).toBe(true);
  });

  it('says where a form of a parameter is not put in place', () => {
    expect(withArguments('echo ${10}', ' abx').complete).toBe(false);
    expect(withArguments('echo ${1%x}', ' abx').complete).toBe(true);
    expect(withArguments('getopts r o', ' -r').complete).toBe(false);
    expect(withArguments('echo $1', ' a').complete).toBe(true);
  });
});

describe('a function that text handed to a shell defines', () => {
  it.each([
    `source <(echo 'f() { rm "$@"; }'); f -rf ~`,
    `. <(echo 'f() { rm "$@"; }'); f -rf ~`,
    `. /dev/stdin <<< 'f() { rm "$@"; }'; f -rf ~`,
    `source <(printf '%s\\n' 'f() { rm "$@"; }'); f -rf ~`,
    `echo 'f() { rm "$@"; }' | source /dev/stdin; f -rf ~`,
    `source /dev/stdin <<'EOF'\nf() { rm "$@"; }\nEOF\nf -rf ~`,
    `eval 'f() { rm "$@"; }'; f -rf ~`,
  ])('is in force where the command calls it: %s', (command) => {
    expect(destructive(command), command).toBe(true);
  });

  it('is not in force where nothing defines it', () => {
    expect(destructive('source <(echo ok); f -rf ~')).toBe(false);
    expect(destructive('echo \'f() { rm "$@"; }\'; f -rf ~')).toBe(false);
  });
});

describe('a function in the command that ssh runs', () => {
  it('is read as the remote command that it runs', () => {
    expect(classes('ssh prod \'f() { rm "$@"; }; f -rf /var/www\'')).toContain('shell.destructive');
    expect(classes("ssh prod 'g() { rm -rf /var/www; }; g'")).toContain('shell.destructive');
  });

  it('is not read as a call of the local one', () => {
    expect(classes(`g() { rm "$@"; }; ssh host 'g -rf /var/www'`)).not.toContain(
      'shell.destructive',
    );
  });
});

describe('what is documented as not read', () => {
  it('is the anonymous function of zsh, which has no name to call', () => {
    // `() { rm "$@"; } -rf ~` runs in zsh and is not read (SECURITY.md).
    expect(destructive(`() { ${R}; } -rf ~`)).toBe(false);
  });
});
