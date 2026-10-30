import { describe, expect, it } from 'vitest';
import { runsOn } from '../../src/actions/runs-on.js';

const bash = (command: string) => runsOn({ toolName: 'Bash', toolInput: { command } });
const powershell = (command: string) => runsOn({ toolName: 'PowerShell', toolInput: { command } });

describe('a call that may go on after it returns', () => {
  it('is a command sent to the background, a launcher, or text a shell rewrites first', () => {
    for (const command of [
      'sleep 60 &',
      'bash -c "sleep 60 &"',
      'nohup sleep 60',
      '/usr/bin/nohup sleep 60',
      '"setsid" sleep 60',
      'tmux new -d sleep 60',
      'pm2 start server.js',
      'docker run -d nginx',
      'docker run -itd nginx',
      'podman container run --detach nginx',
      'eval "$(ssh-agent -s)"',
      "bash -c $'sleep 60'",
      'diff <(ls a) <(ls b)',
      'curl -s "https://docs.example/a?x=1&y=2"',
      `echo ${'a'.repeat(70 * 1024)}`,
    ])
      expect(bash(command), command.slice(0, 60)).toBe(true);
    expect(runsOn({ toolName: 'Monitor', toolInput: { command: 'tail -f log' } })).toBe(true);
    expect(
      runsOn({ toolName: 'Bash', toolInput: { command: 'sleep 60', run_in_background: true } }),
    ).toBe(true);
    for (const command of ['Start-Job { sleep 60 }', 'saps notepad', 'npm start', 'x -AsJob'])
      expect(powershell(command), command).toBe(true);
  });

  it('is not a command whose ampersands only join or redirect, nor a plain one', () => {
    for (const command of [
      'git status',
      'npm test',
      'cd src && ls 2>&1 | head',
      'make &> build.log',
      'cmd |& tee out',
      'echo $(date)',
      'docker run --rm -it img',
      'a=$((1 + 2))',
    ])
      expect(bash(command), command).toBe(false);
    expect(powershell('Get-ChildItem')).toBe(false);
    expect(runsOn({ toolName: 'Write', toolInput: { file_path: 'a & b' } })).toBe(false);
  });

  it('reads hostile text in time that grows with its length', () => {
    const start = process.cpuUsage();
    for (const command of [
      `docker run ${' -' + 'd'.repeat(60_000)}1`,
      'docker run '.repeat(5_000),
      `docker${' '.repeat(60_000)}x`,
      `${'&&'.repeat(30_000)}`,
      `${'<>'.repeat(30_000)}`,
    ])
      bash(command);
    const used = process.cpuUsage(start);
    expect((used.user + used.system) / 1000).toBeLessThan(1_000);
  });
});
