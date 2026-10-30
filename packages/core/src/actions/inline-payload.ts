/**
 * The words that mark an interpreter's program as one that runs code it was not shown: a decoder, a
 * dynamic import, `exec`, a way to start a process. Read in an inline program (`python3 -c '…'`,
 * `node -e '…'`) by `classify-bash.ts`, and in the strings of a Python program that was otherwise read
 * in full (`python-processes.ts`), where such a word means the string may be code.
 *
 * `Buffer.from(x, 'base64')` needs no alternative of its own: it contains `base64`, which is matched
 * anywhere already. A `Buffer\.from\([^)]*base64` alternative used to sit here, adding no match and
 * only cost: from every `Buffer.from(` with no `)` or `base64` after it, `[^)]*` rescanned the rest of
 * the segment, so 262,144 characters of them took 2.1 s in this pattern alone.
 */
export const INLINE_PAYLOAD =
  /(exec\(|base64|__import__|atob\(|child_process|subprocess|os\.system)/;
