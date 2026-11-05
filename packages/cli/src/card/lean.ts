// Reading only what can matter to the count.
//
// Judging a transcript is mostly scanning what the tools returned: a few hundred rules over every
// result, which is nearly all of the time a replay takes. The card counts a command as told by text
// only when a flagged read gave it a package, a pipe to a shell or an encoded blob, so a result that
// holds none of the three cannot be the evidence of any such command, however it scans. The engine
// finds those atoms by one pass over the normalised text (`extractAtomsDeepWithLoss`), and that pass
// costs a small part of the scan; so a result with no such atom is replaced, in the transcript the
// engine is given, by a short stand-in. The calls of tools that run no command are left out unless what
// they returned could hold one, and so are the commands that could not be counted (none holds a
// package, a pipe to a shell or an encoded blob) and that download nothing. Order, call ids and error
// marks of the rest are kept, so the engine judges each command that remains as it would have. (Each event the engine judges costs it a few dozen small file
// operations in its throwaway home, and those, not the rules, are what the replay spends its time on.)
//
// What is lost: a flag on a result with none of the three atoms would have tainted the session, and a
// tainted session is denied more; a download by a tool that is not a command is not noted either. A command that is counted is linked to a flagged read that holds one
// of the three atoms, and that read is read in full, so it taints as before; the decision shown for
// such a command is the same. A result is also read in full whenever the pass cut anything short.
import {
  extractActionAtoms,
  extractAtomsDeepWithLoss,
  isShellTool,
  normalizeText,
} from '@stroq/core';
import type { Transcript, TranscriptEvent } from '../replay/transcript.js';

/** The kinds of atom a counted command is linked by. */
const LINK_KINDS: ReadonlySet<string> = new Set(['pkg', 'pipe_shell', 'encoded']);

/** What a result is replaced with: nothing a rule matches, and no atom. */
export const STAND_IN = '(result not read)';

/** Whether a tool's result could hold the evidence of a counted command. */
export function couldCarryLink(resultText: string): boolean {
  if (resultText === '') return false;
  // Digests are read as blobs, as the engine reads a flagged result, so that nothing it would use is missed.
  const { atoms, truncated } = extractAtomsDeepWithLoss(normalizeText(resultText), {
    cheapDigests: false,
  });
  return truncated || atoms.some((atom) => LINK_KINDS.has(atom.kind));
}

/**
 * What notes a download in the engine: a command that fetches into a file, or clones. Read back later in
 * the session, such a file is somebody else's text, however local the read, so the command stays.
 */
const DOWNLOADS = /\b(?:curl|wget|aria2c|scp|rsync)\b|\b(?:git|gh)\b[^|;&\n]{0,200}\bclone\b/i;

/** Whether a command could be one that is counted, or could change what a later one is judged as. */
export function commandCouldLink(command: string): boolean {
  if (DOWNLOADS.test(command)) return true;
  const { atoms, unread } = extractActionAtoms(normalizeText(command), true);
  return unread || atoms.some((atom) => LINK_KINDS.has(atom.kind));
}

const commandOf = (input: Readonly<Record<string, unknown>>): string =>
  typeof input['command'] === 'string' ? input['command'] : '';

/** The event as the lean replay has it, or null when the engine need not see it. */
function lean(event: TranscriptEvent): TranscriptEvent | null {
  const carries = event.kind === 'post' && couldCarryLink(event.resultText);
  if (!isShellTool(event.tool)) return carries ? event : null;
  // A command that is none of the above, and whose result holds no link, is not read at all.
  if (!carries && !commandCouldLink(commandOf(event.input))) return null;
  if (event.kind === 'post' && !carries) return { ...event, resultText: STAND_IN };
  return event;
}

/** The transcript with the events and the results that cannot matter left out or replaced. */
export function leanTranscript(transcript: Transcript): Transcript {
  const events = transcript.events.flatMap((event) => lean(event) ?? []);
  return { ...transcript, events };
}
