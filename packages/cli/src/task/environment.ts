/** A fresh HOME must not carry a second host config, proxy, loader or unrelated credential in env. */
export function taskEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TERM',
    'COLORTERM',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'NO_COLOR',
    'FORCE_COLOR',
    'WT_SESSION',
    'TERM_PROGRAM',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ]);
  return Object.fromEntries(
    Object.entries(env)
      .filter(([name]) => safe.has(name.toUpperCase()))
      .map(([name, value]) => [name.toUpperCase(), value]),
  );
}
