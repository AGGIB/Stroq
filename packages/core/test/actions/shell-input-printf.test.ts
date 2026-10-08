import { describe, expect, it } from 'vitest';
import { shellInput, type ShellInput } from '../../src/actions/shell-input.js';

/** What a reading found, without where each text runs and on which machine. */
const plain = ({ texts, files, opaque }: ShellInput) => ({ texts, files, opaque });

describe('shellInput reads printf as printf does', () => {
  const printed = (command: string) => shellInput(command);

  it.each<[string, string]>([
    ["printf '100%%' | bash", '100%'],
    ["printf '%c' abc | bash", 'a'],
    ["printf '%s-%s' a | bash", 'a-'],
    ["printf '%s\\n%s\\n' a b c | bash", 'a\nb\nc\n\n'],
    ["printf 'no conversions' x y | bash", 'no conversions'],
    ["printf '\\101\\x42\\n' | bash", 'AB\n'],
    ["printf '%b' 'r\\0155 -rf' | bash", 'rm -rf'],
  ])('%s prints %j', (command, text) => {
    expect(plain(printed(command))).toEqual({ texts: [text], files: [], opaque: false });
  });

  it.each([
    "printf '%5s|' ab | bash",
    "printf '%-5s' 'rm -rf ~' | bash",
    "printf '%.2s' rmXX | bash",
    "printf '%*s' 0 'rm -rf ~' | bash",
    "printf '%.*s' 8 'rm -rf ~ is long' | bash",
    "printf '%b' 'r\\155 -rf ~' | bash",
    "echo 'r\\155 -rf ~' | bash",
    "printf 'rm -rf %q' '~' | bash",
  ])('does not know what %s prints, and says so', (command) => {
    expect(printed(command).opaque).toBe(true);
  });

  it('does not know what a numeric conversion prints, and says so', () => {
    expect(printed("printf 'rm -rf %d' 5 | bash").opaque).toBe(true);
    expect(printed("printf '%q' x | bash").opaque).toBe(true);
    expect(printed("printf 'a%' | bash").opaque).toBe(true);
  });

  it('does not read an option it does not know, or a variable assignment', () => {
    expect(printed("printf -v out '%s' x | bash").opaque).toBe(true);
    expect(printed("printf -x '%s' x | bash").opaque).toBe(true);
  });

  it('stops a format that is reused too many times, or that grows too large', () => {
    const many = `printf '%s' ${'x '.repeat(1100)}| bash`;
    expect(printed(many).opaque).toBe(true);
    const large = `printf '${'a'.repeat(600_000)}%s${'b'.repeat(600_000)}' x | bash`;
    expect(printed(large).opaque).toBe(true);
    expect(printed(large).texts).toEqual([]);
  });

  it('reads the here-string and here-document a cat gives on', () => {
    expect(printed("cat <<< 'rm -rf ~' | bash").texts).toEqual(['rm -rf ~']);
    expect(printed("cat <<<'rm -rf ~' | bash").texts).toEqual(['rm -rf ~']);
    expect(printed('cat <<< $X | bash').opaque).toBe(true);
    expect(plain(printed("cat <<'EOF' | bash\nrm -rf ~\nEOF"))).toEqual({
      texts: ['rm -rf ~\n'],
      files: [],
      opaque: false,
    });
    expect(printed('cat <<EOF | bash\nrm -rf $HOME\nEOF').texts).toEqual(['rm -rf $HOME\n']);
    expect(printed('cat <<EOF | bash\n$HOME/run\nEOF').opaque).toBe(true);
  });

  it('reads the file a head, tail or tac names, and the input a pipe-through takes', () => {
    expect(printed('tac x.sh | bash').files).toEqual(['x.sh']);
    expect(printed('tail -n +2 x.sh | bash').files).toEqual(['x.sh']);
    expect(printed('cat - | bash').opaque).toBe(false);
    expect(printed("echo 'rm -rf ~' | tee out.txt | bash").texts).toEqual(['rm -rf ~']);
    expect(printed("echo 'rm -rf ~' | tee -a out.txt | bash").texts).toEqual(['rm -rf ~']);
    expect(printed("echo 'rm -rf ~' | pv | bash").texts).toEqual(['rm -rf ~']);
    expect(printed('xargs cat x.sh | bash').opaque).toBe(true);
  });
});

// What a real shell runs, found by running them: a command whose payload really ran in bash
// (with a sandboxed home) was decoded or asked about in all but a few hundred of thousands. These
// are the shapes that were not, each with the reason it was missed.
