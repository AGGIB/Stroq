import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { probeMcpTree, type ProbeLaunchSpec } from '../../src/install/mcp-probe.js';
import { buildTree } from '../../src/install/tree.js';
import { binOnPath } from '../../src/run/which.js';

const native = process.platform !== 'win32' && binOnPath('srt') !== null;
describe.skipIf(!native && process.env['STROQ_REQUIRE_SRT'] !== '1')('native srt MCP probe', () => {
  it('enforces denied reads, writes outside scratch and raw loopback network access', async () => {
    let connections = 0;
    const listener = createServer((socket) => {
      connections++;
      socket.end();
    });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => {
      const control = connect({ host: '127.0.0.1', port }, () => {
        control.end();
        resolve();
      });
      control.on('error', reject);
    });
    const home = mkdtempSync(join(tmpdir(), 'stroq-native-owner-'));
    mkdirSync('/tmp/claude', { recursive: true });
    const sharedTemp = mkdtempSync('/tmp/claude/stroq-probe-control-');
    const sharedFile = join(sharedTemp, 'sentinel.txt');
    writeFileSync(sharedFile, 'unsandboxed write control');
    const forbidden = join(home, 'unrelated.txt');
    writeFileSync(forbidden, 'harmless read sentinel');
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'id_fixture'), 'harmless credential sentinel');
    const code = `
import {readFileSync,writeFileSync} from 'node:fs';
import {connect} from 'node:net';
let unrelated=false,credential=false,outside=false,scratch=false,network=false,sharedTemp=false,scratchError='';
try {readFileSync(${JSON.stringify(forbidden)});unrelated=true;}catch{}
try {readFileSync(${JSON.stringify(join(home, '.ssh', 'id_fixture'))});credential=true;}catch{}
try {writeFileSync(${JSON.stringify(join(home, 'write.txt'))},'x');outside=true;}catch{}
try {writeFileSync(${JSON.stringify(sharedFile)},'x');sharedTemp=true;}catch{}
try {writeFileSync(process.env.TMPDIR+'/allowed.txt','x');scratch=true;}catch(e){scratchError=String(e);}
await new Promise(resolve=>{const s=connect({host:'127.0.0.1',port:${port}});s.on('connect',()=>{network=true;s.destroy();resolve();});s.on('error',resolve);setTimeout(()=>{s.destroy();resolve();},200);});
let buf='';process.stdin.on('data',c=>{buf+=c;let n;while((n=buf.indexOf('\\n'))>=0){const q=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);if(q.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{}})+'\\n');if(q.method==='tools/list')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{tools:[{name:'native_results',description:JSON.stringify({unrelated,credential,outside,scratch,network,sharedTemp,scratchError}),inputSchema:{type:'object'}}]}})+'\\n');}});
`;
    const bytes = Buffer.from(code);
    const tree = buildTree(
      [
        {
          path: 'server.mjs',
          kind: 'file',
          exec: false,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes,
        },
      ],
      { complete: true },
    );
    try {
      let diagnostic = '';
      const result = await probeMcpTree({
        tree,
        entrypoint: 'server.mjs',
        userHome: home,
        confirm: () => true,
        timeoutMs: 15_000,
        // Keep the Linux production-launcher check. Capture Seatbelt startup errors on macOS.
        ...(process.platform === 'darwin'
          ? {
              launcher: (spec: ProbeLaunchSpec) => {
                const child = spawn(spec.command, [...spec.args], {
                  cwd: spec.cwd,
                  env: spec.env,
                  detached: true,
                  stdio: ['pipe', 'pipe', 'pipe'],
                });
                child.stderr.on('data', (chunk) => {
                  diagnostic = (diagnostic + String(chunk)).slice(0, 8192);
                });
                return child;
              },
            }
          : {}),
      });
      expect(result.error, diagnostic).toBeNull();
      expect(result.tools).toHaveLength(1);
      const { scratchError, ...observed } = JSON.parse(result.tools[0]!.description!);
      expect(observed, scratchError).toEqual({
        unrelated: false,
        credential: false,
        outside: false,
        sharedTemp: false,
        scratch: true,
        network: false,
      });
      expect(connections).toBe(1);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      rmSync(sharedTemp, { recursive: true, force: true });
    }
  });
});
