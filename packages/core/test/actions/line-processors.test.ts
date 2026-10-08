import { describe, expect, it } from 'vitest';
import { awkRunsCommands, lineProcessing } from '../../src/actions/line-processors.js';
import { resolve } from '../../src/actions/shell-words.js';

/**
 * Whether what is piped into awk, sed, make, at, m4, ed or ex is run. These read data in most of the
 * forms an agent writes and run it in a few, and the few are where a fetch piped into one is a program.
 * A second review found awk's `print | c` (the destination of the pipe is a name, not a string) running
 * a fetched line as a command.
 */

const run = (text: string) => {
  const found = resolve(text);
  return found === null ? 'none' : lineProcessing(found.name, found.args);
};

describe('an awk program that runs a command', () => {
  it.each([
    '{ print | c }',
    '{ print | (c) }',
    '{ print | ("s" "h") }',
    '{ print $0 | cmd }',
    '{ printf "%s\\n", $0 | "sh" }',
    '{ "date" | getline d; print d }',
    '{ cmd | getline x }',
    '{ while (("ls" | getline l) > 0) print l }',
    'BEGIN { print "x" |& "cat" }',
    '{ system($0) }',
    '{ system ("echo x") }',
    '{ r = system(cmd) }',
    '{ print } END { print | "sh" }',
    '/a/ { print | c }',
    '{ x = $1 / 2; print | c }',
    '{ print \\\n | "sh" }',
    // What cannot be read to its end is taken to run one.
    '{ print "unterminated }',
    '$0 ~ /unterminated { print }',
    '{ x = "a\nb" }',
  ])('is read as one: %s', (program) => {
    expect(awkRunsCommands(program)).toBe(true);
  });

  it.each([
    '{ print $1 }',
    '{ print $1, $2 }',
    '/a|b/ { print $2 }',
    '$1 ~ /a|b|c/ { n += 1 } END { print n }',
    '{ print "a|b" }',
    '{ x = $1 / 2; print x }',
    '{ a = 4 / 2 / 1; print a }',
    '{ if (a || b) print }',
    '{ if (a && b || c) print }',
    '# a comment with | "sh" and system(x)\n{ print }',
    '{ gsub(/\\//, "|"); print }',
    '{ print > "/dev/stderr" }',
    '$0 ~ "a|b" { print }',
    '{ print $NF / 2 }',
    '{ i++ / 2; print i }',
    '/[|]/ { print }',
    '/[/]|x/ { print }',
    '{ s = sprintf("%s|%s", $1, $2); print s }',
    'NR % 2 == 0',
    '{ print length($0) }',
    '{ system_name = $1; print system_name }',
    'BEGIN { FS = "|" } { print $2 }',
    '{ n = split($0, parts, "|"); print n }',
  ])('is read as only reading: %s', (program) => {
    expect(awkRunsCommands(program)).toBe(false);
  });

  it('does not take a `/` after an operand for a regular expression, so that a `|` after it is read', () => {
    // `x / 2 | "sh"` is a division and a pipe; read as a regular expression it would hide the pipe.
    expect(awkRunsCommands('{ print x / 2 | "sh"; y = 4 / 2 }')).toBe(true);
    expect(awkRunsCommands('{ print (x) / 2 | "sh"; y = 4 / 2 }')).toBe(true);
    expect(awkRunsCommands('{ print a[1] / 2 | "sh"; y = 4 / 2 }')).toBe(true);
    expect(awkRunsCommands('{ print i++ / 2 | "sh"; y = 4 / 2 }')).toBe(true);
  });
});

