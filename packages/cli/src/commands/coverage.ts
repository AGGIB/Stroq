import { parseArgs } from 'node:util';
import { buildCoverage, formatCoverage, toNavigatorLayer } from '../coverage/report.js';

/** Prints the control mapping: table by default, or an ATT&CK-Navigator layer with `--format=navigator`. */
export async function runCoverageCommand(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { format: { type: 'string' }, json: { type: 'boolean', default: false } },
  });
  const report = buildCoverage();
  if (values.format === 'navigator') {
    process.stdout.write(`${JSON.stringify(toNavigatorLayer(report), null, 2)}\n`);
    return 0;
  }
  if (values.format !== undefined && values.format !== 'table') {
    process.stderr.write(
      `stroq coverage: unknown --format "${values.format}" (table, navigator)\n`,
    );
    return 1;
  }
  process.stdout.write(
    values.json ? `${JSON.stringify(report, null, 2)}\n` : formatCoverage(report),
  );
  return 0;
}
