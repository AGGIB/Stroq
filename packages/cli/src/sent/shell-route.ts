// Where one stage of a shell command put a key that reached it (`shell-read.ts`), and whether a
// command can send at all.
//
// A command any stage of which can send (`commandSends`) is judged whole by `shell-place.ts`: it
// sent the key to another company unless the strict proof of the key's own use holds
// (`strict-own.ts`). What a stage says here is only where the report says it went: the hosts the
// core reads in a request, `gh` and what it posts, a hosting tool that stores a secret. A stage
// that only reads or prints showed the key to the AI, and any other ran with it, and may have sent
// it anywhere.
import { commandUrls, REDIRECT, type Word } from '@stroq/core';
import { isHostShape, isProgramName } from './names.js';
import { wordHosts } from './url-hosts.js';
import { farther, hostPlace, type KeyOf, type Place } from './place.js';
import type { CommandReading, Reach, Stage, StageFacts } from './shell-read.js';

const MAX_URLS = 64;

/**
 * Words that send a request somewhere other than the hosts a command names, or say that its
 * hosts cannot all be read: matched anywhere in the command, in any case. The agreed list, and
 * the same kind of word beside it (`proxy` covers `http.proxy`, `--noproxy` is caught too).
 */
const ROUTE_WORDS: readonly string[] = [
  '_proxy=',
  'all_proxy',
  '--proxy',
  '--preproxy',
  '--socks',
  '--resolve',
  '--connect-to',
  '--config',
  'use_proxy',
  '/dev/tcp',
  '/dev/udp',
  '/inet',
  'proxycommand',
  'proxyjump',
  'hostname',
  'proxy',
  '--doh-url',
  'unix-socket',
  'curlrc',
  'wgetrc',
  'curl_home',
  'insteadof',
  'git_config',
  'sshcommand',
  'git_ssh',
  // Where curl and wget look for their config files, and what decides where a name resolves or
  // what a program loads before it connects.
  'home=',
  '/etc/hosts',
  'resolv.conf',
  'hostaliases',
  'res_options',
  'localdomain',
  'ld_preload',
  'dyld_insert',
];
/**
 * Short options that do the same, matched in their own case: `-x` a proxy, `-K` options read from
 * a file, `-J` a jump host (`-X POST` and `-k` are other options).
 */
const ROUTE_SHORT: readonly string[] = ['-x ', '-K ', '-J '];
/** The same letters in a stage's own options, alone or in a cluster: `-xhost`, `-sx host`. */
const ROUTE_LETTERS = /^-[A-Za-z]*[xKJ]/;
/** And ssh's `-F`, a configuration file that can send the connection anywhere. */
const SSH_LETTERS = /^-[A-Za-z]*F/;
const SSH_FAMILY: ReadonlySet<string> = new Set(['ssh', 'scp', 'sftp', 'rsync', 'mosh']);

/**
 * Whether a command holds a word that can send its requests somewhere it does not name: in its
 * text as written, and as the shell joins its words (quotes and backslashes taken out, so
 * `http_pro""xy=` is `http_proxy=`), or a step that sets a variable whose name is not written
 * out, or runs text that may set any (`setsUnwrittenName`).
 */
export function routesElsewhere(command: string): boolean {
  const lower = command.toLowerCase();
  const joined = joinedText(command);
  const joinedLower = joined.toLowerCase();
  return (
    ROUTE_WORDS.some((word) => lower.includes(word) || joinedLower.includes(word)) ||
    ROUTE_SHORT.some((word) => command.includes(word) || joined.includes(word)) ||
    setsUnwrittenName(joined)
  );
}

