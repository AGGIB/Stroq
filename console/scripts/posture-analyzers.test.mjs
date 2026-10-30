import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { parse as parseToml } from 'smol-toml';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const loader = await mkdtemp(join(tmpdir(), 'stroq-posture-loader-'));
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
const imported = (path) => tsImport(path, { parentURL: import.meta.url, tsconfig });
const A = await imported('./posture-analyzers.ts');
const schemas = await imported('../lib/posture.ts');

const ids = (findings) => findings.map((f) => `${f.id}:${f.count ?? '-'}`).sort();
const HOME = '/Users/someone';

test('Claude Code: hooks off is critical in every scope, including a repository file', () => {
  for (const scope of ['user', 'project', 'local'])
    assert.deepEqual(
      ids(A.analyzeClaudeSettings({ disableAllHooks: true }, scope)).filter((i) =>
        i.startsWith('claude-hooks'),
      ),
      ['claude-hooks-off:-'],
    );
  const hooks = (value) =>
    A.analyzeClaudeSettings(value, 'user').filter((f) => f.id === 'claude-hooks-off');
  assert.deepEqual(hooks({ disableAllHooks: false }), []);
  assert.deepEqual(hooks({ disableAllHooks: 'true' }), [], 'only a real boolean counts');
  assert.deepEqual(hooks({ disableAllHooks: 1 }), []);
});

