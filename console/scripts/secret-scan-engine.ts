import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cursorStateDb, cursorUnavailable } from '../../packages/cli/src/sent/cursor.js';
import { belongsHere } from '../../packages/cli/src/sent/here.js';
import { checkSessions } from '../../packages/cli/src/sent/run.js';
import { machineSessions } from '../../packages/cli/src/sent/sessions.js';
// The bundle includes the local projection module; scanner data never leaves this process.
// @ts-expect-error The JavaScript service module is bundled, not part of CLI type declarations.
import { projectSecretReport } from './secret-scan-safe.mjs';

type Input = {
  scope: 'project' | 'last';
  project: string;
  userHome: string;
  home: string;
  environment: Readonly<Record<string, string | undefined>>;
};

/** A large SQLite store is refused before the engine's all-rows reader allocates it. */
async function cursorBudget(input: Input) {
  const path = cursorStateDb(process.platform, process.env, input.userHome);
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error('input-limit');
    if (file.size > 16 * 1024 * 1024) throw new Error('input-limit');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('input-limit');
  }
  // The engine reports unavailable SQLite as a gap. Its storeRows() intentionally treats
  // corrupt or changed schemas as empty, so the platform must refuse those before claiming
  // a complete derived scan. This check holds no session rows and opens read-only/immutable.
  if (await cursorUnavailable()) return;
  const { DatabaseSync } = await import('node:sqlite');
  let database;
  try {
    const url = pathToFileURL(path);
    url.search = '?immutable=1';
    database = new DatabaseSync(url, { readOnly: true });
    const table = database
      .prepare('pragma table_list')
      .all()
      .find((row) => row.name === 'cursorDiskKV' && row.schema === 'main');
    const columns = database.prepare("pragma table_xinfo('cursorDiskKV')").all();
    // A view, virtual table or generated column can manufacture enormous values from a tiny
    // database. Only Cursor's ordinary two-column storage table is within this memory bound.
    if (
      table?.type !== 'table' ||
      columns.length !== 2 ||
      !columns.every(
        (column) => ['key', 'value'].includes(String(column.name)) && column.hidden === 0,
      )
    )
      throw new Error();
    const integrity = database.prepare('pragma quick_check(1)').get();
    if (!integrity || Object.values(integrity).length !== 1 || Object.values(integrity)[0] !== 'ok')
      throw new Error();
    database.prepare('select key, value from cursorDiskKV limit 0').all();
  } catch {
    throw new Error('scan-failed');
  } finally {
    database?.close();
  }
}

/** Uses the CLI's existing read-only credential matcher, parser and provenance classifier. */
export async function scanCredentialExposure(input: Input) {
  if (!['project', 'last'].includes(input.scope)) throw new Error('invalid-request');
  await cursorBudget(input);
  const machine = await machineSessions(input.userHome, input.environment);
  const isHere = belongsHere({ cwd: input.project, home: input.userHome });
  const selected = machine.sessions.filter(isHere).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const refs = input.scope === 'last' ? selected.slice(0, 1) : selected;
  const report = await checkSessions(
    refs,
    {
      home: input.userHome,
      cwd: input.project,
      env: input.environment,
      stroqHome: input.home,
      now: new Date(),
    },
    {
      scope: input.scope,
      cursorUnavailable: machine.cursorUnavailable,
      ...(input.scope === 'last' ? { inProject: selected.length } : {}),
      skipped: machine.sessions.filter((ref) => ref.cwd === null && !isHere(ref)).length,
    },
  );
  const codexHome = input.environment.CODEX_HOME;
  const customCodex =
    typeof codexHome === 'string' &&
    codexHome !== '' &&
    resolve(codexHome) !== resolve(join(input.userHome, '.codex'));
  return projectSecretReport(
    customCodex
      ? {
          ...report,
          complete: false,
          notChecked: [...report.notChecked, 'custom-codex-home'],
        }
      : report,
    input.scope,
  );
}

if (process.argv.includes('--stroq-console-secret-engine') && process.send) {
  process.once('message', (input: Input) => {
    void scanCredentialExposure(input).then(
      (result) => process.send?.({ type: 'result', result }, () => process.disconnect()),
      (error: Error) =>
        process.send?.(
          {
            type: 'error',
            error: error?.message === 'input-limit' ? 'input-limit' : 'scan-failed',
          },
          () => process.disconnect(),
        ),
    );
  });
}
