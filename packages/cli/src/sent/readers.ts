// Where a past session can be read from, per agent.
//
// `stroq sent` needs two things from an agent: a way to find its recorded sessions
// for a directory, and a way to turn one into the `Transcript` shape the scanner
// consumes. That is the whole contract, and it is small on purpose — adding Codex or
// Cursor later means one object here plus its parser, with nothing in the scanner or
// the formatter to change.
//
// Exactly one reader is registered, for Claude Code, because that is the only
// transcript format this machine has real sessions in and therefore the only one that
// can be verified rather than guessed at. A second reader written blind would be a
// claim of coverage nobody has tested.
import {
  findTranscripts,
  readTranscript,
  type Transcript,
  type TranscriptFile,
} from '../replay/transcript.js';

export interface TranscriptReader {
  /** The agent's name as the report prints it. */
  readonly agent: string;
  /** Recorded sessions for `cwd`, newest first; empty when this agent leaves none. */
  find(cwd: string): Promise<readonly TranscriptFile[]>;
  read(path: string): Promise<Transcript>;
}

export const claudeCodeReader: TranscriptReader = {
  agent: 'claude-code',
  find: findTranscripts,
  read: readTranscript,
};

export const READERS: readonly TranscriptReader[] = [claudeCodeReader];

export interface FoundTranscript {
  readonly reader: TranscriptReader;
  readonly path: string;
}

/**
 * The most recently modified transcript any registered reader can find for `cwd`.
 *
 * Readers are asked in order and the first with anything to offer wins, rather than
 * every reader's newest being compared: with one reader the two are the same, and
 * ranking transcripts across agents by mtime would need each reader to agree on what
 * an mtime means before it could be trusted.
 */
export async function newestTranscript(cwd: string): Promise<FoundTranscript | null> {
  for (const reader of READERS) {
    const found = await reader.find(cwd);
    const newest = found[0];
    if (newest) return { reader, path: newest.path };
  }
  return null;
}
