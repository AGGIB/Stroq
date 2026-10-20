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

/** A program that sends what it is given over the network, as a word of its own. */
const SENDER =
  /(?:^|[\s;&|(`'"])(?:nc|ncat|netcat|socat|scp|sftp|rsync|ftp|tftp|telnet)(?:\.exe)?(?=$|[\s;&|)`'"])/i;
/** An option of curl or wget that sends a body: data, a form, a file, a post or put request. */
const UPLOAD =
  /(?:^|\s)(?:-[A-Za-z]{0,6}[dFT]|--data[a-z-]{0,12}|--form[a-z-]{0,8}|--upload-file|--json|--post-(?:data|file)|--body-(?:data|file)|-X[ \t]*(?:POST|PUT|PATCH)|--request[ =\t]*(?:POST|PUT|PATCH))(?=$|[\s=@'"])/i;
/** An address, or a program that talks to the network. */
const NETWORK =
  /:\/\/|(?:^|[\s;&|(`'"])(?:curl|wget|aria2c|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i;
/** The home folder, or a file of credentials in it, however a shell or Windows spells it. */
const SECRET_PATH =
  /\$\{?home\b|\$env:(?:userprofile|home)\b|%userprofile%|(?:^|[\s'"=:(@<])~[\\/]|\/root\/|\.ssh\b|\.aws\b|\.npmrc\b|\.netrc\b|\.git-credentials|\.docker[\\/]config|\.kube\b|\.gnupg\b|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\bcredentials\b|\/etc\/(?:passwd|shadow)\b/i;
/** A variable whose name says it holds a secret, as a shell, PowerShell, Windows or VS Code expands it. */
const SECRET_VARIABLE =
  /(?:\$\{?(?:env:|input:)?|%)[a-z0-9_]{0,40}(?:token|secret|passw(?:or)?d|credential|api_?key|private_?key|access_?key|auth|key)\b/i;

/**
 * Whether a command line, an address or a server's fields send something out: curl or wget given
 * a body, a program that only sends (`nc`, `scp`), the home folder or a credential file read
 * where the network is reached, or a variable that holds a secret put into what runs or where it
 * goes. An install script, a dev container command or a server in this shape fails when a change
 * brings it, as one that downloads and runs code does. A heuristic, linear in the text.
 */
export function sendsSecrets(text: string): boolean {
  const network = NETWORK.test(text) || SENDER.test(text);
  return (
    SENDER.test(text) ||
    (FETCHER.test(text) && UPLOAD.test(text)) ||
    (network && SECRET_PATH.test(text)) ||
    SECRET_VARIABLE.test(text)
  );
}
