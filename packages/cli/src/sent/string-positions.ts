// Whether a word that is the name of a folder stands where its program takes a string.
//
// `gh pr list svc` hands GitHub the string `svc`; `git push origin svc` names a branch; `curl -d svc` posts the
// text. Nothing of a folder called `svc` goes. But a program's other arguments may be paths it reads and sends
// (`gh release upload v1 svc`, `--body-file svc`, `curl -T svc`, `-d @svc`, `git -C svc`). So only the positions
// listed here are strings; any other position is taken for a path.
import type { Word } from '@stroq/core';

/** `gh` subcommands, as two words, whose arguments are search terms, names and numbers. */
const GH_STRING_COMMANDS: ReadonlySet<string> = new Set([
  'pr list',
  'pr view',
  'pr status',
  'pr checks',
  'pr diff',
  'issue list',
  'issue view',
  'issue status',
  'run list',
  'run view',
  'release list',
  'release view',
  'repo view',
  'repo list',
  'workflow list',
  'workflow view',
  'search issues',
  'search prs',
  'search repos',
  'search commits',
  'search code',
]);

/** `gh` options whose value is a string. */
const GH_STRING_OPTIONS: ReadonlySet<string> = new Set([
  '--search',
  '-S',
  '--label',
  '-l',
  '--assignee',
  '-a',
  '--author',
  '-A',
  '--repo',
  '-R',
  '--state',
  '-s',
  '--head',
  '-H',
  '--base',
  '-B',
  '--limit',
  '-L',
  '--milestone',
  '-m',
  '--json',
  '--jq',
  '-q',
  '--template',
  '-t',
  '--branch',
  '--user',
  '--app',
  '--workflow',
]);

/** `git` subcommands whose arguments are remotes and refs. */
const GIT_STRING_COMMANDS: ReadonlySet<string> = new Set(['push', 'fetch', 'pull']);

/** Options of `curl` and its kin whose value is text that is sent as it is, unless it starts with `@`. */
const CURL_STRING_OPTIONS: ReadonlySet<string> = new Set([
  '-d',
  '--data',
  '--data-raw',
  '--data-urlencode',
  '-H',
  '--header',
  '-X',
  '--request',
  '-A',
  '--user-agent',
  '-e',
  '--referer',
  '-u',
  '--user',
  '--json',
]);

const CURL_LIKE: ReadonlySet<string> = new Set(['curl', 'wget', 'http', 'https', 'xh']);

/** Where `word` is among `args`: the index of the argument that is it, or holds it after `=` or `@`. */
function indexOfWord(args: readonly Word[], word: string): number {
  const exact = args.findIndex((a) => a.value === word);
  if (exact >= 0) return exact;
  return args.findIndex((a) => a.value.endsWith(`=${word}`) || a.value.endsWith(`@${word}`));
}

/** The value of the arguments that are not options, in order, and the option each one follows (or ''). */
function positionals(args: readonly Word[]): { value: string; after: string; at: number }[] {
  const out: { value: string; after: string; at: number }[] = [];
  args.forEach((a, at) => {
    if (a.redirect || a.value.startsWith('-')) return;
    const before = args[at - 1]?.value ?? '';
    out.push({ value: a.value, after: before.startsWith('-') ? before : '', at });
  });
  return out;
}

/**
 * Whether `word`, an argument of `program`, stands where the program takes a string and not a path. False for
 * every position not listed, and for any word that is `@file`, `name=@file` or the value of an option written
 * with `=` that is not listed.
 */
export function inStringPosition(program: string, args: readonly Word[], word: string): boolean {
  const at = indexOfWord(args, word);
  if (at < 0 || word.startsWith('@') || (args[at]?.value ?? '').includes('@')) return false;
  const arg = args[at] as Word;
  const before = args[at - 1]?.value ?? '';
  const equals = arg.value.startsWith('-') ? arg.value.slice(0, arg.value.indexOf('=')) : '';
  const option = equals !== '' ? equals : before.startsWith('-') ? before : '';
  if (program === 'gh') {
    const [verb, sub] = positionals(args);
    if (verb === undefined || sub === undefined) return false;
    if (!GH_STRING_COMMANDS.has(`${verb.value} ${sub.value}`)) return false;
    return option === '' ? at > sub.at : GH_STRING_OPTIONS.has(option);
  }
  if (program === 'git') {
    const [subcommand] = positionals(args);
    if (subcommand === undefined || !GIT_STRING_COMMANDS.has(subcommand.value)) return false;
    return option === '' && at > subcommand.at;
  }
  if (CURL_LIKE.has(program)) return option !== '' && CURL_STRING_OPTIONS.has(option);
  return false;
}
