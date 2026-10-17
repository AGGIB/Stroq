import { SKILL_NAME } from '../install/names.js';
import { shellWord } from '../shell-word.js';

/** Kept separate from filesystem verification so unpinned hooks do not load Safe Install. */
export const MCP_PIN = /^sha256:[0-9a-f]{64}$/;

/**
 * What a pinned server is refused with when the folder for its verified copy cannot be written: fixed phrases.
 * Inside `stroq run --sandbox` the folder is denied on purpose (see `protectedState`), so a pinned server cannot
 * start there; the first phrase says so, the second is for a folder that cannot be written for another reason.
 */
export const PIN_SANDBOX_PHRASES = [
  'a pinned server cannot be prepared inside the sandbox; start the client outside `stroq run --sandbox` (run it without --sandbox)',
  'a pinned server cannot be prepared: the folder for its verified copy under the Stroq home cannot be written',
] as const;

/** What a wrapper that is not the one `add` confirmed is refused with: fixed phrases, safe to print. */
export const BIND = {
  passEnv: 'the --pass-env of the wrapper is not the one confirmed',
  startFile: 'the start file of the wrapper is not the one confirmed',
  commandLine: 'the command line of the wrapper is not the one confirmed',
  entry: 'the client config entry is not the one confirmed (env, cwd, command or another key)',
  incomparable: 'the command line of the wrapper cannot be compared with the one confirmed',
} as const;
export const BIND_PHRASES: readonly string[] = Object.values(BIND);

/** Characters that cannot be shown as they are: the controls, and what shows nothing or changes what is shown. */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const UNSHOWABLE_EACH = new RegExp(UNSHOWABLE.source, 'gu');
const NAME_UNITS = 64;

/**
 * The one command that confirms a changed wrapper again, with the real name of the server: what `init`, the proxy
 * and `doctor` tell a person to run. A name `add` could have written is a plain word. Any other name (a lock
 * written by hand) is quoted for a shell when it is short and can be shown, and otherwise it is shown cut and with
 * every control or invisible character written out, since a name in a lock or a config is not trusted text.
 */
export function reconfirmCommand(name: string): string {
  const tail = '--kind mcp --force';
  if (SKILL_NAME.test(name)) return `stroq add ${name} ${tail}`;
  if (name !== '' && name.length <= NAME_UNITS && !UNSHOWABLE.test(name))
    return `stroq add ${shellWord(name)} ${tail}`;
  const clipped = name.length > NAME_UNITS ? `${name.slice(0, NAME_UNITS)}...` : name;
  const shown = JSON.stringify(clipped).replace(
    UNSHOWABLE_EACH,
    (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`,
  );
  return `stroq add ${shown} ${tail}`;
}
