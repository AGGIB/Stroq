import { matchesPattern } from './file-glob.js';
import { KNOWN_COMMANDS, programName } from './known-commands.js';
import { baseOf, locate, readWords, type Word } from './shell-words.js';

/**
 * A stage read the way a shell reads its words, as a text of its own: what the patterns that look
 * for a command by its name are matched against, beside the stage as it is written.
 */

/**
 * The text of a stage as the shell reads its words: quotes taken off, escapes decoded, braces
 * expanded, and the command word in lower case. A pattern that looks for a command in the text then
 * sees the command that runs: `git re""set --hard` and `{git,reset,--hard}` are `git reset --hard`,
 * and `GIT` on a file system that ignores case is `git`. A word that holds white space keeps a
 * quote, so that one word does not read as several: `echo 'rm -rf ~'` prints a string, and stays
 * text. A text that ends inside a quote is returned as it is.
 */
export function plainText(text: string): string {
  const read = readWords(text);
  // A text that ends inside a quote is a piece of a string that the cut left (`set"` of
  // `grep "void\|set"`): its words are not a command, and taking its quote off would make it one.
  if (read.open) return text;
  // The words as they were written: no `eval` or `env -S` string is split again here, which would
  // copy the words for each. What they hold is read as a command of its own.
  return rendered(read.words, locate(read.words, 0).at);
}

/** A word with nothing in it that a shell reads as more than letters, digits and a few signs. */
const PLAIN_WORD = /^[\w@%+=:,./~-]+$/;

/**
 * The words as one text. A word is as it is written, except that a quote or an escape in one that is
 * plain without it is taken off (`g"i"t` is `git`), and the command word is in lower case: what
 * is not obfuscated is not another text, and a string that is only printed stays a string.
 */
function rendered(words: readonly Word[], at: number, command?: string): string {
  return words
    .map((word, i) => {
      if (i === at && command !== undefined) return command;
      // A string `env -S` is given is split into the command's words in turn: it is read as a text.
      if (i === at && !word.expands && !/\s/.test(word.value)) return programName(word.value);
      if (word.quoted && !word.expands && PLAIN_WORD.test(word.value)) return word.value;
      return (
        word.raw ?? (/\s/.test(word.value) ? `'${word.value.replace(/'/g, "'\\''")}'` : word.value)
      );
    })
    .join(' ');
}

/** The most commands a wildcard in a command word may be read as before it is taken to name any. */
const MAX_GLOBBED_COMMANDS = 12;

/**
 * The stage read once for each known command that a wildcard in its command word could name:
 * `/bin/r[m] -rf ~` runs `rm`, and `/usr/bin/gi? reset --hard` runs `git`. Only a word with a
 * directory in it is read so (one without is looked for in the directory the command is in, and
 * is a file there, not a command), and one that could name more than a few is read as none of
 * them: `broad` says the stage should be asked about, where the word is in a directory of commands.
 */
export function globbedCommands(text: string): {
  readonly texts: string[];
  readonly broad: boolean;
} {
  const none = { texts: [], broad: false };
  const read = readWords(text);
  if (read.open) return none;
  const at = locate(read.words, 0).at;
  const word = read.words[at];
  if (word === undefined || word.quoted || !word.expands || !word.value.includes('/')) return none;
  const base = baseOf(word.value);
  if (!/[*?[]/.test(base) || /[$`(]/.test(word.value)) return none;
  const names = KNOWN_COMMANDS.filter((name) => matchesPattern(base, name));
  // Only a directory of commands makes a wildcard that could name too many a question: `/*)`, an arm
  // of a `case`, and `./*` are not where a command is looked for.
  const commands = /(?:^|\/)s?bin\/$/.test(word.value.slice(0, word.value.length - base.length));
  if (names.length > MAX_GLOBBED_COMMANDS) return { texts: [], broad: commands };
  return { texts: names.map((name) => rendered(read.words, at, name)), broad: false };
}
