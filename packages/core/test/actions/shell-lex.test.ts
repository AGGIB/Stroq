import { describe, expect, it } from 'vitest';
import { lex, lostPipe, withBackgroundEnded } from '../../src/actions/shell-lex.js';

const stages = (text: string): string[][] =>
  lex(text).pipelines.map((pipeline) => pipeline.map((stage) => stage.text));

/** The commands the lexer found inside the text, as the text of each. */
const nested = (text: string): string[] =>
  lex(text).nested.map((found) => text.slice(found.from, found.to));

describe('lex: where a comment begins', () => {
  // A comment hides what follows it. Where the reading takes a `#` for one and the shell does not,
  // a `| bash` that really runs is read as no command at all.
  it.each<[string, string, string[][]]>([
    [
      'after a line that a backslash joins',
      'echo a\\\n#; echo x | bash',
      [['echo a\\\n#'], ['echo x', 'bash']],
    ],
    [
      'after an escaped semicolon',
      'echo a\\;# x; echo y | bash',
      [['echo a\\;# x'], ['echo y', 'bash']],
    ],
    ['after an escaped blank', 'echo a\\ #; echo y | bash', [['echo a\\ #'], ['echo y', 'bash']]],
    [
      'after a no-break space, which is no blank to a shell',
      'echo a #; echo y | bash',
      [['echo a #'], ['echo y', 'bash']],
    ],
    ['after a form feed', 'echo a\f#; echo y | bash', [['echo a\f#'], ['echo y', 'bash']]],
    ['inside a word', 'echo a#b | bash', [['echo a#b', 'bash']]],
  ])('is not one %s', (_name, text, expected) => {
    expect(stages(text)).toEqual(expected);
  });

  it.each<[string, string, string[][]]>([
    ['after a blank', 'echo a # x | bash', [['echo a']]],
    ['at the start', '# echo x | bash', []],
    ['after a semicolon', 'echo a;# x | bash', [['echo a']]],
    ['after a tab', 'echo a\t# x | bash', [['echo a']]],
  ])('is one %s', (_name, text, expected) => {
    expect(stages(text)).toEqual(expected);
  });
});

describe('lex: what a dollar and a quote begin', () => {
  it('does not take a quote after an escaped dollar, or after $$, for the start of an ANSI-C string', () => {
    expect(stages("echo \\$'a\\' ; echo x | bash # '")).toEqual([
      ["echo \\$'a\\'"],
      ['echo x', 'bash'],
    ]);
    expect(stages("echo $$'\\'; echo x | bash #'")).toEqual([["echo $$'\\'"], ['echo x', 'bash']]);
  });

  it('ends an ANSI-C string at the quote an escape does not take', () => {
    expect(stages("echo $'a\\'b'; echo x | bash")).toEqual([["echo $'a\\'b'"], ['echo x', 'bash']]);
    expect(stages("echo $(echo $'\\'') ; echo x | bash # ')")).toEqual([
      ["echo $(echo $'\\'')"],
      ['echo x', 'bash'],
    ]);
  });

  it('closes a parameter expansion at the first brace, as a bare brace inside does not open another', () => {
    expect(stages('echo ${x:-{}; echo y | bash')).toEqual([['echo ${x:-{}'], ['echo y', 'bash']]);
    expect(stages('echo ${{}|cat; echo y | bash')).toEqual([
      ['echo ${{}', 'cat'],
      ['echo y', 'bash'],
    ]);
  });

  it('keeps a brace pair that holds a substitution, a quote or an expansion as one', () => {
    expect(stages('echo ${x:-$(echo a)} | bash')).toEqual([['echo ${x:-$(echo a)}', 'bash']]);
    expect(stages("echo ${x:-'}'} | bash")).toEqual([["echo ${x:-'}'}", 'bash']]);
    expect(stages('echo ${x:-${y}} | bash')).toEqual([['echo ${x:-${y}}', 'bash']]);
  });
});

