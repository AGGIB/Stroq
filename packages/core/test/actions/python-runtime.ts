import { spawnSync } from 'node:child_process';

export interface ResolvedPython {
  readonly path: string;
  readonly version: string;
  readonly isApple: boolean;
}
export type PythonProbe = (executable: string) => {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

const probePython: PythonProbe = (executable) =>
  spawnSync(
    executable,
    [
      '-c',
      [
        'import sys',
        'apple = sys.platform == "darwin" and ("Apple" in sys.version or (sys.version_info[:2] == (3,9) and (sys.executable.startswith("/usr/bin/") or "/CommandLineTools/" in sys.executable or "/Xcode" in sys.executable)))',
        'print(f"{sys.executable}\\t{sys.version.split()[0]}\\t{int(sys.version_info >= (3,8))}\\t{int(apple)}")',
      ].join('; '),
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );

function readPython(executable: string, probe: PythonProbe): ResolvedPython {
  const result = probe(executable);
  if (result.error || result.status !== 0)
    throw new Error(
      `STROQ_PYTHON was set to "${executable}", but it could not be executed: ${result.error?.message ?? result.stderr?.trim() ?? `exit code ${result.status}`}`,
    );
  const [path, version, supported, apple] = (result.stdout ?? '').trim().split('\t');
  if (!path || !version || supported !== '1')
    throw new Error(
      `STROQ_PYTHON "${executable}" (${version ?? 'unknown version'}) requires Python >=3.8 with valid runtime metadata.`,
    );
  return { path, version, isApple: apple === '1' };
}

const unsupportedApple = (python: ResolvedPython): Error =>
  new Error(
    `Apple Python ${python.version} at ${python.path} is unsupported by the audit oracle: runtime cache reads are not program file reads. Install CPython 3.12 and set STROQ_PYTHON to its executable. No semantic checks were run.`,
  );

/** Never weaken the audit hook to make an unsupported system runtime pass. */
export function findPython(
  customOverride?: string,
  probe: PythonProbe = probePython,
  platform: NodeJS.Platform = process.platform,
): ResolvedPython | null {
  const override = customOverride ?? process.env['STROQ_PYTHON'];
  if (override !== undefined) {
    if (override.trim() === '')
      throw new Error(
        'STROQ_PYTHON is set to an empty string. Specify an executable name or absolute path for Python >=3.8.',
      );
    const python = readPython(override, probe);
    if (python.isApple) throw unsupportedApple(python);
    return python;
  }
  if (platform === 'win32') return null;
  let apple: ResolvedPython | undefined;
  for (const executable of [
    'python3',
    'python3.12',
    'python3.11',
    'python3.10',
    'python3.9',
    'python',
  ]) {
    let python;
    try {
      python = readPython(executable, probe);
    } catch {
      continue;
    }
    if (!python.isApple) return python;
    apple ??= python;
  }
  if (apple) throw unsupportedApple(apple);
  return null;
}
