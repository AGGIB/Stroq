/**
 * `eval "$(ssh-agent -s)"` and its kind: a tool that prints the shell code that sets it up, which
 * the shell then runs. `eval` of something a command makes is what a reader has to ask about, since
 * the command may be `curl`, and a file that was made to be run is a program nobody here can read.
 * These are the tools whose output is meant to be evaluated, called with the words that ask for it:
 * `ssh-agent -s`, `pyenv init -`, `brew shellenv`, `direnv hook zsh`. The command is the one tool
 * with plain arguments and nothing else: no second command, no expansion, no quote.
 *
 * It trusts the tool by its name, as every other reading here does: a planted `ssh-agent` is a
 * command that was put where the real one is, which is a question about the machine and not about
 * this line.
 */

/** What each tool may be called with, as the words after its name joined by a space. */
const INIT_TOOLS: Readonly<Record<string, RegExp>> = {
  'ssh-agent': /^(?:-[scDk]|-t \d+)?(?: (?:-[scDk]|-t \d+))*$/,
  'gpg-agent': /^--daemon$/,
  'dbus-launch': /^--(?:sh|csh)-syntax(?: --exit-with-session)?$/,
  keychain:
    /^(?=.*--eval)(?:--(?:eval|quiet|noask|nogui|ignore-missing|nolock|noinherit)|-q|--agents [a-z,]+|--timeout \d+|[A-Za-z0-9_][\w.-]{0,40})(?: (?:--(?:eval|quiet|noask|nogui|ignore-missing|nolock|noinherit)|-q|--agents [a-z,]+|--timeout \d+|[A-Za-z0-9_][\w.-]{0,40}))*$/,
  direnv: /^(?:hook|export) (?:bash|zsh|fish|tcsh|elvish|json)$/,
  pyenv:
    /^(?:init|virtualenv-init)(?: --path| --no-rehash)? -(?: (?:bash|zsh|fish|sh))?$|^init --path$/,
  rbenv: /^init(?: --no-rehash)? -(?: (?:bash|zsh|fish|sh))?$/,
  nodenv: /^init(?: --no-rehash)? -(?: (?:bash|zsh|fish|sh))?$/,
  jenv: /^init -$/,
  goenv: /^init -$/,
  plenv: /^init -$/,
  phpenv: /^init -$/,
  fnm: /^env(?: --[a-z-]+(?:=[\w.-]+)?)*$/,
  mise: /^(?:activate|hook-env|completion) [a-z]+(?: --[a-z-]+(?:=[\w.-]+)?)*$/,
  rtx: /^(?:activate|hook-env|completion) [a-z]+(?: --[a-z-]+(?:=[\w.-]+)?)*$/,
  brew: /^shellenv(?: (?:bash|zsh|fish|sh|csh|tcsh))?$/,
  starship: /^init [a-z]+(?: --[a-z-]+)?$/,
  zoxide: /^init [a-z]+(?: --(?:cmd|hook|no-cmd) ?[\w.-]*)*$/,
  atuin: /^init [a-z]+(?: --[a-z-]+)*$/,
  mcfly: /^init [a-z]+$/,
  fzf: /^--(?:bash|zsh|fish)$/,
  thefuck: /^--alias(?: [\w.-]+)?$/,
  conda: /^(?:shell\.[a-z]+ hook|shell hook(?: -s [a-z]+)?)$/,
  mamba: /^shell hook(?: -s [a-z]+)?$/,
  micromamba: /^shell hook(?: -s [a-z]+)?$/,
  minikube: /^(?:-p [\w.-]+ )?(?:docker|podman)-env(?: --[a-z-]+(?:=[\w.-]+)?)*$/,
  'docker-machine': /^env [\w.-]+$/,
  opam: /^env(?: --[a-z-]+(?:=[\w.-]+)?)*$/,
  luarocks: /^path(?: --[a-z-]+)*$/,
  dircolors: /^(?:-[bc]|--(?:sh|csh|bourne-shell|c-shell))?(?: [\w./~-]+)?$/,
  lesspipe: /^$/,
  'lesspipe.sh': /^$/,
  'register-python-argcomplete': /^[\w.-]+$/,
  // Completions for the CLIs an agent works with: `eval "$(kubectl completion zsh)"`.
  kubectl: /^completion [a-z]+$/,
  helm: /^completion [a-z]+$/,
  gh: /^completion -s [a-z]+$/,
  rustup: /^completions [a-z]+(?: [\w-]+)?$/,
  npm: /^completion$/,
  pnpm: /^completion [a-z]+$/,
  deno: /^completions [a-z]+$/,
  flyctl: /^completion [a-z]+$/,
  fly: /^completion [a-z]+$/,
};

/**
 * Where a tool called by a path may live: where packages put them. Not the project, and not the home
 * (`~/.cache/bin/ssh-agent`): what the agent can write is not a tool it can be trusted to have named.
 */
const SYSTEM_PATH =
  /^(?:\/usr\/(?:local\/)?(?:s?bin|libexec)|\/s?bin|\/opt\/[\w.-]+\/(?:s?bin|libexec)|\/home\/linuxbrew\/\.linuxbrew\/bin)\/[\w.+-]+$/;
/** A word of an argument list that holds nothing a shell expands, splits or quotes. */
const PLAIN_WORD = /^[\w.:/=@%+,~-]+$/;

/**
 * Whether `text`, what `eval` was given, is exactly `$(tool args)` or a pair of backticks of the
 * same, for a tool that prints its own setup and the arguments that ask for it.
 */
export function isInitSubstitution(text: string): boolean {
  const inner = /^\$\(\s*([^()]*?)\s*\)$/.exec(text) ?? /^`\s*([^`]*?)\s*`$/.exec(text);
  if (inner === null) return false;
  const words = (inner[1] ?? '').split(/\s+/).filter((word) => word !== '');
  const [tool, ...args] = words;
  if (tool === undefined || !words.every((word) => PLAIN_WORD.test(word))) return false;
  const name = tool.slice(tool.lastIndexOf('/') + 1);
  if (tool.includes('/') && !SYSTEM_PATH.test(tool)) return false;
  if (!Object.hasOwn(INIT_TOOLS, name)) return false;
  return (INIT_TOOLS[name] as RegExp).test(args.join(' '));
}
