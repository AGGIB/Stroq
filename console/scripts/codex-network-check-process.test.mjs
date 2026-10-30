import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as supervisor from './hook-check-process.mjs';
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-network-process-test-')));
after(() => rm(output, { recursive: true, force: true }));
async function adapter(name, body) {
  const path = join(output, name + '.mjs');
  await writeFile(path, body);
  return path;
}
const validateResult = (v) => v?.ok === true && Object.keys(v).length === 1;
test('supervisor selects only the fixed network flag, validates IPC and waits for exit', async () => {
  assert.equal(typeof supervisor.executeCodexNetworkCheck, 'function');
  const path = await adapter(
    'success',
    `import{mkdtemp,realpath,lstat,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';if(!process.argv.includes('--stroq-codex-network-check-engine')||process.argv.includes('--stroq-hook-check-engine'))process.exit(5);process.once('message',async()=>{const root=await realpath(await mkdtemp(join(tmpdir(),'stroq-console-net-')));const s=await lstat(root);process.send({type:'scratch',root:{root,dev:s.dev,ino:s.ino}});await writeFile(join(root,'.stroq-live-throwaway'),'made by stroq prove: everything in this directory may be removed\\n',{mode:0o600});process.send({type:'progress',id:'native'});process.send({type:'result',result:{ok:true}},()=>process.exit(0));});`,
  );
  const progress = [];
  assert.deepEqual(
    await supervisor.executeCodexNetworkCheck(
      {},
      { adapterPath: path, validateResult, onProgress: (id) => progress.push(id) },
    ),
    { ok: true },
  );
  assert.deepEqual(progress, ['native']);
});
test('arbitrary private result or missing validator cannot reach the controller', async () => {
  const path = await adapter(
    'invalid',
    `process.once('message',()=>process.send({type:'result',result:{ok:true,raw:'PRIVATE'}},()=>process.exit(0)));`,
  );
  await assert.rejects(
    supervisor.executeCodexNetworkCheck({}, { adapterPath: path, validateResult }),
    { message: 'invalid-report' },
  );
  await assert.rejects(supervisor.executeCodexNetworkCheck({}, { adapterPath: path }), {
    message: 'invalid-input',
  });
});

test('network result without registered cleanup evidence is refused even when its DTO is valid', async () => {
  const path = await adapter(
    'missing-scratch',
    `process.once('message',()=>process.send({type:'result',result:{ok:true}},()=>process.exit(0)));`,
  );
  await assert.rejects(
    supervisor.executeCodexNetworkCheck({}, { adapterPath: path, validateResult }),
    { message: 'invalid-report' },
  );
});
test('cancellation cleans registered owned scratch after killing an uncooperative worker', async () => {
  const info = join(output, 'scratch.json');
  const path = await adapter(
    'cancel',
    `import{mkdtemp,realpath,lstat,writeFile,mkdir}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';process.on('message',async m=>{if(m.type!=='start')return;const root=await realpath(await mkdtemp(join(tmpdir(),'stroq-console-net-')));const s=await lstat(root);process.send({type:'scratch',root:{root,dev:s.dev,ino:s.ino}});await writeFile(join(root,'.stroq-live-throwaway'),'made by stroq prove: everything in this directory may be removed\\n',{mode:0o600});await mkdir(join(root,'fixture'));await writeFile(${JSON.stringify(info)},JSON.stringify({root}));});`,
  );
  const controller = new AbortController(),
    running = supervisor.executeCodexNetworkCheck(
      {},
      { adapterPath: path, validateResult, signal: controller.signal },
    );
  let value;
  for (let n = 0; n < 100; n++) {
    try {
      value = JSON.parse(await readFile(info, 'utf8'));
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(value);
  controller.abort();
  await assert.rejects(running, { message: 'cancelled' });
  await assert.rejects(lstat(value.root), { code: 'ENOENT' });
});
