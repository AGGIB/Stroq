import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../../src/actions/classify-bash.js';
import { splitCommand } from '../../src/actions/shell-segments.js';

const cwd = '/home/dev/project';
const classesOf = (command: string) => classifyCommand(command, cwd).classes;
const destructive = (command: string) => classesOf(command).includes('shell.destructive');
const signalsOf = (command: string) => classifyCommand(command, cwd).signals;

describe('which host and which command an ssh invocation has', () => {
  it.each([
    'ssh -tp 22 prod "rm -rf /srv/app"',
    'ssh -Ai key prod "rm -rf /srv/app"',
    'ssh -p22 prod "rm -rf /srv/app"',
    'ssh -o "ServerAliveInterval 5" prod "rm -rf /srv/app"',
    "ssh -o 'A b' -p 22 deploy@prod.example.com 'rm -rf /srv/app'",
    'ssh -oStrictHostKeyChecking=no prod "rm -rf /srv/app"',
    'ssh -vvv -4 prod "rm -rf /srv/app"',
    'ssh -- prod "rm -rf /srv/app"',
    'sshpass -p secret ssh prod "docker rmi old-image"',
    'sshpass -f pw ssh -o StrictHostKeyChecking=no prod docker volume rm data',
  ])('reads the remote command of %s', (command) => {
    expect(destructive(command)).toBe(true);
  });

  it('does not take an option value for the host, or the host for part of the command', () => {
    expect(destructive('ssh -p 22 prod "docker ps"')).toBe(false);
    expect(destructive('ssh -i ~/.ssh/key prod uptime')).toBe(false);
    expect(destructive('ssh -N -L 8080:localhost:80 prod')).toBe(false);
    expect(destructive('ssh -tp 22 prod')).toBe(false);
  });
});

describe('a recursive rm on a server', () => {
  it.each([
    'ssh prod "rm -rf /tmp/../var/www"',
    'ssh prod "rm -rf /tmp/./../etc"',
    'ssh prod "cd /var && rm -rf www"',
    'ssh prod "cd /var; rm -r www"',
    'ssh prod "cd ~/app && rm -rf data"',
    'ssh prod "rm -rf *"',
    'ssh prod "cd /srv && rm -rf ./*"',
    'ssh prod "rm -rf ~/app"',
    'ssh prod "rm -rf /var/www"',
  ])('asks about %s', (command) => {
    expect(destructive(command)).toBe(true);
  });

  it.each([
    'ssh prod "rm -rf /tmp/build"',
    'ssh prod "rm -rf /var/tmp/build"',
    'ssh prod "cd /tmp/work && rm -rf build"',
    'ssh prod "cd /tmp/work && cd sub && rm -rf out"',
    'ssh prod "cd app && rm -rf build"',
    'ssh prod "rm -rf build"',
    'ssh prod "rm -f /srv/app/old.log"',
  ])('leaves %s alone', (command) => {
    expect(destructive(command)).toBe(false);
  });
});

describe('an ssh command too large to read to its end', () => {
  it('is reported as unread, not as nothing', () => {
    const huge = `ssh prod "echo ${'x'.repeat(40 * 1024)} && docker rmi y"`;
    const found = classifyCommand(huge, cwd);
    expect(found.classes).toContain('shell.unparsed');
    expect(found.signals).toContain('ssh-remote:too-large');
  });

  it('is reported when a command names more ssh invocations than are read', () => {
    const many = Array.from({ length: 20 }, () => 'ssh a uptime').join('; ');
    const found = classifyCommand(many, cwd);
    expect(found.classes).toContain('shell.unparsed');
  });

  it('is silent about an ordinary one', () => {
    expect(classesOf('ssh prod uptime')).not.toContain('shell.unparsed');
    expect(classesOf(Array.from({ length: 16 }, () => 'ssh a uptime').join('; '))).not.toContain(
      'shell.unparsed',
    );
  });
});

describe('a delete with global options before the verb', () => {
  it.each([
    'kubectl -n prod delete statefulset db',
    'kubectl --context prod delete deployments --all',
    'kubectl delete deploy web',
    'kubectl delete sts db',
    'kubectl delete persistentvolumeclaim data',
    'kubectl --kubeconfig ~/.kube/prod delete namespace shop',
    'aws --profile prod s3 rm s3://bucket --recursive',
    'aws --region eu-west-1 --profile p s3 sync ./a s3://bucket --delete',
    'aws --profile p ec2 terminate-instances --instance-ids i-1',
    'gcloud --project=prod compute instances delete vm-1',
    'gcloud --quiet --project prod storage rm gs://bucket/x',
    'helm --kube-context prod uninstall release',
    'helm -n prod delete release',
    'firebase --project prod hosting:disable',
    'firebase --token t --project p firestore:delete --all-collections',
    'az --subscription s group delete --name rg',
    'rsync -a --del ./site/ deploy@prod.example.com:/var/www/',
    'rsync -a --delete-after ./site/ deploy@prod.example.com:/var/www/',
    'rsync -a --delete-excluded ./site/ prod:/var/www/',
  ])('asks about %s', (command) => {
    expect(destructive(command)).toBe(true);
  });

  it.each([
    'kubectl -n prod get pods',
    'kubectl -n prod delete pod web-1',
    'kubectl --context prod apply -f x.yaml',
    'aws --profile prod s3 ls',
    'aws --profile prod s3 cp a s3://bucket/a',
    'aws s3api list-objects --prefix remove-old',
    'gcloud --project=prod compute instances list',
    'gcloud compute instances describe delete-me-vm',
    'helm --kube-context prod install release chart',
    'firebase --project p deploy --only hosting',
    'az --subscription s vm list',
    'rsync -a --delete ./a/ ./b/',
    'rsync -a --delimiter x ./a/ prod:/b/',
  ])('leaves %s alone', (command) => {
    expect(destructive(command)).toBe(false);
  });
});

describe('a trap body', () => {
  it.each([
    String.raw`trap -- 'rm -rf "$HOME"' EXIT`,
    String.raw`trap "rm -rf \"\$HOME\"" EXIT`,
    String.raw`trap "rm -rf ~" EXIT INT TERM`,
    "trap 'rm -rf ~' EXIT",
    'trap rm -rf ~ EXIT',
    String.raw`trap -- "rm -rf ~" EXIT`,
  ])('is read as a command: %s', (command) => {
    expect(destructive(command)).toBe(true);
  });

  it.each([
    "trap 'echo done' EXIT",
    'trap - EXIT',
    'trap -- - INT',
    String.raw`trap "echo \"bye\"" EXIT`,
    "trap 'cleanup' EXIT",
  ])('leaves %s alone', (command) => {
    expect(destructive(command)).toBe(false);
  });

  it('reads every trap of a command, up to a limit, and does not hang on a quote that never closes', () => {
    const many = Array.from({ length: 300 }, () => "trap 'echo x' EXIT").join('\n');
    expect(() => splitCommand(many)).not.toThrow();
    expect(() => splitCommand(`trap "${'\\'.repeat(60_000)}`)).not.toThrow();
    const found = splitCommand(`trap "echo a" EXIT\ntrap 'rm -rf ~' EXIT`);
    expect(found.segments.some((segment) => segment.includes('rm -rf ~'))).toBe(true);
  });
});

describe('signals name what was found', () => {
  it('names the remote command, and the script that carried a danger', () => {
    expect(signalsOf('ssh prod "docker rmi x"').some((s) => s.startsWith('ssh-remote:'))).toBe(
      true,
    );
  });
});
