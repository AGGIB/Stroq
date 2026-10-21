// Streaming every file of one Claude Code session into an analyzer: the main transcript, then
// each subagent's, each with its label and the session's saved-outputs folder. The saved outputs
// are read by the scan's one reader, so each is read once and all come out of one budget. Every
// line is read as one record (`accountedParser`): a key in a part of it no reader read is maybe
// sent. A file that could not be read through puts every key the fast pass found in it there too.
import { sessionFiles } from '../replay/claude-session.js';
import type { SpillReader } from '../replay/spilled.js';
import { createTranscriptParser, feedLines } from '../replay/transcript.js';
import { accountedParser, type SessionAnalyzer, type Sighting } from './analyze.js';

const NONE: ReadonlySet<number> = new Set();

export async function claudeSessionFiles(
  path: string,
  analyzer: SessionAnalyzer,
  fileKeys: ReadonlySet<number>,
  savedKeys: ReadonlySet<number>,
  spill: SpillReader,
  keysByFile: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
): Promise<{ sightings: Sighting[]; id: string; failed: number }> {
  const files = await sessionFiles(path);
  let id = path;
  let failed = 0;
  try {
    const main = await feedLines(
      files.main,
      accountedParser(
        createTranscriptParser({ sink: analyzer.sink, spillDir: files.spillDir, spill }),
        analyzer,
      ),
    );
    id = main.sessionId;
  } catch {
    failed += 1;
    analyzer.unread(keysByFile.get(files.main) ?? NONE);
  }
  for (const sub of files.subagents) {
    try {
      await feedLines(
        sub.path,
        accountedParser(
          createTranscriptParser({
            sink: analyzer.sink,
            spillDir: files.spillDir,
            spill,
            subagent: sub.label,
          }),
          analyzer,
        ),
      );
    } catch {
      failed += 1;
      analyzer.unread(keysByFile.get(sub.path) ?? NONE);
    }
  }
  return { sightings: analyzer.finish(fileKeys, savedKeys), id, failed };
}
