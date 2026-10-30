import { basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Close = () => Promise<void>;
interface PlatformLauncher {
  launch(
    args: readonly string[],
    options: { out: (line: string) => void },
  ): Promise<{ close: Close } | null>;
}
interface Dependencies {
  readonly load?: () => Promise<PlatformLauncher>;
  readonly bindClose?: (close: Close) => void;
  readonly out?: (line: string) => void;
  readonly error?: (line: string) => void;
}

/** Bundled chunks live in dist; source execution lives in src/commands. Neither uses cwd. */
export function consoleLauncherUrl(from = import.meta.url): URL {
  const directory = dirname(fileURLToPath(from));
  const root =
    basename(directory) === 'commands' ? dirname(dirname(directory)) : dirname(directory);
  return new URL('platform/scripts/launch.mjs', pathToFileURL(`${root}/`));
}

function bindSignals(close: Close): void {
  let closing = false;
  const stop = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await close();
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

/** This module itself is lazy: hook startup never reads the web server or its workers. */
export async function runConsole(
  argv: readonly string[],
  deps: Dependencies = {},
): Promise<number> {
  try {
    const launcher = await (deps.load?.() ?? import(consoleLauncherUrl().href));
    const app = await launcher.launch(argv, {
      out: deps.out ?? ((line: string) => process.stdout.write(`${line}\n`)),
    });
    if (app) (deps.bindClose ?? bindSignals)(app.close);
    return 0;
  } catch {
    (deps.error ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      'Could not start Stroq console. Select an existing workspace and an available local port. For a source checkout, run pnpm platform:build first; for an installed package, reinstall @stroq/cli.',
    );
    return 1;
  }
}
