// Keeping attacker-written text from driving the user's terminal.
//
// Much of what Stroq prints was written by someone else: the commands and paths in a
// recorded session, the summaries in the audit log, the names of files in a cloned
// repository. All of it traces back to content the agent read, which is the content
// an attacker controls. Printed raw, a terminal obeys the control sequences in it:
// OSC 52 writes the clipboard on terminals that allow it, cursor movement and line
// erasure paint a fake line over the real verdict, and a direction override shows a
// file name backwards. That would happen inside `stroq replay` and `stroq log` — the
// commands someone runs to find out what an injected agent did.
//
// The CLI prints no colour or control sequence of its own, so every such character in
// its output came from outside, and all of them are written out as visible `\uXXXX`
// escapes. The same form is a valid escape inside a JSON string, so `--json` output
// stays parseable and decodes to the original text.

import { neutralizeControls } from '@stroq/core';

export { neutralizeControls };

type Write = typeof process.stdout.write;

function safeWrite(original: Write, stream: NodeJS.WriteStream): Write {
  return function write(this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
    const text =
      typeof chunk === 'string'
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString('utf8')
          : String(chunk);
    return (original as (...args: unknown[]) => boolean).call(
      stream,
      neutralizeControls(text),
      ...rest,
    );
  } as Write;
}

/**
 * Runs `fn` with stdout and stderr neutralized, and restores both afterwards.
 *
 * Not for `hook` or `mcp`: there stdout is a protocol read by the agent or the MCP
 * client, and the proxy's promise is to forward what it does not judge byte for byte.
 */
export async function withSafeOutput<T>(fn: () => Promise<T>): Promise<T> {
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = safeWrite(out, process.stdout);
  process.stderr.write = safeWrite(err, process.stderr);
  try {
    return await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}