describe('lex: the opener of a here-document', () => {
  it.each<[string, string]>([
    [
      'a delimiter outside the usual characters',
      "cat <<'@@' >/dev/null\nit's\n@@\necho x | bash # '",
    ],
    ['a delimiter that begins with a bang', "cat <<!EOF\nit's\n!EOF\necho x | bash # '"],
    ['a delimiter quoted in the middle', 'cat <<E"O"F\nit\'s\nEOF\necho x | bash # \''],
    ['a delimiter with a backslash in it', "cat <<E\\OF\nit's\nEOF\necho x | bash # '"],
    ['a delimiter of two words in quotes', "cat <<'a b'\nit's\na b\necho x | bash # '"],
  ])('reads %s, so the body is not shell text and the command after it is', (_name, text) => {
    const found = stages(text);
    expect(found[found.length - 1]).toEqual(['echo x', 'bash']);
    expect(lex(text).uncertain).toBe(false);
  });

  it('takes the delimiter a shell takes, not the first part of it', () => {
    // `<<E"O"F` waits for EOF: the line `EOF` ends the body, and `echo x | bash` runs.
    expect(stages('cat <<E"O"F\nEOF\necho x | bash\nE')).toEqual([
      ['cat <<E"O"F'],
      ['echo x', 'bash'],
      ['E'],
    ]);
  });

  it('is unsure of an opener it cannot read', () => {
    expect(lex('cat <<').uncertain).toBe(true);
    expect(lex("cat <<'unclosed").uncertain).toBe(true);
    expect(lex('cat <<EOF\nnever ends').uncertain).toBe(true);
  });

  it('does not take the second `<` of a here-string for an opener', () => {
    expect(lex('x=$(tr a-z A-Z <<< hello\necho hi); bash y.sh').uncertain).toBe(false);
  });
});

describe('lex: a process substitution that writes into a shell', () => {
  it('is unsure of a shell that reads what the command before it prints', () => {
    expect(lex('echo x | tee >(bash)').uncertain).toBe(true);
    expect(lex('echo x > >(bash)').uncertain).toBe(true);
    expect(lex('echo x &> >(sh)').uncertain).toBe(true);
  });

  it('is not unsure of one that writes into another command', () => {
    expect(lex('echo x | tee >(sha256sum)').uncertain).toBe(false);
    expect(lex('diff <(sort a) <(sort b)').uncertain).toBe(false);
  });
});

describe('lex: the commands that run inside a text', () => {
  it.each<[string, string, string[]]>([
    ['in a substitution', 'echo $(a $(b))', ['a $(b)']],
    ['in a double-quoted string', 'echo "$(a)"', ['a']],
    ['in a parameter expansion', 'echo ${x:-$(a)}', ['a']],
    ['after a quote that holds a substitution', "'$(' ````$(a)", ['', '', 'a']],
    ['after a comment that holds one', '#$(\n$(a)', ['a']],
    ['in a here-document that expands', 'cat <<EOF\n$(a)\nEOF', ['a']],
    ['in a process substitution', 'echo <(a) >(b)', ['a', 'b']],
    ['in an arithmetic expansion', 'echo $((1 + $(a)))', ['(1 + $(a))']],
  ])('finds one %s', (_name, text, found) => {
    expect(nested(text)).toEqual(found);
  });

  it('finds a backtick pair, in a word and in a string, and says it is one', () => {
    const found = lex('echo `a` "`b`"').nested;
    expect(found.map((n) => n.backtick)).toEqual([true, true]);
  });

  it.each<[string, string]>([
    ['a single-quoted string', "echo '$(a)'"],
    ['a comment', 'echo # $(a)'],
    ['a here-document whose delimiter was quoted', "cat <<'EOF'\n$(a)\nEOF"],
    ['an escaped dollar', 'echo \\$(a)'],
    ['a double-quoted process substitution', 'echo "<(a)"'],
    ['an ANSI-C string', "echo $'$(a)'"],
  ])('finds none in %s', (_name, text) => {
    expect(nested(text)).toEqual([]);
  });

  it('finds only the outermost: the commands inside it are found when its own text is read', () => {
    expect(nested('echo $(a $(b $(c)))')).toEqual(['a $(b $(c))']);
  });
});

describe('lex: a case arm whose pattern has a slash in it', () => {
  it('cuts the pattern off the command that follows it', () => {
    expect(stages('case $l in /*) a ;; ./*) b ;; *) c ;; esac')).toEqual([['a'], ['b'], ['c']]);
    expect(stages('case $l in /usr/*|/opt/*) a ;; esac')).toEqual([['a']]);
  });
});

describe('lex: the commands inside a test and an arithmetic', () => {
  it.each<[string, string[]]>([
    ['[[ $(rm -rf ~) ]]', ['rm -rf ~']],
    ['[[ -n `rm -rf ~` ]]', ['rm -rf ~']],
    ['(( $(a) + $(b) ))', ['a', 'b']],
    ['[[ "$(a)" == \'$(b)\' ]]', ['a']],
    ['if [[ $(a) ]]; then $(b); fi', ['a', 'b']],
    ['[[ a == b ]]', []],
  ])('finds them in %j', (text, found) => {
    expect(nested(text)).toEqual(found);
  });

  it('does not take a pipe or a separator in them for one', () => {
    expect(stages('[[ $(a | b) =~ (c|d) ]] && e')).toEqual([['[[ $(a | b) =~ (c|d) ]]'], ['e']]);
  });
});

