export interface TaskArgs {
  readonly profile: 'repo-edit-and-test';
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly ttlMs: number;
  readonly hookOnly: boolean;
  readonly task: string;
}

export function parseTaskArgv(argv: readonly string[]): TaskArgs {
  const separator = argv.indexOf('--');
  if (separator < 0 || argv.length !== separator + 2 || !argv[separator + 1]?.trim())
    throw new Error('task needs exactly one task description after --');
  let ttlMs = 30 * 60_000;
  let hookOnly = false;
  const read: string[] = [];
  const write: string[] = [];
  for (let i = 0; i < separator; i += 1) {
    const flag = argv[i];
    if (flag === '--hook-only') {
      hookOnly = true;
      continue;
    }
    if (!['--profile', '--read', '--write', '--ttl'].includes(flag ?? ''))
      throw new Error(`unknown task option: ${flag}`);
    const value = argv[++i];
    if (!value || i >= separator || value.startsWith('--'))
      throw new Error(`${flag} needs a value`);
    if (flag === '--profile' && value !== 'repo-edit-and-test')
      throw new Error('unknown task profile');
    if (flag === '--read') read.push(value);
    if (flag === '--write') write.push(value);
    if (flag === '--ttl') ttlMs = parseTtl(value);
  }
  return {
    profile: 'repo-edit-and-test',
    read,
    write,
    ttlMs,
    hookOnly,
    task: argv[separator + 1] as string,
  };
}

function parseTtl(value: string): number {
  const match = /^(\d+)(m|h)$/.exec(value);
  const ttl = match === null ? NaN : Number(match[1]) * (match[2] === 'h' ? 3_600_000 : 60_000);
  if (!(ttl > 0 && ttl <= 86_400_000)) throw new Error('--ttl must be 1m to 24h');
  return ttl;
}
