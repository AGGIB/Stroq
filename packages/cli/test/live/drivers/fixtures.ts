// The streams of a real Claude Code, as `test/fixtures/hosts/claude-code/README.md` describes them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../fixtures/hosts/claude-code/', import.meta.url));

import { FIXTURE_FAKE, FIXTURE_NONCE, FIXTURE_PROJECT, FIXTURE_SESSION } from './clean-fixture.js';
import type { Behaviour } from './fake-claude.js';

export { FIXTURE_FAKE, FIXTURE_NONCE, FIXTURE_PROJECT, FIXTURE_SESSION };

/** The folder of a version, and the name of a file in it. */
export interface FixtureName {
  readonly version: '2.1.144' | '2.1.271';
  readonly file: string;
}

/** The text of a fixture, as the host wrote it. */
export const readFixture = ({ version, file }: FixtureName): string =>
  readFileSync(join(ROOT, version, file), 'utf8');

/** The non-empty lines of a fixture. */
export const linesOf = (text: string): string[] => text.split('\n').filter((line) => line !== '');

/** The audit entries the hook wrote during the run a fixture records. */
export const auditOf = (name: FixtureName): readonly Record<string, unknown>[] =>
  linesOf(readFixture(name)).map((line) => JSON.parse(line) as Record<string, unknown>);

/**
 * The stream names the tests use. All but `noProvider` are of Claude Code 2.1.271, whose result line says
 * who is paid (`modelUsage.<model>.provider`); `noProvider` is of 2.1.144, whose result line does not.
 */
export const STREAMS = {
  plain: { version: '2.1.271', file: 'plain.jsonl' },
  allowRan: { version: '2.1.271', file: 'allow.real.acceptEdits.jsonl' },
  denyBlocked: { version: '2.1.271', file: 'deny.real.acceptEdits.jsonl' },
  /** The same command with a hook that does nothing: it ran, so the control is armed. */
  denyControl: { version: '2.1.271', file: 'deny.control.acceptEdits.jsonl' },
  /** The same, without the permission rule for `git config`: the host's own step stopped it. */
  denyControlUnarmed: { version: '2.1.271', file: 'deny.control-unarmed.acceptEdits.jsonl' },
  /** The model declined to issue the command, and said so. */
  egressRefused: { version: '2.1.271', file: 'secret-egress.refused.acceptEdits.jsonl' },
  noProvider: { version: '2.1.144', file: 'allow.real.acceptEdits.jsonl' },
} as const satisfies Record<string, FixtureName>;

export const AUDITS = {
  allow: { version: '2.1.271', file: 'allow.real.acceptEdits.audit.jsonl' },
  deny: { version: '2.1.271', file: 'deny.real.acceptEdits.audit.jsonl' },
  noProvider: { version: '2.1.144', file: 'allow.real.acceptEdits.audit.jsonl' },
} as const satisfies Record<string, FixtureName>;

/**
 * A stand-in host that plays back a real stream for one request: the fake `claude` prints the lines of the
 * fixture with the nonce, the made-up key, the project and the session of that request put in place of the
 * fixed ones, and asks the real hook about the call in it (`fake-claude-emulator.ts`). Several of them, given to
 * `fake.script` in order, are several requests.
 */
export const replayOf = (stream: FixtureName): Behaviour => ({
  replay: {
    lines: linesOf(readFixture(stream)),
    fixed: {
      project: FIXTURE_PROJECT,
      session: FIXTURE_SESSION,
      nonce: FIXTURE_NONCE,
      fake: FIXTURE_FAKE,
    },
  },
});
