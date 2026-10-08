import { describe, expect, it } from 'vitest';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { splitCommand } from '../../src/actions/shell-segments.js';
import { cpuNow } from '../cpu-time.js';

/**
 * Commands that really delete a home directory, as a real shell runs them, found by running
 * them: a generator wrapped `rm -rf ~` in forty constructs and ran each in bash with a sandboxed
 * home, and 18% of the ones that deleted it were not flagged. These are the shapes that were not.
 */
const classes = (command: string) => classifyTool('Bash', { command }, '/tmp').classes;

describe('a command inside a command inside a command is read', () => {
  it.each([
    'echo $(echo $(rm -rf ~))',
    'x=$(echo $(echo $(rm -rf ~)))',
    'echo `echo \\`rm -rf ~\\``',
    'echo "$(echo "$(rm -rf ~)")"',
    'bash -c "bash -c \\"rm -rf ~\\""',
    'bash -c \'bash -c "rm -rf ~"\'',
    "bash -c 'bash -c '\"'\"'rm -rf ~'\"'\"''",
    'eval "bash -c \\"rm -rf ~\\""',
    'bash -c "echo $(echo $(rm -rf ~))"',
    "sh -c 'x=$(rm -rf ~)'",
    'trap "bash -c \\"rm -rf ~\\"" EXIT',
    'cat <(cat <(rm -rf ~))',
    "xargs -I{} sh -c 'xargs -I{} sh -c '\\''rm -rf ~'\\'' <<< x' <<< x",
  ])('%s', (command) => {
    expect(classes(command)).toContain('shell.destructive');
  });

  it('reads a substitution as the shell does: a comment or a quote in it closes nothing', () => {
    expect(classes("echo $(echo a # it's ( here\nrm -rf ~)")).toContain('shell.destructive');
    expect(classes('echo $(printf "%s" ")" ; rm -rf ~)')).toContain('shell.destructive');
    expect(classes("echo $(cat <<'EOF'\nit's (fine)\nEOF\n; rm -rf ~)")).toContain(
      'shell.destructive',
    );
  });

  it('still reads one that holds a case, which a reading of the parentheses cannot', () => {
    expect(classes('echo "$(case x in x) rm -rf ~;; esac)"')).toContain('shell.destructive');
  });

  it('says so when the nesting is deeper than it reads', () => {
    expect(splitCommand('echo $(a $(b $(c)))').truncated).toBe(false);
    expect(splitCommand('echo $(a $(b $(c $(d $(e $(f))))))').truncated).toBe(true);
    expect(classes('echo $(a $(b $(c $(d $(e $(f))))))')).toContain('shell.unparsed');
  });

  it('reads each nested text once, and in time proportional to the command', () => {
    const SIZE = 64 * 1024;
    const shapes = [
      `echo ${'$(a '.repeat(SIZE / 4)}${')'.repeat(SIZE / 4)}`,
      `echo ${'`a '.repeat(SIZE / 3)}`,
      `echo ${'$(a $(b $(c)) '.repeat(SIZE / 14)}`,
      `bash -c "${'bash -c \\"x\\" '.repeat(SIZE / 15)}"`,
      `echo ${'"$(a)" '.repeat(SIZE / 7)}`,
    ];
    for (const command of shapes) {
      const started = cpuNow();
      classes(command);
      // Linear takes up to a second on a quiet machine, quadratic ten: the bound is for the machine.
      expect(cpuNow() - started).toBeLessThan(5000);
    }
  });
});

describe('a quoted command word runs the command', () => {
  it.each(['"rm" -rf ~', "'rm' -rf ~", 'r"m" -rf ~', 'rm "-rf" ~', "rm '-r' '-f' ~"])(
    '%s',
    (command) => {
      expect(classes(command)).toContain('shell.destructive');
    },
  );

  it('does not unquote a word that was cut at a space inside its quotes', () => {
    expect(classes('echo "rm -rf ~"')).toEqual([]);
  });
});

describe('find that removes what it finds', () => {
  it.each([
    'find ~ -delete',
    'find ~ -exec rm -rf {} +',
    'find / -exec shred {} \\;',
    'find $HOME -type f -delete',
    'find ~ -execdir /bin/rm -rf {} \\;',
  ])('%s', (command) => {
    expect(classes(command)).toContain('shell.destructive');
  });

  it.each([
    'find . -name "*.o" -delete',
    'find /tmp/build -delete',
    'find . -exec grep x {} +',
    'find ~ -name x',
  ])('%s is routine', (command) => {
    expect(classes(command)).not.toContain('shell.destructive');
  });
});
