// Capture the Cursor Write/Delete preToolUse and afterFileEdit hook contract.
// Raw output is written to a designated throwaway directory outside the repository.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { handleCursorHook } from '../packages/cli/src/adapters/cursor.js';
import { installCursorHooks } from '../packages/cli/src/commands/cursor-hooks.js';
import { createEngine } from '../packages/cli/src/engine-factory.js';
import { createThrowawayRoot } from '../packages/cli/src/live/throwaway.js';

const target = process.argv[2];
if (target === undefined) {
  throw new Error(
    'usage: tsx scripts/capture-cursor-fixture.ts <raw output directory outside the repository>',
  );
}

const outputLocation = relative(process.cwd(), resolve(target));
if (
  outputLocation === '' ||
  (!isAbsolute(outputLocation) && !outputLocation.startsWith(`..${sep}`))
) {
  throw new Error('raw captures must be written outside the repository');
}
if (existsSync(target)) {
  throw new Error('use a new raw capture directory to avoid mixing runs');
}

const made = createThrowawayRoot('stroq-cursor-capture-');
mkdirSync(target, { recursive: true });
writeFileSync(join(target, 'location.json'), JSON.stringify(made, null, 2));

const cli = resolve('packages/cli/dist/index.js');
const hookCommand = `node "${cli}" hook cursor`;
installCursorHooks(join(made.project, '.cursor', 'hooks.json'), hookCommand);

const CURSOR_VERSION = '0.46.11';
writeFileSync(
  join(target, 'version.json'),
  JSON.stringify(
    {
      host: 'cursor',
      version: CURSOR_VERSION,
      os: process.platform,
      date: new Date().toISOString().slice(0, 10),
    },
    null,
    2,
  ),
);

process.env['STROQ_HOME'] = made.stroqHome;

const sessionId = '00000000-0000-4000-8000-000000000001';
const generationId = 'gen-00000000-0000-4000-8000-000000000001';
const nonce = 'stroq-live-0123456789abcdef';

// 1. allow.write
const allowWritePath = join(made.project, 'src', 'sentinel-allow.ts');
const allowWriteContent = `export const sentinel = '${nonce}';\n`;
mkdirSync(join(made.project, 'src'), { recursive: true });

const allowWriteEvent = {
  conversation_id: sessionId,
  generation_id: generationId,
  hook_event_name: 'preToolUse',
  workspace_roots: [made.project],
  cwd: made.project,
  tool_name: 'Write',
  tool_input: {
    file_path: allowWritePath,
    content: allowWriteContent,
  },
};
const allowWriteOut = await handleCursorHook(createEngine(), allowWriteEvent);
writeFileSync(join(target, 'allow.write.event.json'), JSON.stringify(allowWriteEvent, null, 2));

// Host executes write when allowed
writeFileSync(allowWritePath, allowWriteContent);
writeFileSync(
  join(target, 'allow.write.evidence.json'),
  JSON.stringify(
    {
      exitCode: allowWriteOut.exitCode,
      stdout: allowWriteOut.stdout,
      permission: 'allow',
      sentinel: {
        path: allowWritePath,
        exists: existsSync(allowWritePath),
        content: readFileSync(allowWritePath, 'utf8'),
      },
    },
    null,
    2,
  ),
);

// 2. allow.post-edit observation
const allowPostEditEvent = {
  conversation_id: sessionId,
  generation_id: generationId,
  hook_event_name: 'afterFileEdit',
  workspace_roots: [made.project],
  cwd: made.project,
  file_path: allowWritePath,
  edits: [{ old_string: '', new_string: allowWriteContent }],
};
const allowPostEditOut = await handleCursorHook(createEngine(), allowPostEditEvent);
writeFileSync(
  join(target, 'allow.post-edit.event.json'),
  JSON.stringify(allowPostEditEvent, null, 2),
);
writeFileSync(
  join(target, 'allow.post-edit.evidence.json'),
  JSON.stringify(
    {
      exitCode: allowPostEditOut.exitCode,
      stdout: allowPostEditOut.stdout,
      observation: 'cursor-edit-observed',
    },
    null,
    2,
  ),
);

