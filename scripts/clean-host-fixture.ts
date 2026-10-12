// Cleans a raw capture of a host (the stream of `claude -p`, or the audit log of the hook in that run) into
// a fixture that can be committed. The rules are in packages/cli/test/live/drivers/clean-fixture.ts and are
// listed in packages/cli/test/fixtures/hosts/claude-code/README.md under "Cleaning".
//
//   pnpm exec tsx scripts/clean-host-fixture.ts <raw file> <cleaned file> [--rename from=to]...
//
// Nothing is written when the cleaned text still holds something of the machine it was captured on.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  cleanFixture,
  leaksIn,
} from '../packages/cli/test/live/drivers/clean-fixture.ts';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { rename: { type: 'string', multiple: true } },
  allowPositionals: true,
});
const [rawPath, outPath] = positionals;
if (rawPath === undefined || outPath === undefined) {
  process.stderr.write(
    'usage: tsx scripts/clean-host-fixture.ts <raw file> <cleaned file> [--rename from=to]...\n',
  );
  process.exit(2);
}

const renames = (values.rename ?? []).map((pair): [string, string] => {
  const at = pair.indexOf('=');
  if (at < 1) throw new Error(`--rename wants from=to, not ${pair}`);
  return [pair.slice(0, at), pair.slice(at + 1)];
});

const cleaned = cleanFixture(readFileSync(rawPath, 'utf8'), { renames });
const leaks = leaksIn(cleaned);
if (leaks.length > 0) {
  process.stderr.write(`not written: the cleaned text still matches ${leaks.join(', ')}\n`);
  process.exit(1);
}
writeFileSync(outPath, cleaned);
process.stdout.write(`${outPath}: ${cleaned.split('\n').length - 1} lines\n`);
