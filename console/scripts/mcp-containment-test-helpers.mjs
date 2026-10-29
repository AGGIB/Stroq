import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stableStringify } from '../../packages/core/dist/index.js';
import { createMcpContainmentService } from './mcp-containment.mjs';

export async function fixture(t, options = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-mcp-containment-')));
  const project = join(dir, 'project'),
    userHome = join(dir, 'user');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  const services = [];
  const service = (extra = {}) => {
    const instance = createMcpContainmentService({
      project,
      userHome,
      platform: 'darwin',
      runtimeDigest: async () => 'a'.repeat(64),
      ...options,
      ...extra,
    });
    services.push(instance);
    return instance;
  };
  const containment = service();
  t.after(async () => {
    for (const instance of services) await instance.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, project, userHome, containment, service };
}
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const item = (entry, agent = 'claude-code', scope = 'project', name = 'notes') => ({
  id: `item-${digest(`mcp\0${agent}\0${scope}\0${name}`).slice(0, 24)}`,
  expectedSha256: digest(stableStringify(entry)),
});
export async function config(
  f,
  {
    agent = 'claude-code',
    scope = 'project',
    name = 'notes',
    entry = { command: '/do-not-execute-stroq-mcp', args: [] },
    doc,
    text,
  } = {},
) {
  const root = scope === 'project' ? f.project : f.userHome;
  const file =
    agent === 'claude-code'
      ? join(root, '.mcp.json')
      : agent === 'cursor'
        ? join(root, '.cursor', 'mcp.json')
        : agent === 'windsurf'
          ? join(root, '.codeium', 'mcp_config.json')
          : join(root, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(
    text ?? `${JSON.stringify(doc ?? { mcpServers: { [name]: entry } }, null, 2)}\n`,
  );
  await writeFile(file, bytes, { mode: 0o600 });
  return { file, bytes, entry, ...item(entry, agent, scope, name) };
}
export const preview = (service, installed) =>
  service.preview({
    action: 'remove-registration',
    id: installed.id,
    expectedSha256: installed.expectedSha256,
  });
export const apply = (service, plan) =>
  service.apply({
    previewId: plan.id,
    confirm: true,
    acknowledgeSessionLimits: true,
    acknowledgePrivateRetention: true,
  });
export const vault = (f, id) => join(f.userHome, '.stroq', 'console', 'mcp-containment', id);
