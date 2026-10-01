import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { splitCommand } from '../../src/actions/shell-segments.js';

const cwd = '/home/dev/project';
const classesOf = (command: string) => classifyCommand(command, cwd).classes;
const destructive = (command: string) => classesOf(command).includes('shell.destructive');

describe('deletes on hosting, storage and clusters', () => {
  it.each([
    'firebase hosting:disable --force',
    'firebase hosting:channel:delete preview',
    'firebase projects:delete my-proj',
    'firebase firestore:delete --all-collections',
    'gcloud compute instances delete vm-1',
    'gcloud storage rm -r gs://bucket',
    'gsutil -m rm -r gs://bucket/**',
    'gsutil rb gs://bucket',
    'aws s3 rm s3://bucket --recursive',
    'aws s3 rb s3://bucket --force',
    'aws s3 sync ./dist s3://bucket --delete',
    'aws ec2 terminate-instances --instance-ids i-1',
    'aws rds delete-db-instance --db-instance-identifier x',
    'az group delete --name rg',
    'az vm delete -g rg -n vm',
    'kubectl delete ns production',
    'kubectl delete pvc data -n prod',
    'kubectl delete deployment web',
    'kubectl delete pods --all',
    'kubectl delete pod x -A',
    'heroku apps:destroy my-app',
    'netlify sites:delete 123',
    'vercel rm my-project',
    'helm uninstall release',
    'fly apps destroy my-app',
    'flyctl volumes destroy vol_1',
    'docker system prune -af --volumes',
    'docker volume rm data',
    'gh api -X DELETE repos/o/r/git/refs/heads/main',
    'gh api --method=DELETE /repos/o/r',
    'npm unpublish pkg@1.0.0',
    'gh release delete v1.0.0',
    'lftp -e "mirror --delete -R . /www" ftp://host',
    'rsync -a --delete ./site/ deploy@prod.example.com:/var/www/',
    'git filter-branch --force HEAD',
    'git filter-repo --path secrets',
    'git reflog expire --expire=now --all',
    'git gc --prune=now',
  ])('%s', (command) => {
    expect(destructive(command)).toBe(true);
  });

  it.each([
    'firebase deploy --only hosting',
    'firebase login',
    'gcloud compute instances list',
    'gcloud auth login',
    'gsutil cp a gs://bucket/a',
    'aws s3 ls',
    'aws s3 cp a s3://bucket/a',
    'aws s3 sync ./dist s3://bucket',
    'aws ec2 describe-instances',
    'az vm list',
    'kubectl get pods',
    'kubectl delete pod web-1',
    'kubectl apply -f x.yaml',
    'helm install release chart',
    'docker ps',
    'docker build .',
    'docker volume ls',
    'docker system prune -f',
    'docker system prune -af',
    'gcloud compute instances describe delete-me-vm',
    'gcloud config set project rm-prod',
    'az vm show -n delete-me-vm -g rg',
    'gh api repos/o/r',
    'gh api -X POST repos/o/r/issues',
    'npm publish',
    'gh release create v1',
    'git push --delete origin old-branch',
    'git push origin :old-branch',
    'git gc',
    'git reflog',
    'rsync -a ./site/ deploy@prod.example.com:/var/www/',
    'rsync -a --delete ./a/ ./b/',
  ])('leaves %s alone', (command) => {
    expect(destructive(command)).toBe(false);
  });
});

