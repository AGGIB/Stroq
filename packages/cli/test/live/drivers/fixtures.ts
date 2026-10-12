// The streams of a real Claude Code, as `test/fixtures/hosts/claude-code/README.md` describes them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../fixtures/hosts/claude-code/', import.meta.url));

/** The directory every cleaned stream says its project is. */
export const FIXTURE_PROJECT = '/tmp/stroq-live-fixture/project';

/** The folder of a version, and the name of a file in it. */
export interface FixtureName {
  readonly version: '2.1.144' | '2.1.271';
  readonly file: string;
}

/** The text of a fixture, as the host wrote it. */
export const readFixture = ({ version, file }: FixtureName): string =>
  readFileSync(`${ROOT}${version}/${file}`, 'utf8');

/** The non-empty lines of a fixture. */
export const linesOf = (text: string): string[] => text.split('\n').filter((line) => line !== '');

/** The audit entries the hook wrote during the run a fixture records. */
export const auditOf = (name: FixtureName): readonly Record<string, unknown>[] =>
  linesOf(readFixture(name)).map((line) => JSON.parse(line) as Record<string, unknown>);

/**
 * The fixture with `provider` added to every model of its result line, which is what the result line of
 * 2.1.271 has and the older one does not. The only edit, and the only reason a test calls this: the
 * provider of a run is read from there.
 */
export function withProvider(text: string, provider: string): string {
  const lines = linesOf(text).map((line) => JSON.parse(line) as Record<string, unknown>);
  const last = lines[lines.length - 1];
  if (last === undefined || last['type'] !== 'result') throw new Error('no result line to add to');
  const usage = last['modelUsage'] as Record<string, Record<string, unknown>>;
  const withIt = Object.fromEntries(
    Object.entries(usage).map(([model, each]) => [model, { ...each, provider }]),
  );
  return `${[...lines.slice(0, -1), { ...last, modelUsage: withIt }]
    .map((line) => JSON.stringify(line))
    .join('\n')}\n`;
}

/** The stream names the tests use. */
export const STREAMS = {
  plain: { version: '2.1.271', file: 'plain.jsonl' },
  allowRan: { version: '2.1.144', file: 'allow.real.acceptEdits.jsonl' },
  allowHostBlocked: { version: '2.1.144', file: 'allow.real.dontAsk.jsonl' },
  egressBlocked: { version: '2.1.144', file: 'secret-egress.real.acceptEdits.jsonl' },
  egressControl: { version: '2.1.144', file: 'secret-egress.control.acceptEdits.jsonl' },
  denyBlocked: { version: '2.1.144', file: 'deny.real.acceptEdits.jsonl' },
  denyControl: { version: '2.1.144', file: 'deny.control.acceptEdits.jsonl' },
} as const satisfies Record<string, FixtureName>;

export const AUDITS = {
  allow: { version: '2.1.144', file: 'allow.real.acceptEdits.audit.jsonl' },
  allowDontAsk: { version: '2.1.144', file: 'allow.real.dontAsk.audit.jsonl' },
  egress: { version: '2.1.144', file: 'secret-egress.real.acceptEdits.audit.jsonl' },
  deny: { version: '2.1.144', file: 'deny.real.acceptEdits.audit.jsonl' },
} as const satisfies Record<string, FixtureName>;
