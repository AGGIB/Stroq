import { displayPath } from '../commands/attack.js';
import { policyFile } from '../paths.js';
import { neutralizeControls } from '../terminal-safe.js';
import { outsideLine } from '../ui/layout.js';
import { BUILT_IN_READ, checkReport, type CheckReport } from './check.js';
import { formatCheck } from './check-format.js';
import { MAX_POLICY_BYTES, readPolicyFile, type Unreadable } from './load.js';

/** Exit codes: 0 nothing needs attention, 1 a finding or a fault, 2 the file could not be read. */
const EXIT_FINDINGS = 1;
const EXIT_UNREADABLE = 2;

const WHY: Readonly<Record<Unreadable, string>> = {
  missing: 'no such file',
  'not-a-file': 'not a regular file',
  'too-large': `is more than ${MAX_POLICY_BYTES / (1024 * 1024)} MiB, more than a policy file is; not read`,
  unreadable: 'cannot be opened',
};

/**
 * Whatever reaches the terminal passes through here, even though the program's own output is
 * neutralized once more on its way out: a command that is tested, or run as a library, is not behind
 * that filter, and a policy file is the kind of thing somebody else writes.
 */
const write = (stream: NodeJS.WriteStream, text: string): void => {
  stream.write(neutralizeControls(text));
};

function show(report: CheckReport, json: boolean, shownFile: string): void {
  write(
    process.stdout,
    json ? `${JSON.stringify(report, null, 2)}\n` : formatCheck(report, shownFile),
  );
}

/**
 * `stroq policy check [<file>] [--json]`.
 *
 * With no file, the policy in force: the policy.yaml of the Stroq home, or, when there is none, the
 * built-in one. It is read, never run; nothing is opened but the one file, and nothing is sent anywhere.
 * A file that was asked for and cannot be read is a usage problem (2); one that is read and has faults
 * or findings is 1.
 */
export function runCheckCommand(file: string | undefined, json: boolean): number {
  const target = file ?? policyFile();
  const shown = outsideLine(displayPath(target));
  const read = readPolicyFile(target);
  if (!read.ok && read.problem === 'unreadable') {
    // The hook uses the built-in policy when policy.yaml is not there, so a missing one is not a problem.
    if (file === undefined && read.why === 'missing') {
      const report = checkReport({ source: 'default', file: null }, BUILT_IN_READ);
      show(report, json, shown);
      return report.ok ? 0 : EXIT_FINDINGS;
    }
    write(process.stderr, `stroq policy check: ${shown}: ${WHY[read.why]}\n`);
    return EXIT_UNREADABLE;
  }
  const report = checkReport({ source: 'file', file: target }, read);
  show(report, json, shown);
  return report.ok ? 0 : EXIT_FINDINGS;
}
