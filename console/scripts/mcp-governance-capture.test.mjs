import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

const loader = await mkdtemp(join(tmpdir(), 'stroq-governance-capture-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: {
      baseUrl: repositoryRoot,
      paths: { '@stroq/core': ['packages/core/src/index.ts'] },
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
    },
  }),
);
const { captureMcpGovernanceSources: capture } = await tsImport('./mcp-governance-capture.ts', {
  parentURL: import.meta.url,
  tsconfig,
});
const { validateMcpGovernanceCapture } = await tsImport('../lib/mcp-governance.ts', {
  parentURL: import.meta.url,
  tsconfig,
});
const { governanceCapture } = await tsImport('../lib/mcp-governance-fixtures.ts', {
  parentURL: import.meta.url,
  tsconfig,
});
const plain = {
  command: '/never-execute',
  args: ['PRIVATE_ARGUMENT'],
  env: { TOKEN: 'PRIVATE_VALUE' },
};
async function put(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-governance-capture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'),
    userHome = join(root, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project);
  await mkdir(userHome);
  const proxyRuntime = {
    fingerprint: 'e'.repeat(64),
    command: '/fixed/node',
    entry: '/fixed/index.js',
    home,
    userHome,
  };
  return {
    root,
    project,
    userHome,
    home,
    platform: 'darwin',
    mcpEnvironment: {},
    codexEnvironment: {},
    contextId: 'context-fixture',
    policyFingerprint: 'a'.repeat(64),
    proxyRuntime,
  };
}
const pair = (v, channel, name) =>
  v.privateChoices.find((row) => row.pair.channel === channel && row.pair.name === name);
const choice = (v, id) => v.choices.find((row) => row.id === id);
const wrapper = (f, server = 'proxy-label', env = {}) => ({
  command: f.proxyRuntime.command,
  args: [
    f.proxyRuntime.entry,
    'mcp',
    '--server',
    server,
    '--client',
    'claude-code',
    '--cwd',
    f.project,
    '--pass-env',
    '',
    '--',
    '/never-execute',
  ],
  env: { STROQ_HOME: f.home, HOME: f.userHome, USERPROFILE: f.userHome, ...env },
});

test('coalesces exact pairs across sources, preserves retained allowances, and hashes full sources', async (t) => {
  const f = await fixture(t);
  await put(join(f.project, '.cursor/mcp.json'), { mcpServers: { github: plain } });
  await put(join(f.userHome, '.cursor/mcp.json'), { mcpServers: { github: plain } });
  const allowed = [
    { channel: 'cursor', name: 'github' },
    { channel: 'codex', name: 'retained' },
  ];
  const a = await capture(f, allowed),
    b = await capture(f, allowed);
  assert.equal(a.sha256, b.sha256);
  assert.equal(choice(a, pair(a, 'cursor', 'github').id).kind, 'both');
  assert.equal(choice(a, pair(a, 'cursor', 'github').id).sourceRefs.length, 2);
  assert.equal(choice(a, pair(a, 'codex', 'retained').id).kind, 'retained');
  assert.ok(a.gaps.some((gap) => gap.code === 'partial-capture'));
  assert.ok(
    a.choices.every(
      (row) => /^choice-[a-f0-9]{64}$/.test(row.id) && /^[a-f0-9]{64}$/.test(row.expectedSha256),
    ),
  );
  await put(join(f.userHome, '.cursor/mcp.json'), {
    mcpServers: { github: plain },
    unrelated: true,
  });
  const c = await capture(f, allowed);
  assert.notEqual(a.sha256, c.sha256);
  assert.equal(pair(a, 'cursor', 'github').id, pair(c, 'cursor', 'github').id);
  assert.notEqual(
    choice(a, pair(a, 'cursor', 'github').id).expectedSha256,
    choice(c, pair(c, 'cursor', 'github').id).expectedSha256,
  );
  assert.ok(!JSON.stringify(a).includes('PRIVATE_ARGUMENT'));
  assert.ok(!JSON.stringify(a).includes('PRIVATE_VALUE'));
  assert.ok(!JSON.stringify(a.choices).includes(f.root));
});

