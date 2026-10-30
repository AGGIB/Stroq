import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseLaunchOptions(args, cwd = process.cwd()) {
  const { values } = parseArgs({
    args,
    options: {
      workspace: { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });
  const portText = values.port ?? process.env.STROQ_CONSOLE_PORT ?? '47815';
  if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535)
    throw new Error('Invalid local port.');
  if (values.workspace !== undefined && !values.workspace.trim())
    throw new Error('Workspace must name a local directory.');
  return {
    workspace: resolve(cwd, values.workspace ?? '.'),
    port: Number(portText),
    help: values.help === true,
  };
}
export async function launch(args, { cwd = process.cwd(), out = console.log, start } = {}) {
  const options = parseLaunchOptions(args, cwd);
  if (options.help) {
    out(
      'Stroq local security platform\n\nUsage: pnpm platform [--workspace <directory>] [--port <number>]\n\nThe server binds to 127.0.0.1. Open its private URL to connect.\nThe selected workspace and this OS user define every local operation.',
    );
    return null;
  }
  const startServer = start ?? (await import('./serve.mjs')).startServer;
  const app = await startServer({ project: options.workspace, port: options.port });
  out(`Stroq — private local security platform\n${app.url}`);
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const app = await launch(process.argv.slice(2));
    if (app)
      for (const signal of ['SIGINT', 'SIGTERM'])
        process.once(signal, async () => {
          await app.close();
          process.exit(0);
        });
  } catch {
    console.error(
      'Could not start Stroq. Build the platform, select an existing workspace and check that the local port is available.',
    );
    process.exitCode = 1;
  }
}
