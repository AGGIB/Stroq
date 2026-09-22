import { describe, expect, it } from 'vitest';
import { withoutHeredocData } from '../../src/sent/heredoc.js';

const NPMRC = '~/.npmrc';

describe('withoutHeredocData', () => {
  it('drops a body that is written to a file, because nothing in it runs', () => {
    const out = withoutHeredocData(`cat > notes.md <<'EOF'\nsee ${NPMRC}\nEOF`);
    expect(out).not.toContain(NPMRC);
    expect(out).toContain('cat > notes.md');
  });

  it('drops a body appended to a file', () => {
    expect(withoutHeredocData(`cat >> plan.md <<'PLAN_EOF'\n${NPMRC}\nPLAN_EOF`)).not.toContain(
      NPMRC,
    );
  });

  it('drops a body a command reads as text, such as a commit message', () => {
    const cmd = `git commit -m "$(cat <<'EOF'\ndocs: mention ${NPMRC}\nEOF\n)"`;
    expect(withoutHeredocData(cmd)).not.toContain(NPMRC);
  });

  it('keeps a body a shell executes', () => {
    expect(withoutHeredocData(`bash <<'EOF'\ncat ${NPMRC}\nEOF`)).toContain(NPMRC);
  });

  it('keeps a body piped on into a shell', () => {
    expect(withoutHeredocData(`cat <<EOF | sh\ncat ${NPMRC}\nEOF`)).toContain(NPMRC);
  });

  it('keeps a body for a shell that sits later in a pipeline', () => {
    expect(withoutHeredocData(`true | bash <<'EOF'\ncat ${NPMRC}\nEOF`)).toContain(NPMRC);
  });

  it('keeps a body another interpreter executes', () => {
    const cmd = `python3 - <<'PY'\nprint(open('${NPMRC}').read())\nPY`;
    expect(withoutHeredocData(cmd)).toContain(NPMRC);
  });

  it('keeps a body sent to a remote shell', () => {
    expect(withoutHeredocData(`ssh host <<'EOF'\ncat ${NPMRC}\nEOF`)).toContain(NPMRC);
  });

  it('understands a tab-indented delimiter after <<-', () => {
    expect(withoutHeredocData(`cat > f <<-EOF\n\t${NPMRC}\n\tEOF`)).not.toContain(NPMRC);
  });

  it('still reads the command that follows the body', () => {
    const out = withoutHeredocData(`cat > f <<'EOF'\nprose\nEOF\ncat ${NPMRC}`);
    expect(out).toContain(`cat ${NPMRC}`);
  });

  it('keeps everything when the delimiter never closes, rather than guessing', () => {
    // Bash would read to the end of input here, but a `<<` that closes nowhere is as
    // likely to be a shift inside `$(( ))` as a heredoc, and dropping the rest of the
    // command on that guess could hide a real read.
    const cmd = `echo $((1<<n)); cat ${NPMRC}`;
    expect(withoutHeredocData(cmd)).toBe(cmd);
  });

  it('leaves a here-string alone', () => {
    const cmd = `grep token <<< "$(cat ${NPMRC})"`;
    expect(withoutHeredocData(cmd)).toBe(cmd);
  });

  it('returns a command with no heredoc unchanged', () => {
    expect(withoutHeredocData(`cat ${NPMRC} | sed 's/=.*/=***/'`)).toBe(
      `cat ${NPMRC} | sed 's/=.*/=***/'`,
    );
  });
});
