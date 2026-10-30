import type { PreToolEvent } from '../types.js';
import { lex } from './shell-lex.js';

/**
 * A lone `&` anywhere in a command, quoted or not (`bash -c "x &"` sends its part to the background
 * too): not `&&`, `>&`, `<&`, `|&` or `&>`. A `&` in a quoted URL is read as one as well.
 */
const LONE_AMPERSAND = /(?<![&|<>])&(?![&>])/;
/**
 * Programs that start what they run apart from the command that started them, written plainly, by
 * path or quoted (`/usr/bin/nohup`, `"setsid"`); and text a shell rewrites before it is read
 * (`eval`, `$'…'`) or runs beside the command (`<(…)`, `>(…)`).
 */
const LAUNCHERS =
  /(?:^|[\s;|&(`$/'"\\])(?:nohup|setsid|disown|coproc|screen|tmux|systemd-run|daemonize|daemon|start-stop-daemon|launchctl|pm2|eval)\b|\$'|[<>]\(/;
/** A container started apart from the command: `docker run -d`, `podman start --detach`, `-itd`. */
const CONTAINER_START = /\b(?:docker|podman)\s+(?:container\s+)?(?:run|start)\b/;
/** `--detach`, or a cluster of short options with a `d` in it; read word by word, so it stays linear. */
const detached = (command: string): boolean =>
  /\s--detach\b/.test(command) ||
  command.split(/\s+/).some((word) => /^-[A-Za-z]+$/.test(word) && word.includes('d'));
/** The longest command read for a part that may run on; a longer one is taken to. */
const MAX_BACKGROUND_READ = 64 * 1024;
/** PowerShell's ways to go on in the background, its aliases among them; any `&`, as above. */
const POWERSHELL_BACKGROUND =
  /&|\b(?:Start-\w+|sajb|saps|start|Register-\w*Event|BeginInvoke|Invoke-Command)\b|::Start\s*\(|-AsJob\b/i;

/**
 * Whether a call may go on running after it returns: `Monitor`, a command run in the background, one
 * whose text holds a lone `&`, a launcher (`nohup`, `setsid`, `tmux` …), or that cannot be read. Its
 * report does not say it ended. A process a program starts by itself (Python's `Popen`) is past what
 * this reads; what keeps such a process from answering for you is that running Stroq's hook or
 * writing under `~/.stroq` is denied.
 */
export function runsOn(event: Pick<PreToolEvent, 'toolName' | 'toolInput'>): boolean {
  if (event.toolName === 'Monitor' || event.toolInput['run_in_background'] === true) return true;
  const command = event.toolInput['command'];
  if (typeof command !== 'string') return false;
  if (event.toolName === 'PowerShell') return POWERSHELL_BACKGROUND.test(command);
  if (event.toolName !== 'Bash') return false;
  if (command.length > MAX_BACKGROUND_READ) return true;
  if (LONE_AMPERSAND.test(command) || LAUNCHERS.test(command)) return true;
  if (CONTAINER_START.test(command) && detached(command)) return true;
  return command.includes('&') && lex(command).uncertain;
}
