import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { newFunctionRoom, readFunctionCalls } from '../../src/actions/function-readings.js';
import { newFormBudget } from '../../src/actions/parameter-forms.js';
import {
  functionsDefinedIn,
  inheritedFunctions,
  withInlinedFunctions,
} from '../../src/actions/inlined-functions.js';
import { lex } from '../../src/actions/shell-lex.js';
import { splitCommand } from '../../src/actions/shell-segments.js';
import { cpuNow } from '../cpu-time.js';

const CWD = '/home/dev/project';
const classes = (command: string): readonly string[] => classifyCommand(command, CWD).classes;
const signals = (command: string): readonly string[] => classifyCommand(command, CWD).signals;
const destructive = (command: string): boolean => classes(command).includes('shell.destructive');
const asked = (command: string): boolean => classes(command).includes('shell.unparsed');
const unread = (command: string): boolean =>
  signals(command).some((signal) => signal.endsWith('function-call-not-read'));

/**
 * What a seventh look at the functions of a command found, by running them: a function is in force
 * wherever the shell that defines it runs a command, not only on the line the call stands on; the
 * limits of the reading were silent, so that a command could be padded past them; and the pattern that
 * found a definition took a quadratic time on a text of line breaks.
 */

const G = 'g() { rm "$@"; };';

describe('a function that the command defines, called in a text that is read from it', () => {
  it.each([
    'echo $(g -rf ~)',
    'echo `g -rf ~`',
    'x=$(g -rf ~)',
    'echo "$(g -rf ~)"',
    'echo "`g -rf ~`"',
    'echo ${x:-$(g -rf ~)}',
    'cat <(g -rf ~)',
    'echo x > >(g -rf ~)',
    '( g -rf ~ )',
    'true && ( g -rf ~ )',
    "eval 'g -rf ~'",
    'eval g -rf ~',
    "trap 'g -rf ~' EXIT",
    'sh -c \'g() { rm "$@"; }; echo $(g -rf ~)\'',
  ])('is read as the body it runs: %s', (call) => {
    expect(destructive(`${G} ${call}`)).toBe(true);
  });

  it.each([
    "bash -c 'g -rf ~'",
    "find . -exec bash -c 'g -rf ~' \\;",
    "echo hi | xargs -I{} bash -c 'g -rf ~'",
    "timeout 5 bash -c 'g -rf ~'",
    'bash <<EOF\ng -rf ~\nEOF',
    "bash -s <<< 'g -rf ~'",
    "echo 'g -rf ~' | bash",
    "printf 'g -rf ~\\n' | sh",
    'cat <<EOF | bash\ng -rf ~\nEOF',
    "bash <(echo 'g -rf ~')",
    "source <(echo 'g -rf ~')",
  ])('is read where a shell is given the function by `export -f`: %s', (call) => {
    expect(destructive(`${G} export -f g; ${call}`)).toBe(true);
  });

  it('is read in a function that a function calls, from a substitution', () => {
    expect(destructive('h() { echo $(g "$@"); }; g() { rm "$@"; }; h -rf ~')).toBe(true);
    expect(destructive('h() { x=$(g "$@"); }; g() { rm "$@"; }; h -rf ~')).toBe(true);
  });

  it('is read when the function is spelled by a variable that the command sets', () => {
    expect(destructive(`${G} f=g; $f -rf ~`)).toBe(true);
    expect(destructive(`${G} f=g; echo $($f -rf ~)`)).toBe(true);
  });

  it.each([
    'command g -rf ~',
    'builtin g -rf ~',
    'declare -f g',
    'echo g -rf ~',
    "ssh host 'g -rf ~'",
    'type g',
  ])('is not a call where the function is not run: %s', (call) => {
    expect(destructive(`${G} ${call}`)).toBe(false);
    expect(unread(`${G} ${call}`)).toBe(false);
  });

  it('reads a name that is defined twice as both of its bodies', () => {
    expect(destructive('g() { echo "$@"; }; if true; then g() { rm "$@"; }; fi; g -rf ~')).toBe(
      true,
    );
    expect(destructive('g() { rm "$@"; }; if false; then g() { :; }; fi; g -rf ~')).toBe(true);
  });

  it('puts the words of the call where the body uses them, and takes the redirects off them', () => {
    const two = 'g() { rm "$1" "$2"; };';
    expect(destructive(`${two} g -rf ~`)).toBe(true);
    expect(destructive(`${two} g 2>/dev/null -rf ~`)).toBe(true);
    expect(destructive(`${two} g >/dev/null -rf ~`)).toBe(true);
    expect(destructive(`${two} g > /dev/null -rf ~`)).toBe(true);
    expect(destructive(`${two} g 2>&1 -rf ~`)).toBe(true);
    expect(destructive(`${two} g &> /dev/null -rf ~`)).toBe(true);
    expect(destructive(`${two} g < /dev/null -rf ~`)).toBe(true);
  });

  it('is put in place in the texts that are read from the command', () => {
    const { texts } = splitCommand(`${G} echo $(g -rf ~)`);
    expect(texts.some((text) => text.includes('{ rm -rf ~; }'))).toBe(true);
  });
});

