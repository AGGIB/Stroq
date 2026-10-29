import { after } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { parse } from 'smol-toml';
const loader = await mkdtemp(join(tmpdir(), 'stroq-network-toml-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
  }),
);
const api = await tsImport('./codex-network-guard-toml.ts', {
  parentURL: import.meta.url,
  tsconfig,
});
const operationId = '00000000-0000-4000-8000-000000000001';
const bytes = (s) => (s === null ? null : Buffer.from(s));
const text = (b) => Buffer.from(b).toString('utf8');
const normal = (v) =>
  Array.isArray(v)
    ? v.map(normal)
    : v &&
        typeof v === 'object' &&
        (Object.getPrototypeOf(v) === null || Object.getPrototypeOf(v) === Object.prototype)
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normal(x)]))
      : v;
const doc = (s) =>
  normal(
    parse(s.replace(/^\uFEFF/, ''), {
      integersAsBigInt: true,
      unsafeKeyBehaviour: 'throw',
      maxDepth: 32,
    }),
  );
const profileForms = [
  'default_permissions="source"\npermissions={source={network={enabled=true}}}\n',
  '"default_permissions" = \'source\' # selector\n[permissions.source]\nnetwork={enabled=true}\nfilesystem={read=["/fixture"],write=["/fixture/work"]}\nworkspace_roots=["/fixture/extra"]\n',
  'default_permissions="source"\npermissions={source={extends=":workspace",network={enabled=true},unknown={retain=42}},inactive={network={enabled=false}}}\n',
  'default_permissions="source"\npermissions.source={extends=":workspace",network={enabled=true},workspace_roots=["/root"]}\n',
  'default_permissions="source"\npermissions={source={}}\n',
  '\uFEFF# initial\r\ndefault_permissions="source"\r\n["permissions"] # keep\r\n"source" = {extends=":workspace",network={enabled=true}}\r\n',
  'default_permissions="source"\n[permissions.source.filesystem]\nread=["**/*.md"]\n[other]\nlarge=9_223_372_036_854_775_807\nwhen=1979-05-27T07:32:00.999Z\n',
  'default_permissions="""source"""\npermissions={source={}}\n[other]\nnote=\'\'\'default_permissions="fake"\n[permissions.fake]\n\'\'\'\n',
  'default_permissions="source"\npermissions={source={extends=":workspace",unknown="keep"},}\n',
  'default_permissions="source"\npermissions={\n source={extends=":workspace"}, # keep parent comment\n}\n',
  '"default_permissions"="\\u0073ource"\n"permissions"."source"."network" = {enabled=true,unknown="keep"}\n',
  'default_permissions="source.with.dot"\npermissions={"source.with.dot"={extends=":workspace",workspace_roots=["keep"]}}\n',
  'default_permissions="source"\n[permissions.source.network] # empty network\n# preserve comment\n',
  'default_permissions="source"\npermissions={source.extends="parent",source.workspace_roots=["keep"]}\n',
  'default_permissions="source"\n[permissions.source]\nextends="parent"\n[unrelated]\nkeep=true\n',
];
const legacyForms = [
  'sandbox_mode="workspace-write"\n[sandbox_workspace_write]\nnetwork_access = true # keep bool comment\nwritable_roots=["/fixture"]\nexclude_tmpdir_env_var=true\nexclude_slash_tmp=true\n',
  '\uFEFFsandbox_mode=\'workspace-write\'\r\n"sandbox_workspace_write"."network_access" = true\r\nsandbox_workspace_write.writable_roots=["/fixture"]\r\n',
  'sandbox_mode="workspace-write"\nsandbox_workspace_write={network_access=true,writable_roots=["/fixture"],other={opaque=42}}\n',
  '[sandbox_workspace_write]\nnetwork_access=true\n',
];
const enableForms = [
  'sandbox_mode="danger-full-access"\n',
  '"sandbox_mode" = \'danger-full-access\' # keep\n[other]\nkeep=true\n',
  'sandbox_mode="danger-full-access"\nsandbox_workspace_write={}\n',
  'sandbox_mode="danger-full-access"\nsandbox_workspace_write={writable_roots=["/fixture"],exclude_tmpdir_env_var=true}\n',
  'sandbox_mode="danger-full-access"\nsandbox_workspace_write.writable_roots=["/fixture"]\n[other]\nkeep=42\n',
  'sandbox_mode="danger-full-access"\n[sandbox_workspace_write] # keep\n# roots comment\nwritable_roots=["/fixture"]\n',
  'sandbox_mode="danger-full-access"\n[sandbox_workspace_write]\nnetwork_access=true\nexclude_slash_tmp=true\n',
  'sandbox_mode="danger-full-access"\nsandbox_workspace_write={network_access=false,unknown="preserve"}\n',
  'sandbox_mode="danger-full-access"\nsandbox_workspace_write={writable_roots=["keep"],}\n',
  'sandbox_mode="danger-full-access"\n[sandbox_workspace_write.other]\nunknown=42\n',
  '\uFEFFsandbox_mode="danger-full-access"\r\n["sandbox_workspace_write"] # table comment\r\n',
];

export { api, operationId, bytes, text, doc, profileForms, legacyForms, enableForms };
