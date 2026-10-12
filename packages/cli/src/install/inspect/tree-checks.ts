// What the tree says of itself without reading a file: links, nested repositories, files that stand
// for content stored elsewhere, and programs that are marked to run.
//
// A link is recorded and never followed, so it says where it points and nothing of what is there. A
// target that leaves the tree is the sensitive case. A nested repository is not opened. A Git LFS
// pointer is the text git keeps in place of a file; what it stands for is not here, and a reading
// cannot say what that is. An executable file outside the folders that programs belong in is a place
// to look. All of these are signals, and none is a verdict.
import { posix } from 'node:path';
import type { Findings } from './findings.js';
import type { InspectInput } from './input.js';

const NOT_A_VERDICT = 'a signal to look at, not a verdict';
const LFS_HEADER = 'version https://git-lfs.github.com/spec/v1';
/** A pointer is a few lines; a longer file that begins like one is not a pointer. */
const LFS_POINTER_MAX = 1024;
const PROGRAM_FOLDERS: ReadonlySet<string> = new Set(['bin', 'scripts', '.husky']);

/** Whether a link at `path` that points at `target` leaves the tree. */
export function leavesTree(path: string, target: string): boolean {
  if (/^(?:[/\\~]|[A-Za-z]:)/.test(target)) return true;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target.replace(/\\/g, '/')));
  return resolved === '..' || resolved.startsWith('../');
}

function underProgramFolder(path: string): boolean {
  return path
    .split('/')
    .slice(0, -1)
    .some((part) => PROGRAM_FOLDERS.has(part));
}

export function inspectTreeEntries(input: InspectInput, findings: Findings): void {
  for (const entry of input.tree.entries) {
    if (entry.kind === 'symlink') {
      const target = entry.target ?? '';
      const outside = leavesTree(entry.path, target);
      findings.tally('symlink');
      findings.signal({
        ruleId: 'symlink',
        file: entry.path,
        line: null,
        sensitive: outside,
        detail: `${entry.path} -> ${target}${outside ? ' (outside the tree)' : ''}`,
        detector: `a symbolic link, recorded and not followed${outside ? '; its target is outside the tree' : ''}; ${NOT_A_VERDICT}`,
      });
    } else if (entry.kind === 'gitlink') {
      findings.tally('gitlink');
      findings.signal({
        ruleId: 'gitlink',
        file: entry.path,
        line: null,
        sensitive: true,
        detector: `a nested repository, recorded and not opened; what is in it is not known; ${NOT_A_VERDICT}`,
      });
    } else if (entry.exec && !underProgramFolder(entry.path)) {
      findings.signal({
        ruleId: 'executable-file',
        file: entry.path,
        line: null,
        sensitive: true,
        detail: entry.path,
        detector: `a file marked executable outside a bin or scripts folder; ${NOT_A_VERDICT}`,
      });
    }
  }
  for (const file of input.texts) {
    if (file.size <= LFS_POINTER_MAX && file.text.startsWith(LFS_HEADER)) {
      findings.tally('lfs-pointer');
      findings.signal({
        ruleId: 'lfs-pointer',
        file: file.path,
        line: null,
        sensitive: true,
        basis: 'unknown',
        detail: 'its content is stored elsewhere and is not in this tree',
        detector: `a Git LFS pointer: the text git keeps in place of a file whose content is stored elsewhere; ${NOT_A_VERDICT}`,
      });
    }
  }
}
