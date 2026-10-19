/**
 * Whether a command line downloads code and runs it, or runs code it decodes or evaluates: the
 * shape of an attack rather than of a build step. An install script, a dev container command or
 * an MCP server is ordinary in an honest repository, so one that was already there is listed to
 * review; one a change adds in this shape fails (see `agent-change.ts`).
 *
 * A heuristic, not a shell parser: it errs toward the shape, and a reviewer reads what it finds.
 * Every pattern is anchored or bounded, so each test is linear in the length of the text.
 */

/** A program that downloads, as a word of its own. */
const FETCHER =
  /(?:^|[\s;&|(`'"])(?:curl|wget|aria2c|iwr|irm|invoke-webrequest|invoke-restmethod)(?:\.exe)?(?=$|[\s;&|)`'"])/i;
/** A command that runs what it is given on its input: a shell or an interpreter. */
const RUNS_INPUT =
  /^[\s(]*(?:sudo[ \t]+(?:-[A-Za-z]{1,8}[ \t]+){0,4})?(?:[^\s(]*\/)?(?:(?:ba|z|da|k|fi|tc|c)?sh|python[0-9.]{0,6}|node|perl|ruby|php|pwsh|powershell|iex|invoke-expression|bun|deno)(?:\.exe)?(?=$|[\s;&|)])/i;
/** A download whose output is the text of a command: `$(curl ...)`, `` `wget ...` ``, `<(curl ...)`. */
const SUBSTITUTED_FETCH =
  /(?:\$\(|`|<\()[ \t]*(?:curl|wget|aria2c|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i;
/** The shell's `eval` word, found in the text; nothing here runs it. */
const EVAL = /(?:^|[\s;&|(`])eval(?=$|[\s;&|)])/;
const DECODES =
  /\bbase64[ \t]+(?:-[A-Za-z]{0,4}[dD]\b|--decode\b)|\bcertutil(?:\.exe)?[ \t]+-decode\b|\bxxd[ \t]+-r\b/i;
const POWERSHELL = /(?:^|[\s;&|(])(?:powershell|pwsh)(?:\.exe)?(?=$|[\s;&|)])/i;
/** `-e`, `-ec`, `-enc` up to `-encodedcommand`: what PowerShell takes as `-EncodedCommand`. */
const ENCODED_FLAG =
  /\s[-/](?:ec|e(?:n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?)(?=\s|$)/i;
/** A shell or an interpreter given its program on its command line. */
const INLINE_PROGRAM =
  /(?:^|[\s;&|(])(?:(?:ba|z|da|k)?sh[ \t]+-[A-Za-z]{0,8}c|(?:node|deno|bun)[ \t]+(?:-e|--eval|-p)|python[0-9.]{0,6}[ \t]+-c|(?:perl|ruby)[ \t]+-[A-Za-z]{0,4}e|php[ \t]+-r)(?=$|[\s'"])/i;

/** Whether some part of a pipeline after a download is a shell or an interpreter. */
function pipesFetchToShell(text: string): boolean {
  let fetched = false;
  for (const part of text.replace(/\|\|/g, ';').split('|')) {
    if (fetched && RUNS_INPUT.test(part)) return true;
    fetched ||= FETCHER.test(part);
  }
  return false;
}

export function runsFetchedOrHiddenCode(text: string): boolean {
  return (
    pipesFetchToShell(text) ||
    SUBSTITUTED_FETCH.test(text) ||
    EVAL.test(text) ||
    DECODES.test(text) ||
    (POWERSHELL.test(text) && ENCODED_FLAG.test(text)) ||
    (INLINE_PROGRAM.test(text) && (text.includes('://') || FETCHER.test(text)))
  );
}
