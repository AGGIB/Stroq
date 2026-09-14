import { readFileSync } from 'node:fs';
import { parseScenarioCorpus, type Scenario } from '../scenario.js';
import { paddedSecretExfil } from './exfiltration.js';

/**
 * Every scenario but `paddedSecretExfil` (whose 2 MiB fixture is generated at load
 * time — see exfiltration.ts) lives in `corpus.json`, not as TS literals, so the
 * recorded attack payloads — a `curl | sh` README, a base64 shell installer, an
 * SSH-key exfiltration curl — never appear as text inside the bundled `dist/index.js`.
 * They ship as an adjacent, inert JSON data file instead; `stroq attack` reads and
 * validates it at startup the same way it reads the default policy.
 */
const CORPUS_URL = new URL('./corpus.json', import.meta.url);
const rawCorpus: unknown = JSON.parse(readFileSync(CORPUS_URL, 'utf8'));

/**
 * The launch suite, in id order. `paddedSecretExfil` (`13-padded-secret-exfil`) is
 * generated rather than stored in `corpus.json` — see its own file — so it is appended
 * here rather than sitting in the JSON at its numeric position; sorting after the
 * append is what keeps the exported order matching the `NN-` prefixes once ids above
 * 13 exist in `corpus.json`.
 */
export const SCENARIOS: readonly Scenario[] = [...parseScenarioCorpus(rawCorpus), paddedSecretExfil]
  .slice()
  .sort((a, b) => a.id.localeCompare(b.id));