describe('a function whose body is not a group', () => {
  it.each([
    'g() ( rm "$@" ); g -rf ~',
    'g() (\n  rm "$@"\n)\ng -rf ~',
    'function g ( rm "$@" ); g -rf ~',
    'if true; then g() ( rm "$@" ); fi; g -rf ~',
  ])('is read as the body it runs, in a subshell: %s', (command) => {
    expect(destructive(command)).toBe(true);
  });

  it.each([
    'g() if true; then rm "$@"; fi; g -rf ~',
    'g() while false; do rm "$@"; done; g -rf ~',
    'g() [[ -n "$1" ]]; g -rf ~',
    'g() case x in x) rm "$@";; esac; g -rf ~',
    'g() ( case "$1" in a) rm "$@";; esac ); g -rf ~',
  ])('is asked about where it is another compound command, which is not read: %s', (command) => {
    expect(unread(command), command).toBe(true);
    expect(asked(command)).toBe(true);
  });

  it('is not asked about where it is never called', () => {
    expect(unread('g() if true; then :; fi; echo done')).toBe(false);
  });
});

describe('a call spelled with quotes or escapes', () => {
  it.each([
    '"g" -rf ~',
    "'g' -rf ~",
    '\\g -rf ~',
    "g'' -rf ~",
    'g"" -rf ~',
    'x=1 "g" -rf ~',
    'echo $("g" -rf ~)',
    '{ "g" -rf ~; }',
  ])('is a call of the function: %s', (call) => {
    expect(destructive(`${G} ${call}`), call).toBe(true);
  });

  it('is a call where the name is spelled in pieces', () => {
    expect(destructive('gx() { rm "$@"; }; g"x" -rf ~')).toBe(true);
    expect(destructive('gx() { rm "$@"; }; "g"x -rf ~')).toBe(true);
  });

  it("is asked about where the name is made with `$'…'`, which is not read", () => {
    const command = `${G} $'g' -rf ~`;

    expect(unread(command)).toBe(true);
    expect(asked(command)).toBe(true);
  });
});

describe('the forms of a parameter that the words of a call are put in place of', () => {
  it.each([
    ['a default, no word given', 'g() { rm "${1:--rf}" ~; }; g'],
    ['a default, a word given', 'g() { rm "${1:-x}" "$2"; }; g -rf ~'],
    ['a default without the colon', 'g() { rm "${1--rf}" "$2"; }; g -rf ~'],
    ['a word where one is given', 'g() { rm ${1:+-rf} ~; }; g y'],
    ['the words from the second', 'g() { rm "${@:2}"; }; g x -rf ~'],
    ['the words from the first', 'g() { shift; rm "${@:1}"; }; g x -rf ~'],
    ['a count of words', 'g() { rm ${@:2:2}; }; g x -rf ~'],
    ['the words, braced', 'g() { rm ${@}; }; g -rf ~'],
    ['the words, starred', 'g() { rm "${*}"; }; g -rf ~'],
  ])('is put in place: %s', (_name, command) => {
    expect(destructive(command), command).toBe(true);
  });

  it('does not read what is put in again', () => {
    // The first word given is `'$2'`, the caller's own text: it is not the second word of this call.
    const { texts } = splitCommand('g() { rm "$1" "$2"; }; g \'$2\' -rf');

    expect(texts.some((text) => text.endsWith("{ rm '$2' -rf; }"))).toBe(true);
  });
});

