/**
 * Text written by someone else, made safe to show a person.
 *
 * Much of what Stroq prints or hands an agent to display was written by whoever wrote
 * what the agent read: commands, file paths, excerpts of tool output. A terminal, or
 * an agent's own interface, obeys the control sequences in that text: OSC 52 writes
 * the clipboard where it is allowed, cursor movement paints a fake line over the real
 * verdict, a direction override shows a file name reversed. Every such character is
 * written out as a visible `\uXXXX` escape instead — which is also a valid escape
 * inside a JSON string, so JSON output stays parseable and decodes to the original.
 *
 * Covered: C0 controls except tab and newline, DEL, the C1 block (0x9B is CSI on a
 * terminal that honours 8-bit controls), and the Unicode direction overrides and
 * isolates.
 */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

export function neutralizeControls(text: string): string {
  return text.replace(UNSAFE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
