import type { Lexed } from './shell-lex.js';
import { resolve } from './shell-words.js';

/**
 * The commands a git alias runs that a command defines as it runs git: `git -c 'alias.x=!rm -rf ~' x`.
 * An alias that begins with `!` is a shell command line, and `-c` gives git a configuration for this
 * one run, so the alias is made and used in the one command; the line it holds is a text to read.
 */

/** `alias.NAME=!LINE`, as the value of `-c`. */
const ALIAS = /^alias\.[\w.-]+=!([\s\S]*)$/;

/** The command lines of the `!` aliases that the git commands of the text define with `-c`. */
export function gitAliasBodies(text: string, lexed: Lexed): string[] {
  if (!text.includes('alias.')) return [];
  const bodies: string[] = [];
  for (const pipeline of lexed.pipelines)
    for (const stage of pipeline) {
      const command = resolve(stage.text);
      if (command?.name !== 'git') continue;
      const words = command.args.map((word) => word.value);
      words.forEach((value, i) => {
        // `-c alias.x=!…`, or the two words glued: `-calias.x=!…`.
        const given =
          value === '-c' ? words[i + 1] : value.startsWith('-c') ? value.slice(2) : undefined;
        const body = given === undefined ? null : ALIAS.exec(given)?.[1];
        if (body !== undefined && body !== null && body !== '') bodies.push(body);
      });
    }
  return bodies;
}