describe('a function with a here-document in it', () => {
  it('is read to its end, whatever the lines of the document hold', () => {
    expect(destructive('g() {\n  cat <<EOF\n}\n" \'\nEOF\n  rm "$@"\n}\ng -rf ~')).toBe(true);
    expect(destructive('g() {\n  cat <<\'EOF\'\n$(\nEOF\n  rm "$@"\n}\ng -rf ~')).toBe(true);
    expect(destructive('g() {\n  cat <<-EOF\n\t}\n\tEOF\n  rm "$@"\n}\ng -rf ~')).toBe(true);
  });

  it('is not asked about where it is an ordinary wrapper of a script for an interpreter', () => {
    const command = [
      'run_sql() {',
      '  python3 - "$TOKEN" "$1" <<\'PY\'',
      'import sys, json',
      'print(json.dumps({"query": sys.argv[2]}))',
      'PY',
      '}',
      'run_sql "select 1"',
      'run_sql "select 2"',
    ].join('\n');

    expect(unread(command)).toBe(false);
    expect(asked(command)).toBe(false);
  });
});

describe('what the reading of functions does not read is a question, not an allow', () => {
  it('asks about a call of a function that a long run of other definitions pushed out of the read ones', () => {
    const others = Array.from({ length: 70 }, (_, i) => `f${i}() { :; };`).join(' ');
    const command = `${others} ${G} g -rf ~`;

    expect(unread(command)).toBe(true);
    expect(asked(command)).toBe(true);
  });

  it.each([
    ['a body past sixteen KiB', `g() { ${'echo x; '.repeat(3_000)} rm "$@"; }; g -rf ~`],
    ['a document that goes on past the brace', 'g() { cat <<EOF; }\nx\nEOF\ng -rf ~'],
    ['a function in the body', 'g() { h() { :; }; rm "$@"; }; g -rf ~'],
    ['a body with no end', 'g() { rm "$@"; g -rf ~'],
    [
      'a chain of six calls',
      'a() { b "$@"; }; b() { c "$@"; }; c() { d "$@"; }; d() { e "$@"; }; e() { f "$@"; }; f() { rm "$@"; }; a -rf ~',
    ],
    ['a function that calls itself', 'f() { f "$@"; }; f x'],
    ['a text past sixty-four KiB', `${G} g -rf ~ # ${'x'.repeat(70_000)}`],
  ])('asks about %s', (_name, command) => {
    expect(unread(command), command.slice(0, 80)).toBe(true);
    expect(asked(command)).toBe(true);
  });

  it('asks about a command that calls a function in more distinct texts than are read', () => {
    const calls = Array.from({ length: 300 }, (_, i) => `echo $(f ${i});`).join(' ');

    expect(unread(`f() { echo "$1"; }; ${calls}`)).toBe(true);
  });

  it('does not ask about a text past sixty-four KiB that calls nothing it defines', () => {
    expect(unread(`${G} echo ok # ${'x'.repeat(70_000)}`)).toBe(false);
  });

  it('does not ask about the ordinary uses of a function', () => {
    for (const command of [
      'die() { echo "$@" >&2; exit 1; }; [ -f x ] || die missing',
      'ls() { command ls "$@"; }; ls -la',
      'git() { command git "$@"; }; git status',
      'cd() { builtin cd "$@" && ls; }; cd src',
      'log() { echo "[$(date)] $*"; }; log start; log done',
      'cleanup() { rm -rf "$1"; }; cleanup ./build',
      'f() { echo "$1"; }; x=$(f hi); echo "$x"',
      'f() { echo "$1"; }; for i in 1 2 3; do f "$i"; done',
      'a() { b; }; b() { c; }; c() { echo c; }; a',
      'unused() { :; }; echo done',
      'a() { b; }; b() { c; }; c() { d; }; d() { e; }; e() { :; }; echo done',
      'show() { cat <<< "$1"; }; show hi',
      `${Array.from({ length: 12 }, (_, i) => `t${i}() { :; };`).join(' ')} t0; t11`,
      `f() { echo "$1"; }; ${'f a; '.repeat(300)}`,
    ]) {
      expect(unread(command), command.slice(0, 80)).toBe(false);
      expect(asked(command), command.slice(0, 80)).toBe(false);
    }
  });
});

