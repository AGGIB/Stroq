// The moments worth a look, in plain words, ranked.
//
// Order: commands a text told the agent to run, then keys that left this machine, then keys the AI
// saw, then folders that run code when an agent opens them. Each moment is one sentence for the card
// and the rows `stroq show` prints for it. Every word that came from a transcript, a repository or a
// key file goes through `clean`; the words around them are fixed here and name no rule, no score and
// none of the internal terms of the guard.
import { isShellTool } from '@stroq/core';
import { when } from '../sent/phrases.js';
import type { AutorunItem, AutorunRepo } from './autorun.js';
import { KEPT } from './data.js';
import { keyMoments, type PlacedFinding } from './key-moments.js';
import { pasteable, sessionRows, withTranscript, type SessionPlace } from './moment-parts.js';
import type { Moment, ToldMoment } from './schema.js';
import { clean, shortPath } from './text.js';

export type { SessionPlace };

export interface ToldInput {
  readonly moment: ToldMoment;
  readonly session: SessionPlace;
}

export interface MomentInputs {
  readonly told: readonly ToldInput[];
  /** One for each key in each session it was found in; a key found in two places is in both. */
  readonly findings: readonly PlacedFinding[];
  readonly repos: readonly AutorunRepo[];
  readonly home: string;
}

// -- A command a text told the agent to run ------------------------------------------------------------

const DECISION_RANK: Readonly<Record<ToldMoment['decision'], number>> = {
  deny: 0,
  ask: 1,
  allow: 2,
  none: 3,
};
const SHAPE_RANK: Readonly<Record<ToldMoment['shape'], number>> = {
  pipe_shell: 0,
  encoded: 1,
  pkg: 2,
};

const WEB_TOOL = /^(?:WebFetch|WebSearch)$|^mcp__.*(?:fetch|browser|web|crawl|scrape|search)/i;
const FILE_TOOL = /^(?:Read|Grep|Glob)$/;

/** Where the text came from, as the subject of the sentence. */
function subjectOf(read: ToldMoment['read']): string {
  if (WEB_TOOL.test(read.tool)) return 'A web page';
  if (FILE_TOOL.test(read.tool)) {
    const name = read.source.slice(read.source.lastIndexOf('/') + 1);
    return name === '' || name.length > 40 ? 'A file' : clean(name, 40);
  }
  if (isShellTool(read.tool)) return 'The output of a command';
  return 'A tool result';
}

const WHAT_IT_SAID: Readonly<Record<ToldMoment['shape'], (m: ToldMoment) => string>> = {
  pipe_shell: () => 'download and run a script',
  encoded: () => 'run a hidden command',
  pkg: (m) => `run the package ${clean(m.pkg ?? '', 60)}`,
};

const HOW_LINKED: Readonly<Record<ToldMoment['shape'], (m: ToldMoment) => string>> = {
  pipe_shell: () => 'The command is the download-and-run line from that text.',
  encoded: () => 'The command decodes the hidden text and runs what it decodes.',
  pkg: (m) => `The command runs exactly the package that text named: ${clean(m.pkg ?? '', 60)}.`,
};

const POLICY_WORDS: Readonly<Record<ToldMoment['decision'], string>> = {
  deny: 'block it',
  ask: 'ask you first',
  allow: 'let it through',
  none: 'have no rule for it',
};

function toldMoment({ moment, session }: ToldInput, home: string): Omit<Moment, 'n'> {
  const read = moment.read;
  return {
    kind: 'told-by-text',
    line:
      `${subjectOf(read)} told your agent to ${WHAT_IT_SAID[moment.shape](moment)}. It did. ` +
      'Whoever wrote that text can steer your agent.',
    session,
    groups: [
      {
        title: 'What your agent read',
        rows: [
          ['Tool', clean(read.tool, 60)],
          ['Where', clean(read.source, 120)],
          ['When', when(read.at)],
          ['It said', clean(read.excerpt, 160)],
        ],
      },
      {
        title: 'What it did next',
        rows: [
          ['Command', clean(moment.command, 200)],
          ['Tool', clean(moment.tool, 60)],
          ['When', when(moment.at)],
          ['Stroq today would', POLICY_WORDS[moment.decision]],
        ],
      },
      { title: 'How they are linked', rows: [['', HOW_LINKED[moment.shape](moment)]] },
      { title: 'Where to find it', rows: sessionRows(session, home) },
    ],
    next: withTranscript('replay', session.path),
  };
}

