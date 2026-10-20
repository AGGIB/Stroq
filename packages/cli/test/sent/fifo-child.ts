import { join } from 'node:path';
import { canaryValuesInFile } from '../../src/sent/canaries.js';
import { gitRemoteReader } from '../../src/sent/git-remote.js';
import { headLines } from '../../src/sent/head.js';
import { loadKeys } from '../../src/sent/keys.js';
import { loadMcpServers } from '../../src/sent/mcp-config.js';
import { byteMatcher } from '../../src/sent/needles.js';

/**
 * Run by `fifo.test.ts` in a child process, never in the test runner: it points every reader of
 * `stroq sent` at a FIFO, which blocks forever for a reader that opens it plainly. If one of them
 * does, the parent's timeout kills this process and the test fails, where inside the runner the
 * same mistake would hang it.
 *
 * Prints one line of JSON: what each reader did.
 */
const dir = process.argv[2];
if (dir === undefined) throw new Error('usage: fifo-child <dir>');

const home = join(dir, 'home');
const project = join(dir, 'project');
const fifo = join(project, '.env.fifo');

const keys = loadKeys({
  home,
  env: {},
  projectDirs: [project],
  stroqHome: join(dir, 'stroq'),
});
const mcp = loadMcpServers({ home, projectDirs: [project] });
const scan = byteMatcher(['FAKEfifoNeedle0123456789']).scanFile(fifo);
let canaries = 0;
canaryValuesInFile(fifo, () => {
  canaries += 1;
  return true;
});

console.log(
  JSON.stringify({
    keys: keys.keys.map((k) => k.name),
    unreadable: keys.unreadable,
    mcp: [...mcp.known.keys()],
    gitRemote: gitRemoteReader()(project, 'origin'),
    scanFailed: scan.failed,
    canaries,
    head: await headLines(fifo, () => true),
  }),
);
