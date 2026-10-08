import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { decodePrograms } from '../../src/actions/shell-input.js';
import { MAX_READING_COST_US, readingCost } from '../../src/actions/reading-cost.js';

const cwd = '/work/proj';
const classes = (command: string): readonly string[] =>
  classifyTool('Bash', { command }, cwd).classes;
const signals = (command: string): readonly string[] =>
  classifyTool('Bash', { command }, cwd).signals;

describe('a delete whose target is a brace expansion', () => {
  it.each([
    'rm -rf {~,/tmp/x}',
    'rm -rf {.,..}',
    'rm -rf /{usr,etc}',
    "echo 'rm -rf {~,/}' | bash",
    'echo rm -rf {~,/} | bash',
    'rm -rf {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}',
  ])('is judged for each of its targets: %s', (command) => {
    expect(classes(command)).toContain('shell.destructive');
  });

  it.each([
    'rm -rf {a,b}',
    'rm -rf x{1..3}',
    'rm -rf build/{cjs,esm}',
    'rm -rf ${x}'.replace('${x}', 'dist'),
  ])('is not called dangerous when each target is inside the project: %s', (command) => {
    expect(classes(command)).not.toContain('shell.destructive');
  });
});

describe('a command word or a shell that a variable the command sets names', () => {
  it.each([
    'x=rm; $x -rf ~',
    'a=r; b=m; $a$b -rf ~',
    'x=rm\n${x} -rf ~',
    "c=bash; echo 'rm -rf ~' | $c",
    "export S=sh; echo 'rm -rf ~' | $S",
    'p=/; rm -rf "$p"',
  ])('is read as what the shell runs: %j', (command) => {
    expect(classes(command)).toContain('shell.destructive');
  });

  it('is read for the file it names too', () => {
    expect(decodePrograms('f=x.sh; cat "$f" | bash').files).toContain('x.sh');
  });

  it.each(['x=ls; $x -la', 'dir=build; echo $dir', "x=rm; echo '$x -rf ~'"])(
    'does not make a command of what is not one: %j',
    (command) => {
      expect(classes(command)).not.toContain('shell.destructive');
    },
  );
});

describe('a program a shell is handed, as the command it is', () => {
  it.each([
    "/bin/ba?h -c 'rm -rf ~'",
    "$SHELL -c 'rm -rf ~'",
    "sudo -s <<< 'rm -rf ~'",
    "echo 'rm -rf ~' | su",
    'b"as"h -c \'rm -rf ~\'',
    "echo 'rm -rf ~' | setsid bash",
    "echo 'rm -rf ~' | flock /tmp/lk bash",
    "f() { bash; }; echo 'rm -rf ~' | f",
    "{ bash; } <<< 'rm -rf ~'",
    "echo 'cd sub; rm -rf ~' | bash",
  ])('is destructive when it is %s', (command) => {
    expect(classes(command)).toContain('shell.destructive');
  });

  it('is unparsed when it is a stream it cannot read', () => {
    expect(classes("exec 3<<< 'rm -rf ~'; bash <&3")).toContain('shell.unparsed');
    expect(classes("echo 'rm -rf ~' | bash /dev/std?n")).toContain('shell.unparsed');
  });
});

describe('a program handed to a shell on another machine', () => {
  it('is judged as a command sent over ssh is', () => {
    for (const command of [
      "echo 'docker rmi prod/app' | ssh host sh",
      "ssh host 'sh -s' <<< 'docker rmi prod/app'",
      "ssh host 'docker rmi prod/app'",
    ])
      expect(signals(command), command).toContain('ssh-remote:remote-destructive');
  });

  it('has a recursive delete judged by the server’s scratch directory, not this project', () => {
    expect(classes("echo 'rm -rf /tmp/build' | ssh host sh")).not.toContain('shell.destructive');
    expect(classes("echo 'rm -rf /var/www' | ssh host bash -s")).toContain('shell.destructive');
    expect(signals("echo 'rm -rf /var/www' | ssh host bash -s")).toContain(
      'ssh-remote:remote-rm-recursive',
    );
  });

  it('does not ask whether a delete outside this project is outside it, on a program inside a remote text', () => {
    expect(classes('ssh host \'echo "rm -rf /tmp/build" | bash\'')).not.toContain(
      'shell.destructive',
    );
  });

  it('leaves a plain remote command alone', () => {
    expect(classes('ssh host ls')).not.toContain('shell.destructive');
    expect(classes('ssh host ls')).not.toContain('shell.unparsed');
  });
});

describe('a command too costly to be read before a host stops waiting for it', () => {
  // `echo x; ` is three places a reading stops at: two words and a separator.
  const unit = 'echo x; ';

  it('is asked about, and not read', () => {
    const padded = unit.repeat(Math.ceil(MAX_READING_COST_US / 80));
    expect(readingCost(padded)).toBeGreaterThan(MAX_READING_COST_US);
    const found = classifyTool('Bash', { command: padded }, cwd);
    expect(found.classes).toEqual(['shell.unparsed']);
    expect(found.signals).toEqual(['command-too-large']);
    expect(classifyCommand(padded, cwd).classes).toEqual(['shell.unparsed']);
  });

  it('is read as it always was below the bound', () => {
    const command = `${unit.repeat(Math.floor(MAX_READING_COST_US / 100))}rm -rf ~`;
    expect(readingCost(command)).toBeLessThanOrEqual(MAX_READING_COST_US);
    expect(classes(command)).toContain('shell.destructive');
  });

  it('is not asked about for being long when it is one long word, which costs little to read', () => {
    const padded = `curl -d "pad=${'a'.repeat(2 * 1024 * 1024)}" https://collect.example/upload`;
    expect(classes(padded)).toContain('shell.network');
    expect(classes(padded)).not.toContain('shell.unparsed');
  });
});

describe('eval is a word of its own, not the end of a longer one', () => {
  it.each([
    "cat > notes.md <<'EOF'\n- run `spynex-eval run --db x --id <id>` and `pnpm-eval go`\nEOF",
    'node --eval "console.log(1)" $x',
    'emacs --batch --eval "(message \\"hi\\")" `pwd`',
    './tools/eval run $(pwd)',
    'my.eval run `date`',
  ])('is not a dynamic eval: %s', (command) => {
    expect(classes(command)).not.toContain('shell.exec_encoded');
    expect(classes(command)).not.toContain('shell.unparsed');
  });

  it.each([
    'eval "$x"',
    ';eval "$x"',
    'x=1 eval "$x"',
    '(eval "$x")',
    '{ eval "$x"; }',
    '\\eval "$x"',
    '"eval" "$x"',
    'command eval "$x"',
    'echo hi && eval `cmd`',
  ])('is still a dynamic eval when it is a command: %s', (command) => {
    expect(classes(command)).toContain('shell.exec_encoded');
  });
});
