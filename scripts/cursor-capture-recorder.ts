export function cursorRecorderSource(paths: {
  node: string;
  cli: string;
  log: string;
  home: string;
  stroqHome: string;
}): string {
  return `
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const input = readFileSync(0, 'utf8');
const result = spawnSync(${JSON.stringify(paths.node)}, [${JSON.stringify(paths.cli)}, 'hook', 'cursor'], {
 input, encoding: 'utf8', timeout: 10000,
 env: {...process.env, HOME:${JSON.stringify(paths.home)}, USERPROFILE:${JSON.stringify(paths.home)}, STROQ_HOME:${JSON.stringify(paths.stroqHome)}}});
appendFileSync(${JSON.stringify(paths.log)}, JSON.stringify({at:new Date().toISOString(),input:JSON.parse(input),stdout:result.stdout,stderr:result.stderr,exitCode:result.status,error:result.error?.message})+'\\n', {mode:0o600});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode=result.status ?? 1;
`;
}
