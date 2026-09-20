import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { StroqEngine } from '@stroq/core';
import { asPaths, scanPostResult, type EngineEvent } from './pre-decision.js';

/**
 * Scanning a file an agent read, for the agents whose "the read is done" event
 * carries the PATH and not the content.
 *
 * Windsurf's `post_read_code` and Antigravity's `PostToolUse` are the same problem:
 * the payload names a file, the model has already seen its bytes, and the only way to
 * scan what the model saw is for Stroq to open the file itself. The two adapters
 * differ in what they PRINT afterwards and in nothing else, so the reading, the
 * candidate list and the per-candidate attribution live here rather than being copied
 * — a copy of a security reader is a fix that lands on one agent only.
 */

/**
 * The most of a file Stroq reads for a scan. The payload carries the path and not the
 * content, so Stroq opens the file itself — and a hook whose timeout is short
 * (Antigravity) or undocumented (Windsurf) must not be the thing that reads a planted
 * gigabyte. One MiB is far more than any prompt-injection payload needs and is
 * bounded work.
 */
export const MAX_SCAN_READ_BYTES = 1_048_576;

/** At most `maxBytes` of an already-stat'ed regular file. */
function readCapped(path: string, size: number, maxBytes: number): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * What the agent just read, read again by Stroq. A relative path is resolved against
 * the policy cwd (the workspace root). A directory — agents read them recursively — a
 * missing or unreadable file, an empty path and an empty file all return `''`, which
 * the caller turns into silence: a read that gave the agent nothing gave the model
 * nothing either, so there is nothing to scan and nothing to report. Every failure is
 * swallowed for the same reason: this function cannot be the thing that fails a hook.
 */
export function readScanText(
  filePath: string,
  cwd: string,
  maxBytes: number = MAX_SCAN_READ_BYTES,
): string {
  if (filePath === '') return '';
  try {
    const path = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
    const stats = statSync(path);
    if (!stats.isFile() || stats.size === 0) return '';
    return readCapped(path, stats.size, maxBytes);
  } catch {
    // Missing, unreadable, a broken symlink, a permissions error: nothing to scan.
    return '';
  }
}

/**
 * Every distinct path a read event named: `file_path` (the fan-out's canonical
 * candidate, from the shared `pathsOf`) plus every entry of `file_paths`, which
 * `kindToolInput`/`withCandidates` populates whenever the path fields disagreed.
 * Reading `file_path` alone scans only ONE of several disagreeing candidates —
 * `{ path: 'clean.md', file_path: 'poisoned.md' }` scans `clean.md`, because
 * `file_path` there is `pathsOf`'s `candidates[0]` (`path` sorts first), not
 * necessarily the file the agent actually read. Deduplicated so a payload whose
 * fields agreed is not scanned twice.
 */
export function postReadCandidates(
  toolInput: Readonly<Record<string, unknown>>,
): readonly string[] {
  const first = toolInput['file_path'];
  const rest = asPaths(toolInput['file_paths']);
  const all = typeof first === 'string' && first !== '' ? [first, ...rest] : rest;
  return [...new Set(all)];
}

/**
 * Reads and scans every candidate in turn — sequentially, never concurrently, because
 * the session store is file-locked — and returns the FIRST suspect warning, or `null`
 * when every candidate came back clean or unscanned. Worst wins, the same rule every
 * other fan-out uses.
 *
 * Each candidate is scanned under its OWN `file_path`, mirroring how `preInputs`
 * rewrites `file_path` per candidate on the `pre` side — never the shared `event` as
 * it stands, whose `toolInput.file_path` is fixed at whichever candidate happened to
 * be first. Core's `summarizeInput` reads that field for both the audit `summary` and
 * the provenance `source`, so scanning every candidate against the unmodified event
 * would enforce correctly but ATTRIBUTE every scan — suspect or clean — to that one
 * candidate's path, regardless of which file was actually read for it.
 */
export async function scanReadCandidates(
  engine: StroqEngine,
  event: EngineEvent,
  maxBytes: number = MAX_SCAN_READ_BYTES,
): Promise<string | null> {
  let warning: string | null = null;
  for (const path of postReadCandidates(event.toolInput)) {
    const text = readScanText(path, event.cwd, maxBytes);
    if (text === '') continue;
    const candidateEvent: EngineEvent = {
      ...event,
      toolInput: { ...event.toolInput, file_path: path },
    };
    const outcome = await scanPostResult(engine, candidateEvent, text);
    if (outcome.warning !== null && warning === null) warning = outcome.warning;
  }
  return warning;
}
