import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { executeLiveEngine } from './live-proof-process.mjs';
const adapter = fileURLToPath(new URL('../.local-engine/live-proof-engine.js', import.meta.url));
const available = existsSync(adapter);
const real = {
  skip: available ? false : 'Run pnpm build:engine for authoritative live engine projection tests',
};
const engine = available ? await import(adapter) : null;
const evidence = { E1: true, E2: true, E3: true, E4: true };
const fixture = (overrides = {}) => ({
  version: 1,
  agent: 'claude-code',
  hostVersion: '2.1.271',
  stroqVersion: '0.28.0',
  policySha256: 'a'.repeat(64),
  at: '2026-10-22T00:00:00.000Z',
  mode: 'live',
  state: 'verified',
  caveats: [],
  probes: [
    { id: 'allow', kind: 'allow', mark: 'passed', reason: 'ran', evidence },
    { id: 'deny', kind: 'deny', mark: 'passed', reason: 'blocked', evidence },
    {
      id: 'deny:control',
      kind: 'deny',
      mark: 'passed',
      reason: 'armed',
      evidence: { ...evidence, E2: null, E4: null },
    },
  ],
  ...overrides,
});

test(
  'authoritative parser rejects verified claim when the control or hook evidence is absent',
  real,
  () => {
    const valid = fixture();
    assert.equal(engine.projectHostResult(valid).state, 'verified');
    for (const changed of [
      fixture({ probes: valid.probes.slice(0, 2) }),
      fixture({
        probes: valid.probes.map((p) => ({ ...p, evidence: { ...p.evidence, E4: false } })),
      }),
      fixture({
        probes: valid.probes.map((p) => ({ ...p, evidence: { ...p.evidence, E1: false } })),
      }),
      fixture({ extra: 'field' }),
    ])
      assert.throws(() => engine.projectHostResult(changed), /invalid-report/);
  },
);
test('stand-in fixture cannot be projected as verified live protection', real, () => {
  const result = engine.projectHostResult(fixture({ mode: 'stand-in' }));
  assert.equal(result.mode, 'stand-in');
  assert.equal(result.state, 'not-attempted');
});
test(
  'public projection removes private details, unknown caveats and unrecognized reason contents',
  real,
  () => {
    const original = fixture({
      hostVersion: 'SECRET_VERSION_SENTINEL',
      caveats: ['SECRET_CAVEAT_SENTINEL'],
      probes: fixture().probes.map((p) => ({
        ...p,
        detail: 'SECRET_DETAIL_SENTINEL',
        reason: 'secret-reason-sentinel',
      })),
    });
    const result = engine.projectHostResult(original);
    assert.equal(result.hostVersion, null);
    assert.deepEqual(result.caveats, ['additional-host-caveat']);
    assert.equal(result.probes[0].reason, 'other');
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL|secret-reason-sentinel/);
  },
);
test(
  'offline subprocess inspection reads existing proof conservatively and performs no host detection',
  real,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stroq-offline-proof-'));
    const options = {
      adapter,
      project: directory,
      userHome: directory,
      home: join(directory, '.stroq'),
      environment: { PATH: '/a/nonexistent/fixture/bin' },
    };
    try {
      const baseline = await executeLiveEngine('inspect', { version: '0.28.0' }, options);
      assert.match(baseline.policySha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(baseline.proofs, {});
      await mkdir(join(options.home, 'live'), { recursive: true });
      await writeFile(
        join(options.home, 'live/claude-code.json'),
        JSON.stringify(fixture({ policySha256: baseline.policySha256 })),
      );
      const inspected = await executeLiveEngine('inspect', { version: '0.28.0' }, options);
      assert.equal(inspected.proofs['claude-code'].state, 'stale');
      assert.equal(inspected.proofs['claude-code'].reason, 'host-version-not-rechecked');
      assert.equal(inspected.proofs['claude-code'].report.state, 'verified');
      await writeFile(
        join(options.home, 'live/claude-code.json'),
        JSON.stringify(
          fixture({ policySha256: baseline.policySha256, probes: fixture().probes.slice(0, 2) }),
        ),
      );
      assert.deepEqual(
        (await executeLiveEngine('inspect', { version: '0.28.0' }, options)).proofs,
        {},
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'stand-in execution exercises the real verifier, caps requests and removes its temporary project',
  real,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stroq-stand-in-proof-'));
    const worker = join(directory, 'fixture.mjs');
    const options = {
      adapter: worker,
      project: directory,
      userHome: directory,
      home: join(directory, '.stroq'),
      environment: { PATH: '/a/nonexistent/fixture/bin' },
    };
    await writeFile(
      worker,
      `import {existsSync} from 'node:fs';process.argv[2]='fixture-only';const {inspectLive,runLiveProof}=await import(${JSON.stringify(new URL('../.local-engine/live-proof-engine.js', import.meta.url).href)});
 process.once('message',async()=>{let made=0;let temporary=null;const inspected=inspectLive('0.28.0');const fake={mode:'stand-in',detect:async()=>({available:true,version:'2.1.271'}),run:async(_probe,ctx)=>{made++;temporary=ctx.project;return {stream:[{type:'init'},{type:'result',isError:false,text:'DONE'}],exitCode:0,timedOut:false,stderrTail:'PRIVATE_HOST_STDERR',apiProvider:'firstParty',apiKeySource:'none',cwd:ctx.project};}};
 try{const result=await runLiveProof({agent:'claude-code',version:'0.28.0',cli:'/must/not/run/cli',maxRequests:3,jobId:'11111111-2222-4333-8444-555555555555',expected:{policySha256:inspected.policySha256,hostVersion:'2.1.271'}},fake);process.send({type:'result',result:{report:result,made,temporaryRemoved:!existsSync(temporary)}});}catch(error){process.send({type:'result',result:{fixtureError:error.message}});}finally{process.disconnect();}});`,
    );
    try {
      const result = await executeLiveEngine('run', { maxRequests: 3 }, options);
      assert.equal(result.fixtureError, undefined);
      assert.equal(result.report.mode, 'stand-in');
      assert.equal(result.report.state, 'not-attempted');
      assert.ok(result.made >= 1 && result.made <= 3);
      assert.equal(result.temporaryRemoved, true);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_HOST_STDERR/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'default runtime fingerprint accepts bundled adapter and absent initial configuration using fixture detect/run only',
  real,
  async () => {
    const { createLiveProofService } = await import('./live-proof-service.mjs');
    const directory = await mkdtemp(join(tmpdir(), 'stroq-proof-preview-'));
    let calls = 0;
    const service = await createLiveProofService({
      project: directory,
      userHome: directory,
      home: join(directory, '.stroq'),
      environment: { PATH: '/fixture/no-agent' },
      platform: 'darwin',
      available: async () => ({ available: true, version: '0.28.0' }),
      detect: async () => ({ available: true, version: '2.1.271' }),
      run: async () => {
        calls++;
        return {
          state: 'inconclusive',
          mode: 'live',
          hostVersion: '2.1.271',
          requestsMade: 0,
          probes: [],
          caveats: [],
          advice: [],
        };
      },
    });
    try {
      const preview = await service.preview({ agent: 'claude-code', maxRequests: 3 });
      assert.equal(preview.status, 200, preview.body.error);
      assert.equal(preview.body.canStart, true);
      assert.equal(calls, 0);
      const started = await service.start({
        previewId: preview.body.id,
        acknowledgeSubscriptionUsage: true,
        maxRequests: 3,
      });
      assert.equal(started.status, 202, started.body.error);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'real configuration change after preview prevents any fixture inference start',
  real,
  async () => {
    const { createLiveProofService } = await import('./live-proof-service.mjs');
    const directory = await mkdtemp(join(tmpdir(), 'stroq-proof-config-race-'));
    let calls = 0;
    const service = await createLiveProofService({
      project: directory,
      userHome: directory,
      home: join(directory, '.stroq'),
      environment: { PATH: '/fixture/no-agent' },
      platform: 'darwin',
      available: async () => ({ available: true, version: '0.28.0' }),
      detect: async () => ({ available: true, version: '2.1.271' }),
      run: async () => {
        calls++;
        throw new Error('must not start');
      },
    });
    try {
      const preview = await service.preview({ agent: 'claude-code', maxRequests: 3 });
      assert.equal(preview.body.canStart, true);
      await mkdir(join(directory, '.claude'));
      await writeFile(join(directory, '.claude/settings.json'), '{"hooks":{}}');
      const started = await service.start({
        previewId: preview.body.id,
        acknowledgeSubscriptionUsage: true,
        maxRequests: 3,
      });
      assert.equal(started.status, 409);
      assert.equal(started.body.error, 'preview-stale');
      assert.equal(calls, 0);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'configuration symlinks below fixed workspace roots are refused before starting a host',
  { ...real, skip: !available || process.platform === 'win32' },
  async () => {
    const { symlink } = await import('node:fs/promises');
    const { createLiveProofService } = await import('./live-proof-service.mjs');
    const directory = await mkdtemp(join(tmpdir(), 'stroq-proof-link-'));
    const workspace = join(directory, 'workspace');
    const outside = join(directory, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(outside, 'settings.json'), '{"private":"PRIVATE_CONFIG_SENTINEL"}');
    await symlink(outside, join(workspace, '.claude'));
    const service = await createLiveProofService({
      project: workspace,
      userHome: directory,
      home: join(directory, '.stroq'),
      environment: { PATH: '/fixture/no-agent' },
      platform: 'darwin',
      available: async () => ({ available: true, version: '0.28.0' }),
      detect: async () => ({ available: true, version: '2.1.271' }),
    });
    try {
      const preview = await service.preview({ agent: 'claude-code', maxRequests: 3 });
      assert.equal(preview.status, 503);
      assert.equal(preview.body.error, 'configuration-unreadable');
      assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_CONFIG_SENTINEL/);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