describe('what awk is told to run', () => {
  it.each([
    ['awk -f -', 'program'],
    ['awk -f /dev/stdin', 'program'],
    ['gawk -f/dev/stdin', 'program'],
    ['awk -F: -f -', 'program'],
    ['gawk -E /dev/stdin', 'program'],
    ['gawk --exec=-', 'program'],
    ['gawk -i /dev/stdin', 'program'],
    ['gawk --include=-', 'program'],
    ["gawk -e '{ print | c }'", 'program'],
    ["gawk --source '{ system($0) }'", 'program'],
    ["awk -v c=sh '{print | c}'", 'program'],
    ["awk '{ system($0) }'", 'program'],
    ['awk "{ system(\\"x\\") }"', 'program'],
    // The shell makes the program: it is not what is written.
    ['awk "{ print $x }"', 'program'],
    ["awk '{print $1}'", 'none'],
    ["awk -F'|' '{print $2}'", 'none'],
    ["awk -F '|' '{print $2}'", 'none'],
    ["awk -F: -v x=1 '/a|b/ {print x}'", 'none'],
    ["awk -v 'sep=|' '{print $1 sep $2}'", 'none'],
    ['awk -f prog.awk data.txt', 'none'],
    ["awk '{print $1}' a.txt b.txt", 'none'],
  ])('%s is %s', (command, expected) => {
    expect(run(command)).toBe(expected);
  });
});

describe('what sed is told to run', () => {
  it.each([
    ['sed e', 'program'],
    ["sed 'e'", 'program'],
    ["sed '1e date'", 'program'],
    ["sed -e'e'", 'program'],
    ['sed -e e', 'program'],
    ['sed --expression=e', 'program'],
    ['sed --expression e', 'program'],
    ['sed -ne e', 'program'],
    ["sed -n -e '/x/e'", 'program'],
    ['sed -es/x/y/e', 'program'],
    ["sed 's/x/y/e'", 'program'],
    ["sed 's/x/y/ge'", 'program'],
    ["sed 's#x#y#e'", 'program'],
    ["sed 's|x|y|Ie'", 'program'],
    ["sed '\\,x,e'", 'program'],
    ["sed '\\|x|e'", 'program'],
    ["sed '/x/I e'", 'program'],
    ["sed '$!N;e'", 'program'],
    ["sed '1,+2e'", 'program'],
    ["sed '0,/a/e'", 'program'],
    ["sed '/a/{p;e}'", 'program'],
    ['sed -f -', 'program'],
    ['sed -nf /dev/stdin', 'program'],
    ['sed --file=-', 'program'],
    ["sed -i '' e file", 'program'],
    ["sed -n 'p;e' -e p", 'program'],
    ['sed "$prog"', 'program'],
    ['sed -n 5p', 'none'],
    ["sed 's/a/b/'", 'none'],
    ["sed -e 's/a/b/' -e 's/c/d/'", 'none'],
    ["sed 's/e/E/'", 'none'],
    ["sed 's/e/e/g'", 'none'],
    ["sed 'y/e/E/'", 'none'],
    ["sed -E 's/(e)/x/'", 'none'],
    ["sed -i.bak 's/a/b/' file", 'none'],
    ["sed -ibak 's/a/b/' file", 'none'],
    ["sed --expression='s/e/e/'", 'none'],
    ["sed '/^e/d'", 'none'],
    ["sed 's/.*/echo &/'", 'none'],
    ["sed -n '/start/,/end/p'", 'none'],
    ["sed -s -n 'p' a b", 'none'],
  ])('%s is %s', (command, expected) => {
    expect(run(command)).toBe(expected);
  });
});

describe('what make, at and the editors are told to run', () => {
  it.each([
    ['make -f -', 'program'],
    ['make -f /dev/stdin all', 'program'],
    ['make --file=-', 'program'],
    ['gmake -f-', 'program'],
    ['make -j4', 'none'],
    ['make -n', 'none'],
    ['make -f Makefile all', 'none'],
    ['at now', 'program'],
    ['batch', 'program'],
    ['at -f job.sh now', 'none'],
    ['m4', 'program'],
    ['m4 -', 'program'],
    ['ed -s file', 'program'],
    ['ex -s', 'program'],
  ])('%s is %s', (command, expected) => {
    expect(run(command)).toBe(expected);
  });
});
