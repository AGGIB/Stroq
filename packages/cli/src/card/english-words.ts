// Words that are not a package.
//
// A flagged page says "run npx install" or "the class you want", and an agent that later runs
// `npx class` has not been told to run a package of that name by anything. The card counts a command
// as told by text only when it runs a package the text named, so a word of ordinary English (or of
// ordinary documentation: `install`, `build`, `config`) is never taken for one. The list is the most
// common English words and the words README prose is made of, plus the names of the tools that run
// packages. A real package that is also a plain word (`chalk`) is not here: it is as likely to be a
// package as a word, and the other conditions of the rule decide.
import { COMMON_WORDS } from '../sent/common-words.js';

export { COMMON_WORDS };

/** Whether a package name is one of those words. */
export const isCommonWord = (name: string): boolean => COMMON_WORDS.has(name.toLowerCase());