test('Claude Code: bypass mode is high in your own file and a lower finding in a project or local file', () => {
  const bypass = { permissions: { defaultMode: 'bypassPermissions' } };
  assert.deepEqual(
    ids(A.analyzeClaudeSettings(bypass, 'user')).filter((i) => i.startsWith('claude-bypass')),
    ['claude-bypass-permissions:-'],
  );
  // Current Claude Code ignores it there, but versions before 2.1.257 honored it.
  for (const scope of ['local', 'project'])
    assert.deepEqual(
      ids(A.analyzeClaudeSettings(bypass, scope)).filter((i) => i.startsWith('claude-bypass')),
      ['claude-bypass-ignored:-'],
      scope,
    );
  for (const mode of ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto'])
    assert.deepEqual(
      ids(A.analyzeClaudeSettings({ permissions: { defaultMode: mode } }, 'user')).filter((i) =>
        i.startsWith('claude-bypass'),
      ),
      [],
      mode,
    );
  assert.deepEqual(
    ids(A.analyzeClaudeSettings({ skipDangerousModePermissionPrompt: true }, 'user')).filter((i) =>
      i.startsWith('claude-bypass'),
    ),
    ['claude-bypass-accepted:-'],
  );
  assert.deepEqual(
    ids(A.analyzeClaudeSettings({ skipDangerousModePermissionPrompt: true }, 'project')).filter(
      (i) => i.startsWith('claude-bypass'),
    ),
    [],
  );
});

test('Claude Code: wide allow rules are counted by kind, and narrow ones are left alone', () => {
  const rules = {
    permissions: {
      allow: [
        'Bash',
        'Bash(*)',
        'Bash(python *)',
        'Bash(node:*)',
        'Bash(curl *)',
        'Bash(docker exec *)',
        'WebFetch',
        'WebFetch(domain:*)',
        'Bash(pnpm test)',
        'Bash(git status)',
        'Read(./src/**)',
        'WebFetch(domain:docs.example.com)',
        'Edit(./src/**)',
      ],
    },
  };
  const found = ids(A.analyzeClaudeSettings(rules, 'user')).filter((i) =>
    i.startsWith('claude-allow'),
  );
  assert.deepEqual(found, [
    'claude-allow-any-shell:2',
    'claude-allow-any-web:2',
    'claude-allow-interpreter:4',
  ]);
  assert.deepEqual(
    ids(
      A.analyzeClaudeSettings(
        { permissions: { allow: ['Bash(pnpm test)', 'Bash(git diff *)', 'Bash(npm run build)'] } },
        'user',
      ),
    ).filter((i) => i.startsWith('claude-allow')),
    [],
  );
});

test('Claude Code: allow rules are read safely when they are not a list of strings', () => {
  for (const allow of [null, 'Bash', { 0: 'Bash' }, [1, 2, null], [{}], [['Bash']]])
    assert.deepEqual(
      ids(A.analyzeClaudeSettings({ permissions: { allow } }, 'user')).filter((i) =>
        i.startsWith('claude-allow'),
      ),
      [],
      JSON.stringify(allow),
    );
  const huge = { permissions: { allow: Array.from({ length: 50_000 }, () => 'Bash(*)') } };
  const found = A.analyzeClaudeSettings(huge, 'user').find(
    (f) => f.id === 'claude-allow-any-shell',
  );
  assert.ok(found && found.count <= 10_000, 'a huge list is bounded');
  assert.equal(
    schemas.validatePostureAudit({
      schema: 'stroq-posture/1',
      source: 'local',
      generatedAt: '2026-10-27T10:00:00.000Z',
      sources: [],
      findings: [found],
      cannotCheck: [],
      limitations: ['x'],
    }),
    true,
  );
});

test('Claude Code: project MCP approval, helper commands and a changed API address', () => {
  assert.deepEqual(
    ids(A.analyzeClaudeSettings({ enableAllProjectMcpServers: true }, 'project')).filter((i) =>
      i.startsWith('claude-all'),
    ),
    ['claude-all-project-mcp:-'],
  );
  assert.deepEqual(
    ids(A.analyzeClaudeSettings({ enableAllProjectMcpServers: true }, 'user')).filter((i) =>
      i.startsWith('claude-all'),
    ),
    ['claude-all-project-mcp:-'],
  );
  for (const key of [
    'apiKeyHelper',
    'awsAuthRefresh',
    'awsCredentialExport',
    'otelHeadersHelper',
  ]) {
    assert.deepEqual(
      ids(A.analyzeClaudeSettings({ [key]: './get-key.sh' }, 'project')).filter((i) =>
        i.startsWith('claude-repo-helper'),
      ),
      ['claude-repo-helper:-'],
      key,
    );
    assert.deepEqual(
      ids(A.analyzeClaudeSettings({ [key]: './get-key.sh' }, 'user')).filter((i) =>
        i.startsWith('claude-repo-helper'),
      ),
      [],
      `${key} in your own file is yours`,
    );
  }
  assert.deepEqual(
    A.analyzeClaudeSettings({ apiKeyHelper: '' }, 'project').filter(
      (f) => f.id === 'claude-repo-helper',
    ),
    [],
  );
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'])
    assert.deepEqual(
      ids(A.analyzeClaudeSettings({ env: { [key]: 'x' } }, 'local')).filter((i) =>
        i.startsWith('claude-repo-redirect'),
      ),
      ['claude-repo-redirect:-'],
      key,
    );
  assert.deepEqual(
    A.analyzeClaudeSettings({ env: { NODE_ENV: 'test' } }, 'project').filter(
      (f) => f.id === 'claude-repo-redirect',
    ),
    [],
  );
  assert.deepEqual(
    A.analyzeClaudeSettings({ env: { ANTHROPIC_BASE_URL: 'x' } }, 'user').filter(
      (f) => f.id === 'claude-repo-redirect',
    ),
    [],
  );
});

test('Claude Code: the sandbox note appears only for your own file and only when it is not on', () => {
  assert.deepEqual(ids(A.analyzeClaudeSettings({}, 'user')), ['claude-sandbox-off:-']);
  assert.deepEqual(ids(A.analyzeClaudeSettings({ sandbox: { enabled: false } }, 'user')), [
    'claude-sandbox-off:-',
  ]);
  assert.deepEqual(A.analyzeClaudeSettings({ sandbox: { enabled: true } }, 'user'), []);
  assert.deepEqual(A.analyzeClaudeSettings({}, 'project'), []);
});

test('a settings file that is not an object gives no findings and no failure', () => {
  for (const value of [null, undefined, 3, 'x', [], [{ disableAllHooks: true }]]) {
    assert.deepEqual(A.analyzeClaudeSettings(value, 'project'), []);
    assert.deepEqual(A.analyzeCodexConfig(value, 'project', { userHome: HOME }), []);
    assert.deepEqual(A.analyzeCursorCli(value, 'user'), []);
    assert.deepEqual(A.analyzeCursorSandbox(value, 'project'), []);
    assert.deepEqual(A.analyzeCursorPermissions(value, 'project'), []);
    assert.deepEqual(A.analyzeDevinConfig(value, 'project'), []);
  }
});

test('an inherited property is not a setting', () => {
  const inherited = Object.create({
    disableAllHooks: true,
    approval_policy: 'never',
    approvalMode: 'unrestricted',
  });
  assert.deepEqual(A.analyzeClaudeSettings(inherited, 'project'), []);
  assert.deepEqual(A.analyzeCodexConfig(inherited, 'user', { userHome: HOME }), []);
  assert.deepEqual(A.analyzeCursorCli(inherited, 'user'), []);
  const polluted = JSON.parse('{"__proto__": {"disableAllHooks": true}}');
  assert.deepEqual(A.analyzeClaudeSettings(polluted, 'project'), []);
});

test('Codex: hooks off, no approvals, no sandbox and open network', () => {
  const codex = (toml, scope = 'user') =>
    A.analyzeCodexConfig(parseToml(toml), scope, { userHome: HOME });
  assert.deepEqual(ids(codex('[features]\nhooks = false')), ['codex-hooks-off:-']);
  assert.deepEqual(ids(codex('[features]\nhooks = false', 'project')), ['codex-hooks-off:-']);
  assert.deepEqual(codex('[features]\nhooks = true'), []);
  assert.deepEqual(ids(codex('approval_policy = "never"')), ['codex-approval-never:-']);
  assert.deepEqual(ids(codex('sandbox_mode = "danger-full-access"')), [
    'codex-sandbox-full-access:-',
  ]);
  assert.deepEqual(ids(codex('default_permissions = ":danger-full-access"')), [
    'codex-sandbox-full-access:-',
  ]);
  assert.deepEqual(ids(codex('approval_policy = "never"\nsandbox_mode = "danger-full-access"')), [
    'codex-no-approvals-no-sandbox:-',
  ]);
  assert.deepEqual(
    ids(codex('approval_policy = "never"\ndefault_permissions = ":danger-full-access"')),
    ['codex-no-approvals-no-sandbox:-'],
  );
  assert.deepEqual(ids(codex('approval_policy = "never"\nsandbox_mode = "workspace-write"')), [
    'codex-approval-never:-',
  ]);
  assert.deepEqual(ids(codex('[sandbox_workspace_write]\nnetwork_access = true')), [
    'codex-network-access:-',
  ]);
  assert.deepEqual(codex('[sandbox_workspace_write]\nnetwork_access = false'), []);
  assert.deepEqual(ids(codex('approval_policy = "untrusted"')), ['codex-approval-retired:-']);
  assert.deepEqual(codex('approval_policy = "on-request"\nsandbox_mode = "workspace-write"'), []);
  assert.deepEqual(codex('approval_policy = { granular = { rules = true } }'), []);
});

test('Codex: trusting your whole home folder, or the root, is found; trusting one repository is not', () => {
  const trusted = (...paths) =>
    parseToml(paths.map((p) => `[projects."${p}"]\ntrust_level = "trusted"`).join('\n'));
  const run = (value, scope = 'user') =>
    ids(A.analyzeCodexConfig(value, scope, { userHome: HOME }));
  assert.deepEqual(run(trusted(HOME)), ['codex-home-trusted:-']);
  assert.deepEqual(run(trusted(`${HOME}/`)), ['codex-home-trusted:-']);
  assert.deepEqual(run(trusted('/')), ['codex-home-trusted:-']);
  assert.deepEqual(run(trusted('/Users')), ['codex-home-trusted:-']);
  assert.deepEqual(run(trusted(`${HOME}/code/app`)), []);
  assert.deepEqual(run(parseToml(`[projects."${HOME}"]\ntrust_level = "untrusted"`)), []);
  assert.deepEqual(
    run(trusted(HOME), 'project'),
    [],
    'the trust table is only read from your own file',
  );
});

test('Cursor: unrestricted mode and broad permission entries', () => {
  assert.deepEqual(ids(A.analyzeCursorCli({ approvalMode: 'unrestricted' }, 'user')), [
    'cursor-unrestricted:-',
  ]);
  assert.deepEqual(
    A.analyzeCursorCli({ approvalMode: 'unrestricted' }, 'project'),
    [],
    'a repository cannot set it',
  );
  assert.deepEqual(A.analyzeCursorCli({ approvalMode: 'allowlist' }, 'user'), []);
  assert.deepEqual(A.analyzeCursorCli({ approvalMode: 'auto-review' }, 'user'), []);
  const allow = [
    'Shell(*)',
    'Shell(bash)',
    'Shell(curl:*)',
    'Shell(git)',
    'Shell(ls)',
    'WebFetch(*)',
    'WebFetch(docs.example.com)',
    'Mcp(*:*)',
    'Mcp(github:get_issue)',
    'Read(src/**)',
  ];
  const found = ids(A.analyzeCursorCli({ permissions: { allow } }, 'project'));
  assert.deepEqual(found, [
    'cursor-allow-any-mcp:1',
    'cursor-allow-any-shell:3',
    'cursor-allow-any-web:1',
  ]);
  assert.deepEqual(
    ids(A.analyzeCursorCli({ permissions: { allow, deny: ['Shell(*)'] } }, 'user')),
    ['cursor-allow-any-mcp:1', 'cursor-allow-any-shell:3', 'cursor-allow-any-web:1'],
  );
});

test('Cursor: the sandbox file', () => {
  assert.deepEqual(ids(A.analyzeCursorSandbox({ type: 'insecure_none' }, 'project')), [
    'cursor-sandbox-off:-',
  ]);
  assert.deepEqual(ids(A.analyzeCursorSandbox({ networkPolicy: { default: 'allow' } }, 'user')), [
    'cursor-sandbox-network-open:-',
  ]);
  assert.deepEqual(
    ids(
      A.analyzeCursorSandbox(
        { type: 'insecure_none', networkPolicy: { default: 'allow' } },
        'user',
      ),
    ),
    ['cursor-sandbox-network-open:-', 'cursor-sandbox-off:-'],
  );
  assert.deepEqual(
    A.analyzeCursorSandbox(
      { type: 'workspace_readwrite', networkPolicy: { default: 'deny' } },
      'user',
    ),
    [],
  );
});

test('Cursor: the IDE allowlist file counts wide entries and ignores exact ones', () => {
  const wide = {
    terminalAllowlist: ['git', 'npm:install*', 'bash', 'sh:*', 'python3', 'curl', '*'],
    mcpAllowlist: ['github:get_issue', '*:*', '*'],
  };
  assert.deepEqual(ids(A.analyzeCursorPermissions(wide, 'project')), ['cursor-allowlist-wide:7']);
  assert.deepEqual(
    A.analyzeCursorPermissions(
      { terminalAllowlist: ['git', 'npm:install*', 'pnpm'], mcpAllowlist: ['github:get_issue'] },
      'user',
    ),
    [],
  );
  assert.deepEqual(
    A.analyzeCursorPermissions({ autoRun: { allow_instructions: 'run anything' } }, 'user'),
    [],
    'natural-language steering is not read as a rule',
  );
});

test('Devin local agent: any command allowed', () => {
  assert.deepEqual(
    ids(
      A.analyzeDevinConfig(
        { permissions: { allow: ['Exec(*)', 'Exec(bash)', 'Exec(git status)', 'Read(src/**)'] } },
        'project',
      ),
    ),
    ['windsurf-allow-any-exec:2'],
  );
  assert.deepEqual(
    A.analyzeDevinConfig({ permissions: { allow: ['Exec(git status)'] } }, 'user'),
    [],
  );
});

test('every finding validates against the shared catalog', () => {
  const all = [
    ...A.analyzeClaudeSettings(
      {
        disableAllHooks: true,
        permissions: { defaultMode: 'bypassPermissions', allow: ['Bash', 'WebFetch'] },
        enableAllProjectMcpServers: true,
        apiKeyHelper: 'x',
        env: { ANTHROPIC_BASE_URL: 'x' },
      },
      'local',
    ),
    ...A.analyzeCursorCli(
      { approvalMode: 'unrestricted', permissions: { allow: ['Shell(*)'] } },
      'user',
    ),
  ];
  assert.ok(all.length >= 6);
  const audit = {
    schema: 'stroq-posture/1',
    source: 'local',
    generatedAt: '2026-10-27T10:00:00.000Z',
    sources: [],
    findings: all.filter((f) => f.scope === 'local').concat(all.filter((f) => f.scope === 'user')),
    cannotCheck: [],
    limitations: ['x'],
  };
  assert.equal(schemas.validatePostureAudit(audit), true);
});

test('JSON with comments and trailing commas is read, and a comment marker inside a string is kept', () => {
  const text = `{
    // line comment
    "a": "http://example.invalid/x", /* block */
    "b": ["x", "y",],
    "c": "has // inside and /* this */",
  }`;
  const value = JSON.parse(A.stripJsonComments(text));
  assert.deepEqual(value, {
    a: 'http://example.invalid/x',
    b: ['x', 'y'],
    c: 'has // inside and /* this */',
  });
  assert.throws(() => JSON.parse(A.stripJsonComments('{ "a": }')));
  assert.equal(JSON.parse(A.stripJsonComments('{"s": "a\\"//b"}')).s, 'a"//b');
});

test('Claude Code: a rule that names its arguments is narrow, and only a wildcard makes a program open', () => {
  const count = (allow) =>
    ids(A.analyzeClaudeSettings({ permissions: { allow } }, 'user'))
      .filter((i) => i.startsWith('claude-allow-interpreter'))
      .join();
  for (const narrow of [
    'Bash(node scripts/build.js)',
    'Bash(python manage.py test)',
    'Bash(python manage.py test *)',
    'Bash(curl https://api.example.com/health)',
    'Bash(bash ./scripts/test.sh)',
    'Bash(bash ./scripts/test.sh *)',
    'Bash(ssh myhost uptime)',
    'Bash(node)',
    'Bash(docker ps)',
    'Bash(npm run build)',
    'Bash(timeout 10 pnpm test)',
    'Bash(python -m pytest *)',
    'Bash(env FOO=1 ./run.sh *)',
  ])
    assert.equal(count([narrow]), '', narrow);
});

test('Claude Code: wide rules are found however the wildcard is written or the program is wrapped', () => {
  const count = (rule) =>
    ids(A.analyzeClaudeSettings({ permissions: { allow: [rule] } }, 'user'))
      .filter((i) => i.startsWith('claude-allow-interpreter'))
      .join();
  for (const wide of [
    'Bash(curl*)',
    'Bash(python3*)',
    'Bash(bash*)',
    'Bash(sh*)',
    'Bash(python3.12 *)',
    'Bash(/usr/bin/curl *)',
    'Bash(timeout 10 bash *)',
    'Bash(nohup sh *)',
    'Bash(command bash *)',
    'Bash(nice -n 5 node *)',
    'Bash(npm exec *)',
    'Bash(pnpm dlx *)',
    'Bash(yarn dlx *)',
    'Bash(find . -exec *)',
    'Bash(docker exec *)',
    'Bash(kubectl exec *)',
    'Bash(bash -c *)',
    'Bash(python -c *)',
    'Bash(python3 -u -c *)',
    'Bash(node -e *)',
    'Bash(env bash *)',
    'Bash(env FOO=1 bash *)',
    'Bash(sudo bash *)',
    'Bash(npx -y *)',
    'Bash(bash -- *)',
  ])
    assert.equal(count(wide), 'claude-allow-interpreter:1', wide);
});

test('a long run of wildcard and separator characters in a rule is read in linear time', () => {
  const rule = `Bash(a${' *'.repeat(249)}x)`;
  const started = process.hrtime.bigint();
  for (let i = 0; i < 400; i += 1)
    A.analyzeClaudeSettings({ permissions: { allow: [rule] } }, 'user');
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 1500, `${ms} ms for 400 hostile rules`);
});