describe('lex: nesting deeper than it reads', () => {
  it('is unsure of it, and does not overflow the stack', () => {
    for (const unit of ['"$(', '${x:-"', '$(', '$(echo "', '${x:-$(']) {
      const text = `echo ${unit.repeat(40_000)} bash`;
      expect(() => lex(text), unit).not.toThrow();
      expect(lex(text).uncertain, unit).toBe(true);
    }
  });
});

describe('lostPipe: a pipe into a shell that the first reading set aside', () => {
  it('is false for the pipes it read', () => {
    const text = 'echo x | bash';
    expect(lostPipe(text, lex(text))).toBe(false);
  });

  it('is false for the alternation of a pattern', () => {
    const text = 'case $x in (bash|dash) echo shell;; esac';
    expect(lostPipe(text, lex(text))).toBe(false);
  });

  it('does not stop at an escaped backtick or a quote that an escape does not end', () => {
    const text = "echo $'a\\'' | cat; echo x | bash";
    expect(stages(text)).toEqual([
      ["echo $'a\\''", 'cat'],
      ['echo x', 'bash'],
    ]);
  });
});

describe('lex: a case that is handed a pipe hands it to every arm', () => {
  const compound = (text: string): [string, boolean][] =>
    lex(text).pipelines.flatMap((pipeline) =>
      pipeline.map((stage): [string, boolean] => [stage.text, stage.compound]),
    );

  it('marks the commands of every arm, not only the first', () => {
    expect(compound('echo x | case x in y) :;; x) sh;; esac')).toEqual([
      ['echo x', false],
      [':', true],
      ['sh', true],
    ]);
  });

  it('marks the commands of a case that is not handed one as it did not', () => {
    expect(compound('case x in y) :;; x) sh;; esac')).toEqual([
      [':', false],
      ['sh', false],
    ]);
  });

  it('stops at the esac', () => {
    expect(compound('echo x | case x in y) :;; esac; echo done')).toEqual([
      ['echo x', false],
      [':', true],
      ['echo done', false],
    ]);
  });

  it('keeps count of cases inside cases', () => {
    expect(compound('case a in a) echo x | case b in b) cat;; esac;; esac; echo y')).toEqual([
      ['echo x', false],
      ['cat', true],
      ['echo y', false],
    ]);
  });
});

describe('lex: what stands before a case header is kept', () => {
  it('keeps the head of a function whose body begins with a case', () => {
    expect(stages('f() { case x in x) bash;; esac; }; echo hi | f')).toEqual([
      ['f() {'],
      ['bash'],
      ['}'],
      ['echo hi', 'f'],
    ]);
  });

  it('keeps a group that opens on the case', () => {
    expect(stages('echo x | { case x in x) sh;; esac; }')).toEqual([
      ['echo x', '{'],
      ['sh'],
      ['}'],
    ]);
  });
});

describe('withBackgroundEnded: a command that runs in the background ends where its `&` is', () => {
  const ended = (text: string): string => withBackgroundEnded(text, lex(text));

  it.each<[string, string]>([
    ['sleep 1&rm -rf ~', 'sleep 1;rm -rf ~'],
    ['sleep 1 & rm -rf ~', 'sleep 1 ; rm -rf ~'],
    ['(sleep 1)&rm -rf ~', '(sleep 1);rm -rf ~'],
    ['a;&b', 'a;;b'],
    ['a &', 'a ;'],
    ['a&b&c', 'a;b;c'],
  ])('writes the ampersand of %j as a semicolon', (text, expected) => {
    expect(ended(text)).toBe(expected);
    expect(ended(text)).toHaveLength(text.length);
  });

  it.each([
    'a && b',
    'a 2>&1',
    'a >&2',
    'a &> out',
    'a |& b',
    'a <&3',
    "echo 'a&b'",
    'echo "a&b"',
    'echo a\\&b',
    'echo $(true)\\&x',
    '& ./clean.ps1',
    '(& $tool)',
    '{ & x; }',
    'echo a # b & c',
    'echo $((1&2))',
    'cat <<EOF\na&b\nEOF',
  ])('leaves %j as it is', (text) => {
    expect(ended(text)).toBe(text);
  });

  it('ends every lone ampersand, quoted or not, where it is not sure it read the text', () => {
    const text = 'echo "a & rm -rf ~';
    expect(lex(text).uncertain).toBe(true);
    expect(ended(text)).toBe('echo "a ; rm -rf ~');
    expect(ended("echo 'a&b' & c &> d && e || f |& g >&2 & \"")).toBe(
      "echo 'a;b' ; c &> d && e || f |& g >&2 ; \"",
    );
    expect(ended('& x "')).toBe('& x "');
    expect(ended('a\t&\tb "')).toBe('a\t;\tb "');
  });
});