/** A text as the shell joins its words: the quotes and backslashes that split them taken out. */
export const joinedText = (text: string): string => text.replace(/['"\\]/g, '');

/** Builtins that set a variable named by a word: `export`, `read`, `env`, … */
const SETTERS: ReadonlySet<string> = new Set([
  'export',
  'declare',
  'typeset',
  'readonly',
  'local',
  'env',
  'read',
  'set',
  'setenv',
  'let',
  'unset',
  'mapfile',
  'readarray',
  'getopts',
]);
/** Builtins that run text: what it sets cannot be read. */
const SOURCES: ReadonlySet<string> = new Set(['eval', 'source', '.']);
/** Words after which the next word is a command: `bash -c`, `sudo`, `command`. */
const RUNS_NEXT = /^(?:-[A-Za-z]*c|sudo|command|builtin|exec|nohup|time|then|do|else)$/;

/**
 * Whether a command, its words joined, sets a variable whose name is not written out or runs text
 * that may set any: a word that expands before its `=` (`http_${P}xy=`, `$'…'=`), a setter given a
 * word that expands into names (`export $(cat f)`, `read -r $N`, `printf -v "$n"`), or `eval`,
 * `source` or `.` where a command starts. Read word by word, at blanks and the shell's operators.
 */
export function setsUnwrittenName(joined: string): boolean {
  let start = true;
  let setter = false;
  let previous = '';
  // Words and what is between them, in turn: an operator starts a new command.
  for (const word of joined.split(/([\s;&|()]+)/)) {
    if (word === '') continue;
    if (/^[\s;&|()]+$/.test(word)) {
      if (/[;&|()\n]/.test(word)) {
        start = true;
        setter = false;
      }
      continue;
    }
    const at = start || RUNS_NEXT.test(previous);
    if (at && SOURCES.has(word)) return true;
    const expands = word.search(/[$`]/);
    const eq = word.indexOf('=');
    if (expands >= 0 && eq > expands) return true;
    if (setter && expands >= 0 && eq < 0) return true;
    if ((at && SETTERS.has(word)) || (previous === 'printf' && word === '-v')) setter = true;
    previous = word;
    start = false;
  }
  return false;
}

/** Whether a stage's own options route it elsewhere: `-x`, `-K`, `-J`, and ssh's `-F`. */
function stageRoutesElsewhere(name: string, args: readonly Word[]): boolean {
  return args.some(
    (w) =>
      !w.redirect &&
      !w.value.startsWith('--') &&
      (ROUTE_LETTERS.test(w.value) || (SSH_FAMILY.has(name) && SSH_LETTERS.test(w.value))),
  );
}

/**
 * Options whose value is the next word, by family, so that the value is not read as where the
 * request goes. A destination is any other word that is not an option (a bare host the core does
 * not read, as it reads only addresses with a scheme); a word the table does not know is read as
 * one, which can only make a stage another company's.
 */
const CURL_VALUES = new Set(
  (
    '-d --data --data-raw --data-binary --data-ascii --data-urlencode --json -H --header -X ' +
    '--request -o --output --output-dir -u --user -F --form --form-string -A --user-agent -e ' +
    '--referer -b --cookie -c --cookie-jar -T --upload-file -m --max-time --connect-timeout -w ' +
    '--write-out --cacert --cert -E --key -r --range --retry -U --proxy-user --interface -D ' +
    '--dump-header --oauth2-bearer --aws-sigv4 --variable --url-query -C --continue-at -y -Y -z ' +
    '--limit-rate --max-redirs -Q --quote --trace --trace-ascii --stderr --retry-delay ' +
    '--retry-max-time --keepalive-time --max-filesize --speed-limit --speed-time --ciphers ' +
    '--tls-max --proto --proto-redir --capath --pinnedpubkey --crlfile --netrc-file --pubkey ' +
    '--cert-type --key-type --pass --expect100-timeout --etag-save --etag-compare --hsts'
  ).split(' '),
);
const WGET_VALUES = new Set(
  (
    '-O --output-document -o --output-file -a --append-output --header --post-data --post-file ' +
    '--body-data --body-file --method -U --user-agent --user --password --http-user ' +
    '--http-password -P --directory-prefix -t --tries -T --timeout -w --wait --referer ' +
    '--load-cookies --save-cookies -B --base --ca-certificate --certificate --private-key'
  ).split(' '),
);
const HTTPIE_VALUES = new Set(
  (
    '-a --auth -A --auth-type --session --session-read-only -o --output --verify --cert ' +
    '--cert-key -p --print --pretty -s --style --timeout --max-redirects --boundary'
  ).split(' '),
);
const PS_VALUES = new Set(
  (
    '-method -body -headers -outfile -infile -contenttype -useragent -credential -timeoutsec ' +
    '-form -websession -sessionvariable -certificate -maximumredirection'
  ).split(' '),
);
const SSH_VALUES = new Set('-i -p -o -l -F -J -L -R -D -e -P -c -m -b -E -S -W -w'.split(' '));
const NC_VALUES = new Set('-p -s -w -i -I -O -q -T -V -W -e -c -X -x'.split(' '));

const VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  curl: CURL_VALUES,
  curlie: CURL_VALUES,
  wget: WGET_VALUES,
  http: HTTPIE_VALUES,
  https: HTTPIE_VALUES,
  xh: HTTPIE_VALUES,
  xhs: HTTPIE_VALUES,
  httpie: HTTPIE_VALUES,
  'invoke-webrequest': PS_VALUES,
  'invoke-restmethod': PS_VALUES,
  iwr: PS_VALUES,
  irm: PS_VALUES,
  ssh: SSH_VALUES,
  scp: SSH_VALUES,
  sftp: SSH_VALUES,
  rsync: SSH_VALUES,
  nc: NC_VALUES,
  ncat: NC_VALUES,
  netcat: NC_VALUES,
};
const HTTPIE: ReadonlySet<string> = new Set(['http', 'https', 'xh', 'xhs', 'httpie']);
const HTTP_METHOD = /^[A-Z]{3,7}$/;

/** The words of a stage that are not options, nor their values, nor redirects. */
function positionals(name: string, args: readonly Word[]): string[] {
  const values = Object.hasOwn(VALUES, name) ? VALUES[name] : undefined;
  const anyCase = name.startsWith('invoke-') || name === 'iwr' || name === 'irm';
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word;
    if (word.redirect) {
      // An operator alone (`>`, `2>`) takes the next word as its file.
      if (REDIRECT.exec(word.value)?.[0].length === word.value.length) i += 1;
      continue;
    }
    const option = anyCase ? word.value.toLowerCase() : word.value;
    if (option.startsWith('-') && option !== '-') {
      if (values?.has(option) === true) i += 1;
      continue;
    }
    out.push(word.value);
  }
  return out;
}

/**
 * Whether a request stage may go to a destination the core did not read: a word that is not an
 * option, a value, a URL the core read, or (for HTTPie) its method or a request item. `git` names
 * where it pushes by the URL the core reads, and its other words are refs.
 */
function unreadDestination(name: string, args: readonly Word[]): boolean {
  if (name === 'git') return false;
  // `wget -i file`, `-iurls.txt`, `--input-file=…`, `aria2c -i`: more addresses, in a file.
  if (
    (name === 'wget' || name === 'aria2c') &&
    args.some(
      (w) =>
        !w.redirect &&
        (/^-[A-Za-z]*i/.test(w.value) || /^--(?:input-file|base|input-metalink)/.test(w.value)),
    )
  )
    return true;
  let words = positionals(name, args).filter((w) => !/\s/.test(w));
  if (HTTPIE.has(name)) {
    const url = words.findIndex((w) => !HTTP_METHOD.test(w));
    words = url < 0 ? [] : [words[url] as string];
  }
  // ssh's target is read by the core as `user@host`; a bare target, a second word (what ssh runs
  // there, a file scp or rsync copies to `host:path`) is not read, and may send it anywhere.
  if (SSH_FAMILY.has(name)) return words.length !== 1 || !(words[0] ?? '').includes('@');
  return words.some((w) => !w.includes('://'));
}

/** Words that put what is sent in a body: `-d`, `--data…`, `--json`, `-F`, `-T`, `@file`, `--body`. */
const BODY_LONG =
  /^--?(?:data|json|form|upload-file|body|post-data|post-file|field|raw-field|input|infile)/i;
const BODY_LETTERS = /^-[A-Za-z]*[dFT]/;

/** Whether a stage sends a body or uploads a file (`gh` too: `-f`, `-b`). */
function sendsBody(name: string, args: readonly Word[]): boolean {
  const gh = name === 'gh';
  if (
    HTTPIE.has(name) &&
    positionals(name, args)
      .slice(1)
      .some((w) => /[=@]/.test(w))
  )
    return true;
  return args.some((w) => {
    if (w.redirect) return false;
    const v = w.value;
    if (v.startsWith('@') || v.includes('=@')) return true;
    if (BODY_LONG.test(v)) return true;
    if (v.startsWith('--')) return false;
    return BODY_LETTERS.test(v) || (gh && /^-[A-Za-z]*[fb]/.test(v));
  });
}

/**
 * The program a phrase may name: none for a word that holds the key, or is no name. A key with no
 * value (Stroq's own log names keys and keeps no value) is in every text, and hides no name.
 */
export function shownName(facts: StageFacts, holds: (text: string) => boolean): string {
  const word = facts.resolved?.word ?? '';
  if (word !== '' && holds(word) && !holds('')) return '';
  return isProgramName(facts.name) ? facts.name : '';
}

const detailOf = (name: string): { readonly detail?: string } =>
  name === '' ? {} : { detail: name };

/** The values of a stage's words, as the shell hands them to the program. */
const wordValues = (facts: StageFacts): string[] =>
  (facts.resolved?.args ?? []).filter((w) => !w.redirect).map((w) => w.value);

/**
 * The hosts a request stage reads, and whether its destinations were all read: in its text as it
 * is written, and in its words as the program is given them, read the program's way too.
 */
function hostsOf(reach: Reach, facts: StageFacts): { hosts: string[]; unread: boolean } {
  const read = commandUrls(`${reach.stage.text}\n${reach.stage.body}`, MAX_URLS);
  const words = wordHosts(wordValues(facts));
  const hosts = [...read.urls.map((u) => u.host.toLowerCase()), ...words.hosts];
  const args = facts.resolved?.args ?? [];
  const unread =
    read.capped ||
    words.unread ||
    hosts.length === 0 ||
    hosts.includes('') ||
    unreadDestination(facts.name, args) ||
    stageRoutesElsewhere(facts.name, args);
  return { hosts: hosts.filter((h) => h !== ''), unread };
}

/**
 * Whether an address the stage is given holds the key past where it signs in: in its path, its
 * query or its fragment (a message's text, a file's name), not its user and password. Read in
 * its text and in its words as the program is given them.
 */
function keyInAddress(reach: Reach, facts: StageFacts, holds: (text: string) => boolean): boolean {
  const addresses = [
    ...commandUrls(reach.stage.text, MAX_URLS).urls.map((u) => u.url),
    ...wordValues(facts).filter((w) => w.includes('://')),
  ];
  return addresses.some((address) => holds(pastAuthority(address)));
}

/** What an address holds past its authority: from the first `/`, `?`, `#` or `\` after `://`. */
function pastAuthority(address: string): string {
  const scheme = address.indexOf('://');
  const from = scheme < 0 ? 0 : scheme + 3;
  for (let i = from; i < address.length; i += 1)
    if ('/?#\\'.includes(address[i] as string)) return address.slice(i);
  return '';
}

/** Where a request stage put the key. */
function requestPlace(
  reach: Reach,
  facts: StageFacts,
  reading: CommandReading,
  key: KeyOf,
  name: string,
  holds: (text: string) => boolean,
): Place {
  const { hosts, unread } = hostsOf(reach, facts);
  const args = facts.resolved?.args ?? [];
  const route =
    facts.name === 'git'
      ? 'git-push'
      : publishes(facts.name, args)
        ? 'publish'
        : SSH_FAMILY.has(facts.name)
          ? 'ssh'
          : 'command';
  return hostPlace(
    hosts,
    key,
    { route, tool: 'Bash', ...detailOf(name) },
    {
      unread,
      routed: routesElsewhere(reading.command),
      body: sendsBody(facts.name, args) || keyInAddress(reach, facts, holds),
    },
  );
}

/** `git` verbs that talk to another machine, wherever they stand in its words. */
const GIT_NETWORK: ReadonlySet<string> = new Set([
  'push',
  'pull',
  'fetch',
  'clone',
  'ls-remote',
  'submodule',
  'remote',
  'send-email',
  'request-pull',
  'archive',
  'svn',
  'p4',
  'lfs',
]);

/**
 * Whether a stage can send what it holds to another machine: the core reads it as a request (or
 * it is a sender, or writes to a network file), it is `gh`, a `git` that talks to a remote, or a
 * package publish.
 */
export function stageSends(facts: StageFacts): boolean {
  if (facts.network || facts.name === 'gh') return true;
  const args = facts.resolved?.args ?? [];
  if (publishes(facts.name, args)) return true;
  return facts.name === 'git' && args.some((w) => !w.redirect && GIT_NETWORK.has(w.value));
}

/** Every stage of a command the core cut, nested texts and the plain cut too. */
export const allStages = (reading: CommandReading): readonly Stage[] => [
  ...reading.run.flat(2),
  ...reading.plain.flat(),
];

/** The stages the lexer cut, nested texts too, and the plain cut where the lexer was not sure. */
export const runStages = (reading: CommandReading): readonly Stage[] => reading.run.flat(2);

/**
 * Whether any stage of a command can send: the whole command is judged, not only the stage that
 * holds the key, so a command that makes any request may have sent what it holds.
 */
export function commandSends(reading: CommandReading): boolean {
  return reading.sends() || allStages(reading).some((stage) => stageSends(reading.facts(stage)));
}

/** Programs that send mail: what they are given goes to the address they are given. */
const MAILERS: ReadonlySet<string> = new Set([
  'mail',
  'mailx',
  'nail',
  's-nail',
  'sendmail',
  'mutt',
  'msmtp',
  'ssmtp',
  'swaks',
]);

/**
 * Programs that can send what they are piped though no list of requests holds them: a mailer,
 * `openssl s_client` (a TLS connection), and `git credential` or a credential helper, which hands
 * a password to a program that may store it anywhere.
 */
export function halfSender(facts: StageFacts): boolean {
  if (MAILERS.has(facts.name)) return true;
  const words = wordValues(facts);
  if (facts.name === 'openssl') return words.some((w) => w === 's_client' || w === 's_time');
  return (
    facts.name === 'git' &&
    words.some(
      (w) => w === 'credential' || w.startsWith('credential-') || w.includes('credential.'),
    )
  );
}

/** A `host=` line, as `git credential` reads one, in a command or what it is fed (`\\n` too). */
const CREDENTIAL_HOST = /(?:^|[\s'"]|\\n)host=([A-Za-z0-9.-]{1,253})/;

/**
 * Where a command that holds a half-sender says it sends: an address with a scheme, the host of
 * `openssl s_client -connect`, the domain of a mail address, a `host=` for `git credential`.
 * Null when it names none.
 */
function visibleDestination(reading: CommandReading, stages: readonly Stage[]): string | null {
  const url = commandUrls(reading.command, MAX_URLS).urls.find((u) => u.host !== '');
  if (url !== undefined) return url.host.toLowerCase();
  for (const stage of stages) {
    const facts = reading.facts(stage);
    const words = wordValues(facts);
    if (facts.name === 'openssl') {
      const at = words.indexOf('-connect');
      const target = at >= 0 ? (words[at + 1] ?? '') : '';
      const host = target.split(':')[0] ?? '';
      if (host !== '') return host.toLowerCase();
    }
    if (MAILERS.has(facts.name)) {
      const address = words.find((w) => !w.startsWith('-') && w.includes('@'));
      const host = address === undefined ? '' : address.slice(address.lastIndexOf('@') + 1);
      if (host !== '') return host.toLowerCase();
    }
  }
  // What `git credential` is fed: printed into it, or in a here-string or a heredoc.
  const line = CREDENTIAL_HOST.exec(reading.command)?.[1];
  return line === undefined ? null : line.toLowerCase();
}

/**
 * A command with a half-sender in it: another company where it names a destination, else maybe.
 * Null for a command with none.
 */
export function halfSenderPlace(reading: CommandReading): Place | null {
  const stages = allStages(reading).filter((stage) => halfSender(reading.facts(stage)));
  const first = stages[0];
  if (first === undefined) return null;
  const name = reading.facts(first).name;
  const host = visibleDestination(reading, stages);
  const base = { tool: 'Bash', ...detailOf(isProgramName(name) ? name : '') } as const;
  return host === null
    ? { ...base, tier: 'maybe', route: 'command-ran' }
    : { ...base, tier: 'third_party', route: 'command', host };
}

/** Package managers by the verb that publishes: a key in that command went to a registry. */
const PUBLISH_VERBS: Readonly<Record<string, string>> = {
  npm: 'publish',
  pnpm: 'publish',
  yarn: 'publish',
  bun: 'publish',
  cargo: 'publish',
  gem: 'push',
  docker: 'push',
  twine: 'upload',
};

/** Whether a stage publishes a package (`npm publish`, `python -m twine upload`). */
export function publishes(name: string, args: readonly Word[]): boolean {
  const words = args.filter((w) => !w.redirect && !w.value.startsWith('-')).map((w) => w.value);
  if (/^python3?$/.test(name)) return words[0] === 'twine' && words[1] === 'upload';
  const verb = Object.hasOwn(PUBLISH_VERBS, name) ? PUBLISH_VERBS[name] : undefined;
  return verb !== undefined && words.slice(0, 2).includes(verb);
}

/** The host a value given to `gh` names (`h`, `https://h/o/r`, `h/o/r`), or null for none. */
function ghHost(value: string, repo: boolean): string | null | 'unread' {
  const scheme = value.indexOf('://');
  const rest = scheme >= 0 ? value.slice(scheme + 3) : value;
  const parts = rest.split('/');
  if (repo && scheme < 0 && parts.length < 3) return null;
  const host = (parts[0] ?? '').split(':')[0]?.toLowerCase() ?? '';
  return host !== '' && isHostShape(host) && !host.includes('$') ? host : 'unread';
}

/**
 * The hosts `gh` is told to use anywhere in a command: `--hostname`, `GH_HOST`, a repository on
 * another host (`-R h/o/r`, `--repo`, `GH_REPO`). Every one is read, wherever it stands.
 */
export function ghHosts(command: string): { readonly hosts: string[]; readonly unread: boolean } {
  const words = command.split(/[\s;&|()<>`'"]+/);
  const hosts: string[] = [];
  let unread = false;
  const add = (found: string | null | 'unread'): void => {
    if (found === 'unread') unread = true;
    else if (found !== null) hosts.push(found);
  };
  for (const [i, w] of words.entries()) {
    const next = words[i + 1] ?? '';
    if (w.startsWith('GH_HOST=')) add(ghHost(w.slice(8), false));
    else if (w.startsWith('GH_REPO=')) add(ghHost(w.slice(8), true));
    else if (w === '--hostname') add(ghHost(next, false));
    else if (w.startsWith('--hostname=')) add(ghHost(w.slice(11), false));
    else if (w === '-R' || w === '--repo') add(ghHost(next, true));
    else if (w.startsWith('--repo=')) add(ghHost(w.slice(7), true));
    else if (/^-R./.test(w)) add(ghHost(w.slice(2), true));
  }
  return { hosts, unread };
}

const GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'api.github.com']);
/** The variables `gh` signs in with: a key only there, before `gh`, is used, not posted. */
const GH_TOKEN = /^(?:GH_TOKEN|GITHUB_TOKEN)=/;
/** The variables `gh` signs in with, expanded anywhere: `$GH_TOKEN`, `${GITHUB_TOKEN}`. */
const TOKEN_EXPANDED = /\$\{?(?:GH_TOKEN|GITHUB_TOKEN)(?![A-Za-z0-9_])/;

/**
 * A `gh` stage: another company, as every request is that is not the strict proof of the key's
 * own use (`strict-own.ts`), which `gh` never meets: it names no address. A key in what it is given
 * (its words, its input) is posted; only a key in `GH_TOKEN=` or `GITHUB_TOKEN=` before it, and
 * nowhere else, signs in, which changes the words a report uses and nothing else.
 */
function ghPlace(reach: Reach, reading: CommandReading, holds: (t: string) => boolean): Place {
  const { hosts, unread } = ghHosts(reading.command);
  const foreign = hosts.find((h) => !GITHUB_HOSTS.has(h));
  const words = reach.stage.text.split(/\s+/).filter((w) => holds(w));
  const signsIn =
    reach.direct &&
    !reach.piped &&
    !reach.state &&
    !holds(reach.stage.body) &&
    words.length > 0 &&
    words.every((w) => GH_TOKEN.test(w.replace(/^['"]/, ''))) &&
    // The token put in a word `gh` is given (`--title "$GH_TOKEN"`) is posted with it.
    !TOKEN_EXPANDED.test(reading.command);
  const host = foreign ?? (unread ? undefined : 'api.github.com');
  const base = { tool: 'Bash', detail: 'gh', ...(host === undefined ? {} : { host }) } as const;
  return { ...base, tier: 'third_party', route: signsIn ? 'command' : 'post' };
}

/** A hosting service a key was stored at as a secret: its API host and its name. */
interface SecretStore {
  readonly host: string;
  readonly service: string;
}

/**
 * Hosting CLIs that store a secret at their service, by the subcommand that does it, the
 * service's API host and its name.
 */
const SECRET_STORES: Readonly<Record<string, { readonly verbs: readonly string[] } & SecretStore>> =
  {
    vercel: { verbs: ['env add', 'secrets add'], host: 'api.vercel.com', service: 'Vercel' },
    wrangler: {
      verbs: ['secret put', 'secret bulk', 'pages secret put'],
      host: 'api.cloudflare.com',
      service: 'Cloudflare',
    },
    heroku: { verbs: ['config:set', 'config:add'], host: 'api.heroku.com', service: 'Heroku' },
    fly: { verbs: ['secrets set', 'secrets import'], host: 'api.fly.io', service: 'Fly.io' },
    flyctl: { verbs: ['secrets set', 'secrets import'], host: 'api.fly.io', service: 'Fly.io' },
    netlify: { verbs: ['env:set', 'env:import'], host: 'api.netlify.com', service: 'Netlify' },
    railway: { verbs: ['variables'], host: 'backboard.railway.app', service: 'Railway' },
    supabase: { verbs: ['secrets set'], host: 'api.supabase.com', service: 'Supabase' },
    doppler: {
      verbs: ['secrets set', 'secrets upload'],
      host: 'api.doppler.com',
      service: 'Doppler',
    },
    gh: { verbs: ['secret set'], host: 'api.github.com', service: 'GitHub' },
  };

/** The service a hosting CLI stored a secret at, or null when this is not such a command. */
function secretStore(name: string, args: readonly Word[]): SecretStore | null {
  const store = Object.hasOwn(SECRET_STORES, name) ? SECRET_STORES[name] : undefined;
  if (store === undefined) return null;
  const said = args
    .filter((a) => !a.redirect && !a.value.startsWith('-'))
    .slice(0, 3)
    .map((a) => a.value)
    .join(' ');
  return store.verbs.some((verb) => said === verb || said.startsWith(`${verb} `))
    ? { host: store.host, service: store.service }
    : null;
}

/**
 * A key stored as a secret with a hosting tool: maybe sent, which may be just what was meant,
 * unless the command names a host elsewhere, or routes requests elsewhere: another company.
 */
function storePlace(store: SecretStore, reading: CommandReading, name: string): Place {
  const elsewhere = [
    ...commandUrls(reading.command, MAX_URLS).urls.map((u) => u.host.toLowerCase()),
    ...ghHosts(reading.command).hosts,
  ].find((h) => h !== store.host && !GITHUB_HOSTS.has(h));
  const base = { tool: 'Bash', ...detailOf(name) } as const;
  if (elsewhere !== undefined)
    return { ...base, tier: 'third_party', route: 'command', host: elsewhere };
  if (routesElsewhere(reading.command) || ghHosts(reading.command).unread)
    return { ...base, tier: 'third_party', route: 'command' };
  return {
    ...base,
    tier: 'maybe',
    route: 'secret-store',
    host: store.host,
    service: store.service,
  };
}

/**
 * Where one stage the key reached put it, or null for a stage that only reads or prints it. `send`
 * says to place only what sends (a request, `gh`, a hosting tool), for the plain cut and for a
 * script the AI wrote.
 */
export function stagePlace(
  reach: Reach,
  reading: CommandReading,
  key: KeyOf,
  holds: (text: string) => boolean,
  sendOnly = false,
): Place | null {
  const facts = reading.facts(reach.stage);
  const name = shownName(facts, holds);
  const store = secretStore(facts.name, facts.resolved?.args ?? []);
  if (store !== null) return storePlace(store, reading, name);
  if (facts.name === 'gh') return ghPlace(reach, reading, holds);
  if (facts.network) return requestPlace(reach, facts, reading, key, name, holds);
  if (sendOnly) return null;
  const ran: Place = { tier: 'maybe', route: 'command-ran', tool: 'Bash', ...detailOf(name) };
  const opened = handedAddress(reach, facts, key, holds, name);
  if (opened !== null) return farther(opened, ran);
  return facts.inert ? null : ran;
}

/** Programs that only print the words they are given. */
const PRINTERS: ReadonlySet<string> = new Set(['echo', 'printf']);

/**
 * A program that is not a printer, handed an address that holds the key (`git clone
 * https://x:<key>@host/…`, `python3 up.py https://host/?k=<key>`, `xmllint https://host/<key>`):
 * it may open that address, and the key went where a request there goes. Null for none.
 */
function handedAddress(
  reach: Reach,
  facts: StageFacts,
  key: KeyOf,
  holds: (text: string) => boolean,
  name: string,
): Place | null {
  if (PRINTERS.has(facts.name)) return null;
  const read = commandUrls(reach.stage.text, MAX_URLS);
  const urls = read.urls.filter((u) => holds(u.url));
  const words = wordHosts(wordValues(facts).filter((w) => w.includes('://') && holds(w)));
  if (urls.length === 0 && words.hosts.length === 0 && !words.unread) return null;
  const hosts = [...urls.map((u) => u.host.toLowerCase()), ...words.hosts];
  return hostPlace(
    hosts,
    key,
    { route: 'command', tool: 'Bash', ...detailOf(name) },
    {
      unread: read.capped || words.unread || hosts.includes(''),
      routed: routesElsewhere(reach.stage.text),
    },
  );
}