describe('the pattern that finds a definition', () => {
  it('finds the forms of a definition, one to a command', () => {
    const found = (text: string): string[] =>
      functionsDefinedIn(text).definitions.map((definition) => definition.name);

    expect(found('f() { :; }')).toEqual(['f']);
    expect(found('f () { :; }')).toEqual(['f']);
    expect(found('function f { :; }')).toEqual(['f']);
    expect(found('function f() { :; }')).toEqual(['f']);
    expect(found('f()\n{\n  :\n}')).toEqual(['f']);
    expect(found('  f() { :; }')).toEqual(['f']);
    expect(found('a; b() { :; }')).toEqual(['b']);
    expect(found('true && b() { :; }')).toEqual(['b']);
    expect(found('if x; then g() { :; }; fi')).toEqual(['g']);
    expect(found('for i in 1; do g() { :; }; done')).toEqual(['g']);
    expect(found('{ g() { :; }; }')).toEqual(['g']);
    expect(found('a.b-c:d() { :; }')).toEqual(['a.b-c:d']);
    expect(found('echo f() { :; }')).toEqual([]);
    expect(found('echo "f() { x; }"')).toEqual([]);
  });

  it('says what it does not read: a body with a document or a function in it, or with no end', () => {
    const body = (text: string): string | null | undefined =>
      functionsDefinedIn(text).definitions[0]?.body;

    expect(body('f() { echo a; }')).toBe(' echo a; ');
    expect(body('f() { cat <<EOF\n}\nEOF\n}')).toBe(' cat <<EOF\n}\nEOF\n');
    expect(body("f() { cat <<-'X' <<Y\n\t}\n\tX\n}\nY\n}")).toBe(
      " cat <<-'X' <<Y\n\t}\n\tX\n}\nY\n",
    );
    expect(body('f() { cat <<EOF\nx\n}')).toBeNull();
    expect(body('f() ( echo a )')).toBe(' echo a ');
    expect(body('f() if x; then y; fi')).toBeNull();
    expect(body('f() ( case x in a) echo;; esac )')).toBeNull();
    expect(body(`f() { cat <<EOF\n${'x\n'.repeat(10_000)}EOF\n}`)).toBeNull();
    expect(body('f() { g() { :; }; }')).toBeNull();
    expect(body('f() { cat <<< "$1"; }')).toBe(' cat <<< "$1"; ');
    expect(body('f() { echo a')).toBeNull();
    expect(body("f() { echo '}' ; }")).toBe(" echo '}' ; ");
  });

  it('reads no more than sixty-four, and says so', () => {
    const many = Array.from({ length: 100 }, (_, i) => `f${i}() { :; };`).join(' ');

    const found = functionsDefinedIn(many);

    expect(found.definitions).toHaveLength(64);
    expect(found.crowded).toBe(true);
  });

  it('takes a time that grows with the text on the shapes that a pattern of it could be slow on', () => {
    const shapes: ReadonlyArray<readonly [string, (size: number) => string]> = [
      ['line breaks after a paren', (n) => `(${'\n'.repeat(n)}){`],
      ['line breaks and blanks', (n) => `(${'\n '.repeat(n)}){`],
      ['the keyword and blanks', (n) => `function f${' '.repeat(n)}x`],
      ['the keyword and a name, repeated', (n) => 'function f '.repeat(n)],
      ['a name and blanks', (n) => `f${' '.repeat(n)}(){`],
      ['starts and blanks', (n) => `;${' '.repeat(n)}x){`],
    ];
    for (const [name, build] of shapes) {
      const time = (size: number): number => {
        const text = build(size);
        const started = cpuNow();
        functionsDefinedIn(text);
        return cpuNow() - started;
      };
      const small = time(16_000);
      const large = time(128_000);
      expect(large < 500 || large < 20 * small, `${name}: ${small} ms, ${large} ms`).toBe(true);
    }
  });
});

describe('inheritedFunctions', () => {
  it('gives each function once, whichever texts define it', () => {
    const found = inheritedFunctions(['f() { a; }', 'f() { a; }; g() { b; }', 'echo x']);

    expect(found.definitions.map((d) => d.name)).toEqual(['f', 'g']);
    expect(found.crowded).toBe(false);
  });

  it('keeps two bodies of a name', () => {
    const found = inheritedFunctions(['f() { a; }', 'f() { b; }']);

    expect(found.definitions).toHaveLength(2);
  });
});

describe('withInlinedFunctions', () => {
  const read = (text: string, inherited: Parameters<typeof withInlinedFunctions>[4] = []) =>
    withInlinedFunctions(text, lex(text), lex, 1_000_000, inherited);

  it('puts a call in place as a group, a level at a time', () => {
    const out = read('a() { b "$@"; }; b() { echo "$1"; }; a x');

    expect(out.readings[0]).toContain('{ b x; }');
    expect(out.readings[out.readings.length - 1]).toContain('{ { echo x; }; }');
    expect(out.unread).toBe(false);
  });

  it('puts in place the calls of the functions it is given', () => {
    const given = functionsDefinedIn('f() { rm "$@"; }').definitions;

    const out = read('f -rf ~', given);

    expect(out.readings).toEqual(['{ rm -rf ~; }']);
    expect(out.unread).toBe(false);
  });

  it('is nothing where there is no function', () => {
    expect(read('echo hi')).toEqual({ readings: [], unread: false });
  });
});