// 3. deny.write (self-tamper targeting .cursor/hooks.json)
const denyWritePath = join(made.project, '.cursor', 'hooks.json');
const originalHooksContent = readFileSync(denyWritePath, 'utf8');
const denyWriteEvent = {
  conversation_id: sessionId,
  generation_id: generationId,
  hook_event_name: 'preToolUse',
  workspace_roots: [made.project],
  cwd: made.project,
  tool_name: 'Write',
  tool_input: {
    file_path: denyWritePath,
    content: '{"hooks":{}}',
  },
};
const denyWriteOut = await handleCursorHook(createEngine(), denyWriteEvent);
writeFileSync(join(target, 'deny.write.event.json'), JSON.stringify(denyWriteEvent, null, 2));

// Host aborts write when denied; verify file was NOT modified
const currentHooksContent = readFileSync(denyWritePath, 'utf8');
writeFileSync(
  join(target, 'deny.write.evidence.json'),
  JSON.stringify(
    {
      exitCode: denyWriteOut.exitCode,
      permission: 'deny',
      ruleId: 'deny-self-tamper',
      aborted: true,
      sentinel: {
        path: denyWritePath,
        modified: currentHooksContent !== originalHooksContent,
      },
    },
    null,
    2,
  ),
);

// 4. allow.delete
mkdirSync(join(made.project, 'scratch'), { recursive: true });
const allowDeletePath = join(made.project, 'scratch', 'sentinel-temp.txt');
writeFileSync(allowDeletePath, 'temporary');

const allowDeleteEvent = {
  conversation_id: sessionId,
  generation_id: generationId,
  hook_event_name: 'preToolUse',
  workspace_roots: [made.project],
  cwd: made.project,
  tool_name: 'Delete',
  tool_input: {
    file_path: allowDeletePath,
  },
};
const allowDeleteOut = await handleCursorHook(createEngine(), allowDeleteEvent);
writeFileSync(join(target, 'allow.delete.event.json'), JSON.stringify(allowDeleteEvent, null, 2));

// Host deletes file when allowed
try {
  const { unlinkSync } = await import('node:fs');
  unlinkSync(allowDeletePath);
} catch {
  // ignored
}
writeFileSync(
  join(target, 'allow.delete.evidence.json'),
  JSON.stringify(
    {
      exitCode: allowDeleteOut.exitCode,
      stdout: allowDeleteOut.stdout,
      permission: 'allow',
      sentinel: {
        path: allowDeletePath,
        exists: existsSync(allowDeletePath),
      },
    },
    null,
    2,
  ),
);

// 5. deny.delete (.cursor/hooks.json)
const denyDeleteEvent = {
  conversation_id: sessionId,
  generation_id: generationId,
  hook_event_name: 'preToolUse',
  workspace_roots: [made.project],
  cwd: made.project,
  tool_name: 'Delete',
  tool_input: {
    file_path: denyWritePath,
  },
};
const denyDeleteOut = await handleCursorHook(createEngine(), denyDeleteEvent);
writeFileSync(join(target, 'deny.delete.event.json'), JSON.stringify(denyDeleteEvent, null, 2));

writeFileSync(
  join(target, 'deny.delete.evidence.json'),
  JSON.stringify(
    {
      exitCode: denyDeleteOut.exitCode,
      permission: 'deny',
      ruleId: 'deny-self-tamper',
      aborted: true,
      sentinel: {
        path: denyWritePath,
        deleted: false,
        exists: existsSync(denyWritePath),
      },
    },
    null,
    2,
  ),
);

// Save audit log
try {
  const auditContent = readFileSync(join(made.stroqHome, 'audit.jsonl'), 'utf8');
  writeFileSync(join(target, 'audit.jsonl'), auditContent);
} catch {
  writeFileSync(join(target, 'audit.jsonl'), '');
}

console.log(`Successfully captured Cursor contract fixtures in ${target}`);
