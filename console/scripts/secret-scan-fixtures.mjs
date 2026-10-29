import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const adapter = fileURLToPath(new URL('../.local-engine/secret-scan-engine.js', import.meta.url));
export const real = {
  skip: existsSync(adapter) ? false : 'Run pnpm build:engine for real credential matcher tests',
};
export const KEY = 'sk_FAKEprojectStripe0123456789abcdef';
export const OPENAI = 'FAKEpcrd0123456789abcdefABCDEFXYZ';
export const AWS = 'FAKEawsSecretValue0123456789abcdefABCDEF';
export const STOPPED = 'FAKEstoppedCredential0123456789abcdef';
export const AT = '2026-10-22T00:00:00.000Z';
const scopeOptions = (root) => ({
  adapter,
  project: join(root, 'work'),
  userHome: join(root, 'home'),
  home: join(root, 'stroq'),
  environment: { PATH: '/nonexistent/test-only-bin' },
});
const roleOf = (content) =>
  typeof content === 'string' || content.some((block) => block.type === 'tool_result')
    ? 'user'
    : 'assistant';
export async function session(options, cwd, name, turns, stamp) {
  const dir = join(options.userHome, '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  const lines = turns.map((content) =>
    JSON.stringify({
      type: roleOf(content),
      sessionId: name,
      cwd,
      timestamp: AT,
      message: { role: roleOf(content), content },
    }),
  );
  await writeFile(path, `${lines.join('\n')}\n`);
  if (stamp) await utimes(path, stamp, stamp);
  return path;
}
export const call = (id, name, input, output, extra = {}) => [
  [{ type: 'tool_use', id, name, input }],
  [{ type: 'tool_result', tool_use_id: id, content: output, ...extra }],
];
export async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'stroq-secret-fixture-'));
  const options = scopeOptions(root);
  await mkdir(options.project, { recursive: true });
  await mkdir(join(options.userHome, '.aws'), { recursive: true });
  await writeFile(
    join(options.userHome, '.aws/credentials'),
    `[default]\naws_secret_access_key=${AWS}\n`,
  );
  await writeFile(
    join(options.project, '.env'),
    `STRIPE_SECRET_KEY=${KEY}\nOPENAI_API_KEY=${OPENAI}\nSTOPPED_SECRET=${STOPPED}\n`,
  );
  try {
    await run(options);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
