import { readFileSync } from 'node:fs';
import { parseScenarioCorpus, type Scenario } from '../scenario.js';
import { paddedSecretExfil } from './exfiltration.js';

/**
 * Twelve of the thirteen scenarios (all but `paddedSecretExfil`, whose 2 MiB fixture is
 * generated at load time — see exfiltration.ts) live in `corpus.json`, not as TS
 * literals, so the recorded attack payloads — a `curl | sh` README, a base64 shell
 * installer, an SSH-key exfiltration curl — never appear as text inside the bundled
 * `dist/index.js`. They ship as an adjacent, inert JSON data file instead; `stroq
 * attack` reads and validates it at startup the same way it reads the default policy.
 */
const CORPUS_URL = new URL('./corpus.json', import.meta.url);
const rawCorpus: unknown = JSON.parse(readFileSync(CORPUS_URL, 'utf8'));

/** The launch suite, in id order. Each scenario cites the public incident it models. */
export const SCENARIOS: readonly Scenario[] = [
  ...parseScenarioCorpus(rawCorpus),
  paddedSecretExfil,
];