test('Codex: odd trust paths are read the way the file system reads them', () => {
  const run = (path, home = HOME) =>
    ids(
      A.analyzeCodexConfig({ projects: { [path]: { trust_level: 'trusted' } } }, 'user', {
        userHome: home,
      }),
    );
  assert.deepEqual(run(''), [], 'an empty key is not the root');
  assert.deepEqual(run(`${HOME}/.`), ['codex-home-trusted:-']);
  assert.deepEqual(run(`${HOME}//`), ['codex-home-trusted:-']);
  assert.deepEqual(run(`${HOME}/code/..`), ['codex-home-trusted:-']);
  assert.deepEqual(run('~'), ['codex-home-trusted:-']);
  assert.deepEqual(
    run('C:\\users\\x', 'C:\\Users\\x'),
    ['codex-home-trusted:-'],
    'drive paths ignore case',
  );
  assert.deepEqual(run('\\\\?\\C:\\Users\\x', 'C:\\Users\\x'), ['codex-home-trusted:-']);
  assert.deepEqual(run('C:\\', 'C:\\Users\\x'), ['codex-home-trusted:-']);
  assert.deepEqual(run('C:\\Users\\x\\code', 'C:\\Users\\x'), []);
  assert.deepEqual(
    run('/Users/someone2'),
    [],
    'a folder that only starts with the same letters is not a parent',
  );
});