test('separates exact aliases and makes ambiguous encoded identities unselectable', async (t) => {
  const f = await fixture(t);
  await put(join(f.project, '.mcp.json'), {
    mcpServers: { git_hub: plain, 'git hub': plain, srv__other: plain },
  });
  await put(join(f.project, '.cursor/mcp.json'), { mcpServers: { srv__other: plain } });
  const value = await capture(f, []);
  assert.ok(pair(value, 'claude-code', 'git_hub'));
  assert.equal(pair(value, 'claude-code', 'git hub'), undefined);
  assert.equal(pair(value, 'claude-code', 'srv__other'), undefined);
  assert.ok(pair(value, 'cursor', 'srv__other'));
  assert.ok(
    value.choices.some(
      (row) => row.eligibility === 'ambiguous' && row.reason === 'ambiguous-identity',
    ),
  );
  assert.ok(value.gaps.some((row) => row.code === 'identity-unsupported'));
  assert.ok(value.gaps.some((row) => row.code === 'identity-ambiguous'));
});

test('current runtime and explicit same home are prerequisites for a separate proxy pair', async (t) => {
  const f = await fixture(t);
  const file = join(f.project, '.mcp.json');
  await put(file, { mcpServers: { registration: wrapper(f) } });
  const good = await capture(f, []);
  assert.ok(pair(good, 'claude-code', 'registration'));
  assert.ok(pair(good, 'mcp-proxy', 'proxy-label'));
  await put(file, {
    mcpServers: { registration: wrapper(f, 'proxy-label', { STROQ_HOME: join(f.root, 'other') }) },
  });
  const other = await capture(f, []);
  assert.equal(pair(other, 'mcp-proxy', 'proxy-label'), undefined);
  assert.ok(other.gaps.some((row) => row.code === 'proxy-other-home'));
  await put(file, { mcpServers: { registration: { ...wrapper(f), command: '/spoofed/node' } } });
  const spoof = await capture(f, []);
  assert.equal(pair(spoof, 'mcp-proxy', 'proxy-label'), undefined);
  assert.ok(spoof.gaps.some((row) => row.code === 'proxy-unverified'));
  await put(file, { mcpServers: { registration: wrapper(f) } });
  assert.equal(
    pair(await capture({ ...f, proxyRuntime: undefined }, []), 'mcp-proxy', 'proxy-label'),
    undefined,
  );
});

test('HTTP ambiguity, startup injection and missing explicit environment never establish proxy identity', async (t) => {
  const f = await fixture(t),
    file = join(f.project, '.mcp.json');
  for (const entry of [
    { ...wrapper(f), url: 'http://127.0.0.1:1' },
    { ...wrapper(f), type: 'http' },
    wrapper(f, 'proxy-label', { NODE_OPTIONS: '--require=/never-execute' }),
    { ...wrapper(f), env: { STROQ_HOME: f.home } },
  ]) {
    await put(file, { mcpServers: { registration: entry } });
    const value = await capture(f, []);
    assert.equal(pair(value, 'mcp-proxy', 'proxy-label'), undefined);
    assert.ok(value.gaps.some((row) => row.code === 'proxy-unverified'));
  }
});

test('duplicate JSON registration keys are unavailable rather than a guessed winner', async (t) => {
  const f = await fixture(t);
  await put(
    join(f.project, '.mcp.json'),
    '{"mcpServers":{"github":{"command":"first"},"github":{"command":"second"}}}',
  );
  const value = await capture(f, []);
  assert.equal(value.privateChoices.length, 0);
  assert.ok(
    value.gaps.some(
      (row) => row.code === 'source-unavailable' && row.sourceId === 'claude-code-project',
    ),
  );
});

