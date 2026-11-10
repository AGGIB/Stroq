// What the moments of the card share: where a session is, the rows that say so, and a command to dig
// deeper that a person may paste.
import { tryCommandLine, type Piece } from '../shell-quote.js';
import { AGENTS, type CardAgent } from './schema.js';
import { clean, shortPath } from './text.js';

export interface SessionPlace {
  readonly agent: CardAgent;
  readonly id: string;
  readonly path: string;
  readonly cwd: string | null;
}

const AGENT_NAME: Readonly<Record<CardAgent, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

/** A command line the person may paste, or none when a path in it cannot be quoted safely. */
export function pasteable(pieces: readonly Piece[]): string[] {
  const result = tryCommandLine(pieces);
  return result.line === null ? [] : [result.line];
}

export const withTranscript = (command: string, path: string): string[] =>
  pasteable(['stroq', command, { flag: '--transcript', value: path, what: 'path' }]);

export const isAgent = (name: string): name is CardAgent =>
  (AGENTS as readonly string[]).includes(name);

export function sessionRows(session: SessionPlace, home: string): [string, string][] {
  return [
    ['Agent', AGENT_NAME[session.agent]],
    ['Session', clean(session.id, 80)],
    ...(session.cwd === null
      ? []
      : ([['Folder', shortPath(session.cwd, home, 70)]] as [string, string][])),
    ['Transcript', shortPath(session.path, home, 70)],
  ];
}
