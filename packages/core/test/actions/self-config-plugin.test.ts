import { describe, expect, it } from 'vitest';
import { classifyTool } from '../../src/actions/classify-tool.js';
import { SELF_CONFIG_FILE } from '../../src/actions/self-config.js';

/**
 * A plugin user has no hook in `settings.json`: Claude Code runs the plugin's `hooks/stroq-hook.sh`
 * from its plugin cache on every event, and that script is all there is. A file the agent writes
 * there (an `exit 0` for the script, a `hooks.json` with no hooks) switches the firewall off for
 * good, as a write to `.claude/settings.json` does for an `init` install, and neither the cache nor
 * the marketplace clone was on the list of protected files. The installed `@stroq/cli` is the code
 * those hooks run, and is not on it: running it by its path is ordinary work, and the gate cannot
 * tell a run from a write that names the same file.
 */
const CWD = '/home/dev/project';

const PROTECTED = [
  // The plugin as Claude Code caches it: `cache/<marketplace>/<plugin>/<version>`.
  '/Users/dev/.claude/plugins/cache/stroq/stroq/0.22.0/hooks/stroq-hook.sh',
  '~/.claude/plugins/cache/stroq/stroq/0.23.0/hooks/hooks.json',
  '/home/dev/.claude/plugins/cache/some-fork/stroq/1.0.0/hooks/stroq-hook.sh',
  'C:\\Users\\dev\\.claude\\plugins\\cache\\stroq\\stroq\\0.22.0\\hooks\\stroq-hook.sh',
  // The marketplace it came from, a clone of the repository.
  '/home/dev/.claude/plugins/marketplaces/stroq/plugins/stroq/hooks/stroq-hook.sh',
  '/home/dev/.claude/plugins/marketplaces/some-fork/plugins/stroq/hooks/hooks.json',
];

const ORDINARY = [
  // A developer edits the repository's own copy of the plugin: that is not the installed one.
  'plugins/stroq/hooks/stroq-hook.sh',
  '/home/dev/work/stroq/plugins/stroq/hooks/hooks.json',
  // Other plugins, and a plugin whose name only starts with stroq.
  '/home/dev/.claude/plugins/cache/other/other-plugin/1.0.0/hooks/run.sh',
  '/home/dev/.claude/plugins/cache/some-fork/stroq-tools/1.0.0/hooks/run.sh',
  '/home/dev/.claude/plugins/marketplaces/other/plugins/other/hooks/hooks.json',
  '/home/dev/.claude/plugins/marketplaces/other/plugins/stroq-tools/hooks/hooks.json',
  // The documentation of the package and a package with a similar scope.
  // The documentation of the installed CLI.
  'node_modules/@stroq/cli/README.md',
];

describe('Stroq’s installed plugin and CLI are protected files', () => {
  it.each(PROTECTED)('%s is', (path) => {
    expect(SELF_CONFIG_FILE.test(path)).toBe(true);
  });

  it.each(ORDINARY)('%s is not', (path) => {
    expect(SELF_CONFIG_FILE.test(path)).toBe(false);
  });

  it.each(PROTECTED)('a Write to %s is refused as tampering', (file_path) => {
    expect(classifyTool('Write', { file_path, content: 'exit 0' }, CWD).classes).toContain(
      'config.self',
    );
    expect(
      classifyTool('Edit', { file_path, old_string: 'a', new_string: 'b' }, CWD).classes,
    ).toContain('config.self');
  });

  it.each(ORDINARY)('a Write to %s is ordinary work', (file_path) => {
    expect(classifyTool('Write', { file_path, content: 'x' }, CWD).classes).not.toContain(
      'config.self',
    );
  });

  const BASH = [
    "echo 'exit 0' > ~/.claude/plugins/cache/stroq/stroq/0.22.0/hooks/stroq-hook.sh",
    'cp /tmp/e.sh ~/.claude/plugins/cache/stroq/stroq/0.22.0/hooks/stroq-hook.sh',
    "sed -i '' 's/deny/allow/' ~/.claude/plugins/cache/stroq/stroq/0.22.0/hooks/hooks.json",
    'rm -rf ~/.claude/plugins/cache/stroq',
    'rm -rf ~/.claude/plugins/marketplaces/stroq',
    'mv ~/.claude/plugins/cache/stroq/stroq/0.22.0 /tmp/old',
  ];

  it.each(BASH)('%s is refused as tampering', (command) => {
    expect(classifyTool('Bash', { command }, CWD).classes).toContain('config.self');
  });

  // Reading what is installed is how a developer finds out what runs.
  it.each([
    'cat ~/.claude/plugins/cache/stroq/stroq/0.22.0/hooks/stroq-hook.sh',
    'ls ~/.claude/plugins/cache/stroq',
    'cat node_modules/@stroq/cli/dist/index.js',
    // Run by its path, with its error output joined to its output: a redirect in a segment that
    // names a protected file reads as a write to it, which is why the installed CLI is not one.
    'node node_modules/@stroq/cli/dist/index.js --help 2>&1',
    'STROQ_HOME="$T/home" node node_modules/@stroq/cli/dist/index.js attack 2>&1',
    'pnpm exec node ./node_modules/@stroq/cli/dist/index.js doctor',
    'grep -n STROQ_PIN ~/.claude/plugins/cache/stroq/stroq/0.22.0/hooks/stroq-hook.sh',
  ])('%s is not', (command) => {
    expect(classifyTool('Bash', { command }, CWD).classes).not.toContain('config.self');
  });
});