test('captures only fixed selected Codex TOML roots and marks malformed and unsupported sources', async (t) => {
  const f = await fixture(t);
  const selected = join(f.userHome, 'custom-codex');
  await put(join(selected, 'config.toml'), '[mcp_servers.github]\ncommand="/never-execute"\n');
  await put(
    join(f.userHome, '.codex/config.toml'),
    '[mcp_servers.ignored]\ncommand="/never-execute"\n',
  );
  await put(
    join(f.project, '.codex/config.toml'),
    '[mcp_servers.project]\nurl="http://127.0.0.1:1"\n',
  );
  const selectedValue = await capture({ ...f, codexEnvironment: { CODEX_HOME: selected } }, []);
  assert.ok(pair(selectedValue, 'codex', 'github'));
  assert.ok(pair(selectedValue, 'codex', 'project'));
  assert.equal(pair(selectedValue, 'codex', 'ignored'), undefined);
  await put(join(f.project, '.codex/config.toml'), '[mcp_servers.x]\ncommand="a"\ncommand="b"\n');
  const malformed = await capture({ ...f, codexEnvironment: { CODEX_HOME: selected } }, []);
  assert.ok(
    malformed.gaps.some(
      (row) => row.code === 'source-unavailable' && row.sourceId === 'codex-project',
    ),
  );
  await put(join(f.userHome, 'Library/Application Support/Claude/claude_desktop_config.json'), {
    mcpServers: { desktop: plain },
  });
  const desktop = await capture(f, []);
  assert.ok(desktop.choices.some((row) => row.pair === null && row.reason === 'unsupported-agent'));
  assert.ok(!desktop.privateChoices.some((row) => row.pair.name === 'desktop'));
});

test('absence, link and hardlink changes remain uncertainty, never an empty complete capture', async (t) => {
  const f = await fixture(t),
    file = join(f.project, '.mcp.json'),
    original = await capture(f, []);
  await put(join(f.root, 'outside.json'), { mcpServers: { hidden: plain } });
  await symlink(join(f.root, 'outside.json'), file);
  const linked = await capture(f, []);
  assert.equal(linked.privateChoices.length, 0);
  assert.notEqual(original.sha256, linked.sha256);
  assert.ok(linked.gaps.some((row) => row.code === 'source-unavailable'));
  await rm(file);
  await link(join(f.root, 'outside.json'), file);
  assert.ok((await capture(f, [])).gaps.some((row) => row.code === 'source-unavailable'));
});

test('enforces finite registration limits, redacts labels and never executes a command', async (t) => {
  const f = await fixture(t),
    marker = join(f.root, 'executed');
  const config = {
    mcpServers: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`server-${i}`, plain])),
  };
  config.mcpServers['PRIVATE_TOKEN'] = {
    command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`],
  };
  await put(join(f.project, '.mcp.json'), config);
  const value = await capture(f, []);
  assert.ok(value.choices.length <= 192);
  assert.ok(value.gaps.some((row) => row.code === 'source-limit'));
  await assert.rejects(access(marker));
  await put(join(f.project, '.mcp.json'), { mcpServers: { PRIVATE_TOKEN: plain } });
  const redacted = await capture(f, []);
  assert.ok(redacted.choices[0].pair.redacted);
  assert.ok(!JSON.stringify(redacted.choices).includes('PRIVATE_TOKEN'));
  assert.equal(
    await readFile(join(f.project, '.mcp.json'), 'utf8'),
    JSON.stringify({ mcpServers: { PRIVATE_TOKEN: plain } }),
  );
});

test('all current allowances remain selectable for removal when two identities per registration reach the choice ceiling', async (t) => {
  const f = await fixture(t);
  await put(join(f.project, '.mcp.json'), {
    mcpServers: Object.fromEntries(
      Array.from({ length: 128 }, (_, i) => [`server-${i}`, wrapper(f, `proxy-${i}`)]),
    ),
  });
  const allowed = Array.from({ length: 64 }, (_, i) => ({
    channel: 'codex',
    name: `retained-${i}`,
  }));
  const value = await capture(f, allowed);
  assert.equal(value.choices.length, 192);
  assert.equal(value.choices.filter((row) => row.inAllowSet).length, 64);
  assert.ok(allowed.every((row) => pair(value, row.channel, row.name)));
  assert.ok(value.gaps.some((row) => row.code === 'source-limit'));
});

test('captured choices and finite gaps project into the exact public capture validator', async (t) => {
  const f = await fixture(t);
  await put(join(f.project, '.mcp.json'), {
    mcpServers: { github: wrapper(f), ambiguous__name: plain, PRIVATE_TOKEN: plain },
  });
  await put(join(f.userHome, 'Library/Application Support/Claude/claude_desktop_config.json'), {
    mcpServers: { desktop: plain },
  });
  const value = await capture(f, []),
    base = governanceCapture();
  assert.equal(
    validateMcpGovernanceCapture({
      ...base,
      choices: value.choices,
      gaps: value.gaps,
      binding: { ...base.binding, captureSha256: value.sha256 },
    }),
    true,
  );
});
