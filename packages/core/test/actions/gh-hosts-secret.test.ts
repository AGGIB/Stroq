import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { classifyTool } from '../../src/actions/classify-tool.js';

/**
 * The GitHub CLI keeps its OAuth token in `hosts.yml` when it is not in the OS keyring:
 * `~/.config/gh/hosts.yml` (the folder `GH_CONFIG_DIR` and `XDG_CONFIG_HOME` can move), and on
 * Windows `%AppData%\GitHub CLI\hosts.yml`. The classifier knew `.aws`, `.kube`, `.config/gcloud`
 * and a handful of dotfiles and not this one, so `cat ~/.config/gh/hosts.yml` carried no class
 * at all and stayed allowed in a tainted session.
 *
 * The file is named exactly. A file called `hosts.yml` elsewhere (an Ansible inventory), the
 * system `/etc/hosts` and the CLI's other files are not credentials.
 */
const cwd = '/home/dev/project';
const commandClasses = (command: string) => classifyCommand(command, cwd).classes;
const toolClasses = (tool: string, path: string) =>
  classifyTool(tool, { file_path: path }, cwd).classes;

describe('a command that names the GitHub CLI token file', () => {
  it.each([
    'cat ~/.config/gh/hosts.yml',
    'cat /home/dev/.config/gh/hosts.yml',
    'cat "$HOME/.config/gh/hosts.yml"',
    'grep oauth_token ~/.config/gh/hosts.yml',
    'cp ~/.config/gh/hosts.yml /tmp/x',
    'head -n 3 .config/gh/hosts.yml',
    'cat ~/.config/gh/hosts.yml.bak',
  ])('is fs.secrets: %s', (command) => {
    expect(commandClasses(command)).toContain('fs.secrets');
  });

  it.each([
    'cat .config\\gh\\hosts.yml',
    'Get-Content $env:USERPROFILE\\.config\\gh\\hosts.yml',
    'type "C:\\Users\\me\\AppData\\Roaming\\GitHub CLI\\hosts.yml"',
    'Get-Content "$env:APPDATA\\GitHub CLI\\hosts.yml"',
    'type "%AppData%\\GitHub CLI\\hosts.yml"',
    'cat /c/Users/me/AppData/Roaming/GitHub\\ CLI/hosts.yml',
    'cat "/c/Users/me/AppData/Roaming/GitHub CLI/hosts.yml"',
  ])('is fs.secrets when spelled the Windows way: %s', (command) => {
    expect(commandClasses(command)).toContain('fs.secrets');
  });

  it.each([
    'type "%appdata%\\github cli\\HOSTS.YML"',
    'cat ~/.CONFIG/GH/hosts.yml',
    'cat "/Users/me/AppData/Roaming/GITHUB CLI/hosts.yml"',
  ])('is fs.secrets whatever the case, as it is on a filesystem that folds it: %s', (command) => {
    expect(commandClasses(command)).toContain('fs.secrets');
  });

  it.each([
    'cat /etc/hosts',
    'cat hosts.yml',
    'cat ansible/hosts.yml',
    'cat inventory/hosts.yml',
    'cat ~/.config/gh/config.yml',
    'cat ~/.config/gh/state.yml',
    'cat ~/.config/ghx/hosts.yml',
    'cat ~/.config/gh-dash/hosts.yml',
    'cat ~/.config/ghost/hosts.yml',
    'cat ~/.config/gh/hosts.ymlx',
    'cat "GitHub CLI/readme.md"',
    'cat GitHub-CLI/hosts.yml',
    'cat ~/GitHub\\ CLI\\ notes/hosts.yml',
    'ls ~/.config/gh',
    'gh auth status',
    'echo "add a hosts.yml to the repo"',
  ])('is not a secret: %s', (command) => {
    expect(commandClasses(command)).not.toContain('fs.secrets');
  });
});

describe('a file tool pointed at the GitHub CLI token file', () => {
  const PATHS = [
    '/home/dev/.config/gh/hosts.yml',
    '/Users/me/.config/gh/hosts.yml',
    '.config/gh/hosts.yml',
    'C:\\Users\\me\\.config\\gh\\hosts.yml',
    'C:\\Users\\me\\AppData\\Roaming\\GitHub CLI\\hosts.yml',
    '/c/Users/me/AppData/Roaming/GitHub CLI/hosts.yml',
    '/home/dev/.config//gh/./hosts.yml',
    '/home/dev/project/../.config/gh/hosts.yml',
  ];

  for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'NotebookEdit']) {
    it.each(PATHS)(`${tool} of %s is fs.secrets`, (path) => {
      expect(toolClasses(tool, path)).toContain('fs.secrets');
    });
  }

  it('carries the secret-path signal, as every other credential path does', () => {
    const found = classifyTool('Read', { file_path: '/home/dev/.config/gh/hosts.yml' }, cwd);
    expect(found.signals).toContain('secret-path');
  });

  it('reaches an MCP file tool as well, whatever the tool is called', () => {
    const found = classifyTool(
      'mcp__fs__get_file',
      { path: '/home/dev/.config/gh/hosts.yml' },
      cwd,
    );
    expect(found.classes).toContain('fs.secrets');
  });

  it.each([
    '/etc/hosts',
    '/home/dev/project/hosts.yml',
    '/home/dev/project/ansible/hosts.yml',
    '/home/dev/.config/gh/config.yml',
    '/home/dev/.config/gh/state.yml',
    '/home/dev/.config/ghx/hosts.yml',
    '/home/dev/.config/gh-dash/hosts.yml',
    '/home/dev/project/gh/hosts.yml',
    '/home/dev/project/.config/hosts.yml',
    '/home/dev/.config/gh/hosts.yml.d/readme.md',
    '/home/dev/project/notes/GitHub CLI.md',
    'C:\\Users\\me\\AppData\\Roaming\\GitHub CLI\\config.yml',
    'C:\\Users\\me\\AppData\\Roaming\\GitHub CLI Notes\\hosts.yml',
  ])('Read of %s is not a secret', (path) => {
    expect(toolClasses('Read', path)).not.toContain('fs.secrets');
  });
});
