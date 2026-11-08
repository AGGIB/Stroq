// Reading the words of a shell stage for a printer of the environment: `env`, `printenv`, `export -p`, a
// script that reads `environ`, and a printer inside a request's own words (`curl -d "$(env)"`).
import { shellJoined } from './needles.js';

/** Words that print the environment when given nothing else: `env`, `printenv`, `export -p`. */
const ENV_PRINTERS: ReadonlySet<string> = new Set([
  'env',
  'printenv',
  'set',
  'export',
  'declare',
  'typeset',
]);

/**
 * `environ` and `environb` in the spellings a script has them (`os.environ`, `os.environb`, `__environ`,
 * `/proc/self/environ`): not `environment`, which is a part of many addresses and sentences.
 */
const ENVIRON = /environb?(?![a-z])/i;
const HTTP_URL = /\bhttps?:\/\/[^\s'"`<>()$;|]+/gi;

/** Whether a stage prints the environment, or reads a process's (`/proc/self/environ`, `os.environ`). */
export function printsEnvironment(text: string): boolean {
  // An HTTP URL can have an /environ endpoint without reading the local environment.
  if (ENVIRON.test(text) && ENVIRON.test(text.replace(HTTP_URL, ' '))) return true;
  const words = joinedWords(text);
  const program = (words[0] ?? '').replace(/^.*\//, '');
  return ENV_PRINTERS.has(program) && words.slice(1).every((w) => /^-[pxi0u]*$/.test(w));
}

/**
 * The inner texts of the substitutions in a stage: `$(…)`, `<(…)`, `>(…)` and backticks. None in single
 * quotes. In double quotes a single quote is a plain character, `$(` and backticks still run, and `<(` and
 * `>(` do not.
 */
function substitutions(text: string): string[] {
  const out: string[] = [];
  let quote: '' | "'" | '"' = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (quote === "'") {
      if (c === "'") quote = '';
      continue;
    }
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === '"') {
      quote = quote === '"' ? '' : '"';
      continue;
    }
    if (c === "'") {
      if (quote === '') quote = "'";
      continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end < 0) break;
      out.push(text.slice(i + 1, end));
      i = end;
    } else if ((c === '$' || (quote === '' && (c === '<' || c === '>'))) && text[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < text.length && depth > 0; j += 1) {
        if (text[j] === '(') depth += 1;
        else if (text[j] === ')') depth -= 1;
      }
      out.push(text.slice(i + 2, depth === 0 ? j - 1 : j));
      i += 1;
    }
  }
  return out;
}

/**
 * Whether a stage's own words embed a printer of the environment (`curl -d "$(env)"`, `--data
 * @<(printenv)`, `wget --post-data="$(set)"`, a here-string of `$(env)`): what it printed is the
 * request's own data, though no stage before it printed it.
 */
export const embedsPrinter = (text: string): boolean => substitutions(text).some(printsEnvironment);

const joinedWords = (text: string): string[] =>
  shellJoined(text)
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