// -- A folder that runs code by itself -----------------------------------------------------------------

const KIND_WORDS: Readonly<Record<string, string>> = {
  'git-config-exec': 'a git setting that runs a command',
  'git-config-include': 'a git setting that loads another config',
  'nested-bare-repo': 'a bare repository inside it',
  'gitattributes-driver': 'a git filter that runs a command',
  'devcontainer-host-command': 'a dev container command that runs on your machine',
  'git-hook-routine': 'a git hook',
  'agent-hook': 'an agent hook',
  'agent-helper-command': 'an agent helper command',
  'agent-api-redirect': 'a setting that sends the agent elsewhere',
  'agent-env': 'an environment setting for the agent',
  'agent-permission-bypass': 'a setting that turns off a guard',
  'agent-plugin': 'an agent plugin',
  'mcp-auto-approve': 'an auto-approved tool server',
  'mcp-server-runs-code': 'a tool server that runs code',
  'editor-autorun-task': 'an editor task that runs on open',
  'agent-definition-hook': 'a hook in an agent definition',
  'package-script-agent-path': 'a package script on the agent path',
  'instruction-hidden-text': 'hidden text in an instruction file',
  'agent-run-file-changed': 'a changed file the agent runs',
  'git-hook-file': 'a git hook file',
};
const kindWords = (kind: string): string => KIND_WORDS[kind] ?? 'a setting that runs code';

function repoMoment(repo: AutorunRepo, home: string): Omit<Moment, 'n'> {
  const first = repo.items[0] as AutorunItem;
  const more = repo.items.length + repo.more - 1;
  const and = more > 0 ? ` and ${more} more` : '';
  return {
    kind: 'autorun-repo',
    line:
      `${shortPath(repo.dir, home, 40)} runs code as soon as an agent opens it: ` +
      `${kindWords(first.kind)}${and}.`,
    groups: [
      {
        title: 'What runs by itself',
        rows: repo.items.map((item): [string, string] => [
          kindWords(item.kind),
          `${clean(item.file, 100)} — ${clean(item.name, 100)}`,
        ]),
      },
      { title: 'Folder', rows: [['Path', shortPath(repo.dir, home, 90)]] },
    ],
    next: pasteable(['stroq', 'inspect', { positional: repo.dir, what: 'path' }]),
  };
}

// -- Ranking -------------------------------------------------------------------------------------------

const newestFirst = (a: string, b: string): number => Date.parse(b) - Date.parse(a) || 0;

/** The moments, most worth a look first, numbered from 1. */
export function buildMoments(inputs: MomentInputs): Moment[] {
  const { home } = inputs;
  const told = [...inputs.told]
    .sort(
      (a, b) =>
        DECISION_RANK[a.moment.decision] - DECISION_RANK[b.moment.decision] ||
        SHAPE_RANK[a.moment.shape] - SHAPE_RANK[b.moment.shape] ||
        newestFirst(a.moment.at, b.moment.at),
    )
    .map((input) => toldMoment(input, home));
  const keys = keyMoments(inputs.findings, home);
  const repos = [...inputs.repos]
    .sort((a, b) => b.items.length + b.more - (a.items.length + a.more) || (a.dir < b.dir ? -1 : 1))
    .map((repo) => repoMoment(repo, home));
  return [...told, ...keys.sent, ...keys.seen, ...repos]
    .slice(0, KEPT)
    .map((moment, i) => ({ ...moment, n: i + 1 }));
}
