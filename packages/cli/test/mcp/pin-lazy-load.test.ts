import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { CLI_ENTRY } from '../helpers/cli-entry.js';
import { fixture } from './pin-fixture.js';

it('does not load runtime pin or install verification modules for the built Claude hook', async () => {
  const f = await fixture();
  const trace = join(f.home, 'loaded.jsonl');
  const loader = join(f.home, 'trace-loader.mjs');
  const registration = join(f.home, 'register.mjs');
  await writeFile(
    loader,
    `import {appendFileSync} from "node:fs";
export async function load(url, context, nextLoad) {
  appendFileSync(${JSON.stringify(trace)}, JSON.stringify(url) + "\\n");
  return nextLoad(url, context);
}`,
  );
  await writeFile(
    registration,
    'import {register} from "node:module";register(new URL("./trace-loader.mjs",import.meta.url));',
  );
  execFileSync(
    process.execPath,
    ['--import', pathToFileURL(registration).href, CLI_ENTRY, 'hook', 'claude-code'],
    {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        cwd: f.home,
        session_id: 'pin-lazy',
      }),
      env: { ...process.env, STROQ_HOME: f.home },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const loaded = (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string);
  expect(loaded).toContain(pathToFileURL(CLI_ENTRY).href);
  const sources = await Promise.all(
    loaded
      .filter((url) => url.startsWith('file:'))
      .map((url) => readFile(fileURLToPath(url), 'utf8')),
  );
  const code = sources.join('\n');
  for (const source of [
    'mcp/pin.ts',
    'install/read-dir.ts',
    'install/lock-reader.ts',
    'install/safe-path.ts',
  ]) {
    expect(code).not.toContain(`// packages/cli/src/${source}`);
  }
});