describe('a command run on another machine over ssh', () => {
  it.each([
    'ssh deploy@prod.example.com "docker rmi $(docker images -q)"',
    "ssh prod 'docker system prune -af'",
    'ssh prod docker volume rm data',
    'ssh prod "docker compose down -v"',
    'ssh -i key -p 2222 prod.example.com "rm -rf /var/www"',
    'ssh prod "rm -rf ~/app"',
    'ssh prod "cd /srv && rm -rf ."',
    'ssh prod "mkfs.ext4 /dev/sdb"',
  ])('%s is asked about', (command) => {
    expect(destructive(command)).toBe(true);
  });

  it('reads a remote command whose quotes hold a pipe, which the local shell does not see as one', () => {
    const decoded = classesOf('ssh prod "echo aWQ= | base64 -d | bash"');
    expect(decoded).toContain('shell.exec_encoded');
    expect(classesOf("ssh -p 22 deploy@prod.example.com 'echo aWQ= | base64 -d | sh'")).toContain(
      'shell.exec_encoded',
    );
    expect(destructive('ssh prod "ls | wc -l; docker rmi x"')).toBe(true);
  });

  it('stops the remote command at the next local operator when it is not quoted', () => {
    expect(destructive('ssh prod docker rmi x | tee log')).toBe(true);
    // After the `&&` it runs here, where removing an image is routine.
    expect(destructive('ssh prod uptime && docker rmi x')).toBe(false);
    expect(destructive('ssh prod uptime; echo done')).toBe(false);
  });

  it('reads an ssh that sits in a nested command, and several in one line', () => {
    expect(destructive('bash -c "ssh prod docker volume rm data"')).toBe(true);
    expect(destructive('ssh a uptime; ssh b "docker system prune -af"')).toBe(true);
    expect(destructive('echo $(ssh prod "docker rmi x")')).toBe(true);
  });

  it('keeps reading past an escaped quote inside the remote command', () => {
    expect(destructive('ssh prod "echo \\"x\\"; docker rmi y"')).toBe(true);
    expect(destructive('ssh prod "echo \\"unterminated')).toBe(false);
  });

  it('names the remote command in the signal', () => {
    const { signals } = classifyCommand('ssh prod "docker rmi x"', cwd);
    expect(signals.some((s) => s.startsWith('ssh-remote:'))).toBe(true);
  });

  it.each([
    'ssh prod "docker ps"',
    'ssh prod "docker stop web"',
    'ssh prod "systemctl restart web"',
    'ssh prod "rm -f /tmp/x"',
    'ssh prod "rm -rf /tmp/build"',
    'ssh prod "rm file.txt"',
    'ssh prod "cat /etc/hosts > /dev/null"',
    'ssh prod "ls -la"',
    'ssh -o StrictHostKeyChecking=no prod "uptime"',
    'ssh prod',
    'ssh -N -L 8080:localhost:80 prod',
    'ssh-keygen -t ed25519',
  ])('leaves %s alone', (command) => {
    expect(destructive(command)).toBe(false);
  });

  it('does not recurse without bound through an ssh inside an ssh', () => {
    let command = 'docker rmi x';
    for (let i = 0; i < 6; i += 1) command = `ssh prod '${command.replace(/'/g, '"')}'`;
    expect(() => classifyCommand(command, cwd)).not.toThrow();
  });
});

describe('git writing a file named by an option', () => {
  it('counts --output as a write, because it leaves a git config behind (GitPwned)', () => {
    expect(classesOf('git show HEAD:payload --output=.git/config')).toContain('config.git_exec');
    expect(classesOf('git diff --output .alt/config')).not.toContain('shell.destructive');
  });

  it('counts -o as an output only for archive and format-patch', () => {
    expect(classesOf('git archive -o .git/config HEAD')).toContain('config.git_exec');
    expect(classesOf('git format-patch -o .git/hooks HEAD~1')).toContain('config.git_exec');
    expect(classesOf('git commit -o .claude/settings.json -m x')).not.toContain('config.self');
    expect(classesOf('git push -o merge_request.create origin main')).not.toContain(
      'config.git_exec',
    );
  });

  it('leaves a plain git show alone', () => {
    expect(classesOf('git show HEAD:README.md')).toEqual([]);
  });
});

describe('a command held in a trap or in a Windows shell string', () => {
  it('reads the body of a trap as a command of its own', () => {
    expect(destructive("trap 'rm -rf ~' EXIT")).toBe(true);
    expect(destructive('trap "rm -rf $HOME" EXIT INT')).toBe(true);
    expect(destructive("trap 'echo done' EXIT")).toBe(false);
    expect(destructive('trap - EXIT')).toBe(false);
  });

  it('reads cmd /c and powershell -Command bodies', () => {
    expect(destructive('cmd /c "rmdir /s /q C:\\"')).toBe(true);
    expect(destructive('cmd /c "rmdir /s /q C:\\" && echo done')).toBe(true);
    expect(destructive('cmd.exe /c "del /f /s /q C:\\Users"')).toBe(true);
    expect(destructive('powershell -Command "Remove-Item -Recurse -Force C:\\"')).toBe(true);
    expect(destructive('pwsh -Command "git clean -xdff"')).toBe(true);
    expect(destructive('cmd /c "echo hi"')).toBe(false);
    expect(destructive('powershell -Command "Get-ChildItem"')).toBe(false);
  });

  it('honours a backslash-escaped quote inside the Windows string', () => {
    const { segments } = splitCommand(
      'powershell -Command "Write-Host \\"hi\\"; Remove-Item -Recurse C:\\"',
    );
    expect(segments.some((s) => /Remove-Item/.test(s))).toBe(true);
  });

  it('stays quiet about a trap with no body', () => {
    expect(() => splitCommand('trap')).not.toThrow();
    expect(() => splitCommand('trap ')).not.toThrow();
  });
});
