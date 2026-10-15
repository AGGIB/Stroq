export function openclawRecorderSource(paths: {
  node: string;
  cli: string;
  log: string;
  home: string;
  stroqHome: string;
}): string {
  return `
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const phase = args.find((a) => a === 'pre' || a === 'post') ?? 'pre';
const input = readFileSync(0, 'utf8');
const parsedInput = input ? JSON.parse(input.replace(/^\\uFEFF/, '')) : null;
const result = spawnSync(${JSON.stringify(paths.node)}, [${JSON.stringify(paths.cli)}, 'hook', 'openclaw', phase], {
  input,
  encoding: 'utf8',
  timeout: 25000,
  env: {
    ...process.env,
    HOME: ${JSON.stringify(paths.home)},
    USERPROFILE: ${JSON.stringify(paths.home)},
    STROQ_HOME: ${JSON.stringify(paths.stroqHome)},
  },
});
const exitCode = result.status ?? 1;
appendFileSync(
  ${JSON.stringify(paths.log)},
  JSON.stringify({
    at: new Date().toISOString(),
    phase,
    input: parsedInput,
    inputHadBom: input.charCodeAt(0) === 0xfeff,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode,
    error: result.error?.message,
  }) + '\\n',
  { mode: 0o600 }
);
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = exitCode;
`;
}
