// `stroq card`: what your agents did in the last days, from your own sessions, in under a minute.
//
// A report and not a gate: it exits 0 whatever it finds. It reads the transcripts Claude Code and Codex
// keep, replays them through the policy in a throwaway home (nothing runs, nothing is sent, the real
// `~/.stroq` gets only the small cache the next run reads), and prints plain counts and the few moments
// worth a look. `stroq show N` prints the evidence behind one.
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { buildCard } from '../card/build.js';
import { shareLine, renderCard } from '../card/render.js';
import { writeLastCard } from '../card/store.js';
import { stroqHome } from '../paths.js';
import { progressLine } from '../sent/run.js';
import { writeErrUnfiltered } from '../terminal-safe.js';
import { stroqVersion } from '../version.js';

const DEFAULT_DAYS = 30;

/** The number of days, or null when it is not a whole number from 1 to 365. */
export function parseDays(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_DAYS;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const days = Number(raw);
  return days >= 1 && days <= 365 ? days : null;
}

export async function runCard(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { days: { type: 'string' }, json: { type: 'boolean' }, share: { type: 'boolean' } },
    allowPositionals: false,
  });
  const days = parseDays(values.days);
  if (days === null) {
    process.stderr.write('--days takes a whole number of days from 1 to 365\n');
    return 2;
  }
  if (values.json === true && values.share === true) {
    process.stderr.write('--json and --share are two answers; pick one\n');
    return 2;
  }
  const home = homedir();
  const state = stroqHome();
  // A progress line only for a person at a terminal: a pipe or a script gets none.
  const progress = progressLine(process.stderr.isTTY === true, writeErrUnfiltered);
  let data;
  try {
    data = await buildCard(days, {
      home,
      env: process.env,
      stroqHome: state,
      cwd: process.cwd(),
      now: new Date(),
      version: stroqVersion(),
      ...(progress === null ? {} : { progress: progress.update }),
    });
  } catch (err) {
    process.stderr.write(`stroq: the card could not be made: ${(err as Error).message}\n`);
    return 1;
  } finally {
    progress?.end();
  }
  try {
    writeLastCard(
      state,
      { version: data.version, generated: data.generated, days: data.days },
      data.moments,
    );
  } catch (err) {
    process.stderr.write(
      `stroq: the moments could not be saved for \`stroq show\`: ${(err as Error).message}\n`,
    );
  }
  if (values.json === true) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else if (values.share === true) process.stdout.write(`${shareLine(data)}\n`);
  else process.stdout.write(`${renderCard(data, home).join('\n')}\n`);
  return 0;
}