describe('the time the reading of functions takes', () => {
  it('grows with the text on a long run of line breaks, which was quadratic', () => {
    const time = (size: number): number => {
      const text = `(${'\n '.repeat(size)}){`;
      const started = cpuNow();
      classifyCommand(text, CWD);
      return cpuNow() - started;
    };
    const small = time(8_000);
    const large = time(32_000);

    expect(large < 500 || large < 12 * small, `${small} ms, ${large} ms`).toBe(true);
  });
});

describe('the room that the reading of functions has', () => {
  const tools = { lexed: lex, nested: () => [], withVariables: () => [] };
  const f = functionsDefinedIn('f() { echo "$1"; }').definitions;

  it('is sixty-four kilobytes and sixteen times the command, shared by all that is read from it', () => {
    const room = newFunctionRoom(1_000);

    expect(room.chars).toBe(262_144 + 48_000);
    expect(room.read).toBe(32);
    expect(room.added).toBe(48);
  });

  it('is spent by what is added, and a call that does not fit is a question', () => {
    const room = { chars: 1_000_000, cost: 1e12, read: 1, added: 100, forms: newFormBudget() };

    const out = readFunctionCalls(['f a; echo $(f b)', 'f c; f d'], 100_000, tools, f, room);

    expect(out.unread).toBe(true);
    expect(room.read).toBe(0);
  });

  it('stops adding where the texts are too many, and asks', () => {
    const room = { chars: 1_000_000, cost: 1e12, read: 100, added: 1, forms: newFormBudget() };
    const nests = { ...tools, nested: () => ['f z'] };

    const out = readFunctionCalls(['f a; f b'], 100_000, nests, f, room);

    expect(out.found).toHaveLength(1);
    expect(out.unread).toBe(true);
  });

  it('stops adding where the texts are too long, and asks', () => {
    const room = { chars: 5, cost: 1e12, read: 100, added: 100, forms: newFormBudget() };

    const out = readFunctionCalls(['f a'], 100_000, tools, f, room);

    expect(out.found).toEqual([]);
    expect(out.unread).toBe(true);
  });

  it('is shared by the programs that the command hands to shells, which are not each given a room of their own', () => {
    const programs = Array.from({ length: 40 }, (_, i) => `bash <<EOF\nf ${i}\nEOF\n`).join('');

    expect(unread(`f() { echo "$1"; }; export -f f\n${programs}`)).toBe(true);
    expect(unread(`f() { echo "$1"; }; export -f f\n${programs.slice(0, 600)}`)).toBe(false);
  });

  it('reads a command of pieces of functions in a time that does not depend on how many programs it hands to shells', () => {
    const piece = 'f() { f "$@"; echo "$@"; }; f a; f b; f c';
    const program = (n: number): string => `bash <<EOF\n${piece}; f ${n}\nEOF\n`;
    const command = `${piece}\n${Array.from({ length: 40 }, (_, i) => program(i)).join('')}`;
    const started = cpuNow();

    classifyCommand(command, CWD);

    expect(cpuNow() - started).toBeLessThan(3_000);
  });

  it('reads a command that a fuzzer built to be slow, which took thirty-one seconds, in a short time', () => {
    const command =
      "rm fi`g }})$@EOF\ng() { ( bash -c 'export -f f; || $(xtrap eval eval $1for i in 1; do echo =command EOF\nbuiltin ${x:- }\n\\\ng $@bash -c ' }builtin || &&  ";
    const started = cpuNow();

    classifyCommand(command, CWD);

    expect(cpuNow() - started).toBeLessThan(3_000);
  });
});

describe('a script that a command runs', () => {
  const run = (script: string): readonly string[] => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-fn-script-'));
    writeFileSync(join(dir, 'x.sh'), script);
    return classifyTool('Bash', { command: 'bash x.sh' }, dir).signals;
  };

  it('is not read for the functions it defines and calls: it is read as a bag of lines', () => {
    const signals = run('g() { rm "$@";\ng -rf x\n');

    expect(signals.some((signal) => signal.endsWith('function-call-not-read'))).toBe(false);
  });

  it('is asked about for a function that is called in the command that runs it, as any command is', () => {
    const signals = classifyTool('Bash', { command: 'g() { rm "$@";\ng -rf x' }, '/tmp').signals;

    expect(signals.some((signal) => signal.endsWith('function-call-not-read'))).toBe(true);
  });
});
