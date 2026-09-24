/**
 * Lexical normalisation before matching, because the protected-path patterns
 * (`SELF_CONFIG_FILE`, `INSTRUCTION_FILE`) describe paths and a tool argument or a
 * shell word is a string.
 *
 * `.claude//settings.json` and `.claude/./settings.json` name the file that
 * `.claude/settings.json` names, and every one of those reached the filesystem while
 * only the last was classified. `..` is resolved for the same reason. Case is folded
 * too: macOS and Windows resolve `.CLAUDE/settings.json` to the same file, and on a
 * case-sensitive filesystem folding can only over-match, which is the direction this
 * gate is supposed to err in.
 *
 * A backslash is read as a separator first, because on Windows it is the only one the
 * agent ever sends: `.claude\settings.json` arrived here as a single segment with
 * nothing to collapse and nothing to resolve, so every evasion this function exists
 * to close — the extra slash, the `.`, the `..` — worked there untouched. On POSIX a
 * backslash is a legal filename character, so folding it can only over-match a file
 * somebody named with one, which costs a confirmation rather than opening a hole.
 *
 * Lexical, not `realpath`: resolving on disk would follow symlinks and stat files the
 * agent named, which is both slow on a hot path and a way to be pointed at something.
 * A symlink into a protected directory is therefore still uncovered, and is recorded
 * as a limit rather than implied away.
 */
export function normalizePathForMatch(path: string): string {
  // `/./` first, then the `//` it leaves behind — the other order leaves a double slash.
  const collapsed = path
    .replace(/\\/g, '/')
    .replace(/(^|\/)\.(?=\/)/g, '$1')
    .replace(/\/{2,}/g, '/');
  const segments: string[] = [];
  for (const segment of collapsed.split('/')) {
    if (segment === '..' && segments.length > 0 && segments[segments.length - 1] !== '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/').toLowerCase();
}
