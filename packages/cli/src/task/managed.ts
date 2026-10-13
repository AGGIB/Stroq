import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { release, userInfo } from 'node:os';
import { join } from 'node:path';

interface ManagedHost {
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => boolean;
  readonly registry?: () => boolean;
  readonly username?: () => string;
  readonly wsl?: () => boolean;
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Managed sources outrank --settings, so this release declines locally managed hosts. */
export function hasManagedTaskPolicy(host: ManagedHost = {}): boolean {
  const platform = host.platform ?? process.platform;
  // Claude may also read Windows policy sources under WSL. Until that precedence and
  // registry access are validated, do not claim that our local file probe covers WSL.
  if (platform === 'linux' && (host.wsl ?? (() => /microsoft/i.test(release())))()) return true;
  const base =
    platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode'
      : platform === 'win32'
        ? 'C:/Program Files/ClaudeCode'
        : '/etc/claude-code';
  const paths = ['managed-settings.json', 'managed-settings.d', 'managed-mcp.json'].map(
    (name) => `${base}/${name}`,
  );
  if (platform === 'darwin') {
    paths.push('/Library/Managed Preferences/com.anthropic.claudecode.plist');
    try {
      const username = (host.username ?? (() => userInfo().username))();
      if (!username || username === '.' || username === '..' || /[\/\\\0]/.test(username))
        return true;
      paths.push(`/Library/Managed Preferences/${username}/com.anthropic.claudecode.plist`);
    } catch {
      return true;
    }
  }
  if (paths.some(host.exists ?? present)) return true;
  if (platform !== 'win32') return false;
  try {
    return (host.registry ?? windowsRegistryPolicy)();
  } catch {
    return true;
  }
}

function windowsRegistryPolicy(): boolean {
  const exe = join(
    process.env['SystemRoot'] ?? 'C:/Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  const script =
    "try { foreach ($h in @([Microsoft.Win32.Registry]::LocalMachine, [Microsoft.Win32.Registry]::CurrentUser)) { $k = $h.OpenSubKey('SOFTWARE\\Policies\\ClaudeCode'); if ($null -ne $k) { try { if ($k.GetValueNames() -contains 'Settings') { exit 1 } } finally { $k.Dispose() } } }; exit 0 } catch { exit 2 }";
  const result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 5_000,
  });
  return result.status !== 0;
}
