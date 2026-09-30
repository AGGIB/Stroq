/**
 * `text` with each run of valid percent-escapes decoded on its own, and text that is not
 * escapes untouched. A byte sequence that is not valid UTF-8 decodes to U+FFFD rather than
 * throwing.
 *
 * `decodeURIComponent` throws on the first bad escape, and catching a throw per run costs
 * about 8 microseconds each: two million characters of undecodable runs took 8 seconds, on
 * text the agent chooses, which is past the hook's own deadline. This does the decoding
 * itself and never throws, so its cost is linear in the text.
 */
const decoder = new TextDecoder('utf-8');

export function decodePercentRuns(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i += 1)
      bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    return decoder.decode(bytes);
  });
}
