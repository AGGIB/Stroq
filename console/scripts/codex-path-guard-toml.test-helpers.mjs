import { after } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { parse } from 'smol-toml';
const loader = await mkdtemp(join(tmpdir(), 'stroq-path-toml-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
  }),
);
export const api = await tsImport('./codex-path-guard-toml.ts', {
  parentURL: import.meta.url,
  tsconfig,
});
export const operationId = '00000000-0000-4000-8000-000000000001';
export const targetPath = '/fixture/home/.aws/credentials';
export const bytes = (s) => (s === null ? null : Buffer.from(s));
export const text = (b) => Buffer.from(b).toString('utf8');
const normal = (v) =>
  Array.isArray(v)
    ? v.map(normal)
    : v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v))
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normal(x)]))
      : v;
export const doc = (s) =>
  normal(
    parse(s.replace(/^\uFEFF/, ''), {
      integersAsBigInt: true,
      unsafeKeyBehaviour: 'throw',
      maxDepth: 32,
    }),
  );
export const plan = (source, extra = {}) =>
  api.planCodexPathGuard({ bytes: bytes(source), operationId, targetPath, ...extra });
export const forms = [
  `default_permissions="source"\n[permissions.source]\nextends=":workspace"\n[permissions.source.filesystem]\n"${targetPath}" = 'read' # owned value comment\n"/fixture/independent"="deny"\n[permissions.source.network]\nenabled=false\n`,
  `default_permissions="source"\npermissions={source={extends=":workspace",filesystem={"${targetPath}"="write","/fixture/independent"="deny"},network={enabled=true}},inactive={filesystem={"/keep"="deny"}}}\n`,
  `"default_permissions"='source'\n"permissions"."source"."filesystem"."${targetPath}"='read'\n`,
  'default_permissions="source"\n[permissions.source.filesystem] # empty table\n# keep comment\n',
  'default_permissions="source"\n[permissions.source]\nextends=":workspace"\nnetwork={enabled=false}\n',
  'default_permissions="source"\npermissions={source={extends=":workspace",network={enabled=false}}}\n',
  'default_permissions="source"\npermissions={source.extends=":workspace",source.network.enabled=false}\n',
  '\uFEFF# Изначально\r\n"default_permissions"="source.with.dot"\r\n["permissions"."source.with.dot"]\r\nextends=":read-only"\r\n# Не менять\r\n',
  'default_permissions="""source"""\npermissions={source={}}\n[unrelated]\nnote=\'\'\'[permissions.fake.filesystem]\n"/fake"="deny"\n\'\'\'\n',
  'default_permissions="source"\npermissions={source={filesystem={"/fixture/independent"="deny",},},}\n',
  'default_permissions="source"\n[permissions.source.filesystem]\n":root"="deny"\n":minimal"="read"\n[permissions.source.filesystem.":workspace_roots"]\n"**/*.env"="deny"\n',
  'default_permissions="source"\npermissions={\nsource={filesystem={\n# keep inside\n"/fixture/independent"="deny",\n},},\n}',
];
