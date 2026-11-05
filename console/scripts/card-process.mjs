import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_OUTPUT = 4 * 1024 * 1024;
/** The card stops starting work after about half a minute and finishes what it began; this is the wall. */
export const CARD_DEADLINE_MS = 150_000;
/** Names that make a Node or a loader run somebody's code before the card's own. */
const LOADER_NAMES = /^(?:NODE_[A-Z_]*|LD_[A-Z_]*|DYLD_[A-Z_]*|ELECTRON_RUN_AS_NODE)$/;

/**
 * The environment the card runs in: the console's own, as the terminal's would be, so that the keys
 * the card looks for are the keys the terminal's card looks for; only what makes Node run other code
 * first is left out, and the places the card reads are named by the server and not the browser.
 */
export function cardEnvironment({ home, userHome = homedir(), environment = process.env } = {}) {
  const inherited = Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => typeof value === 'string' && !LOADER_NAMES.test(name),
    ),
  );
  return {
    ...inherited,
    HOME: userHome,
    USERPROFILE: userHome,
    STROQ_HOME: home ?? environment.STROQ_HOME ?? join(userHome, '.stroq'),
    NO_COLOR: '1',
  };
}

/**
 * Runs `stroq card --json` and returns what it printed, parsed. This is the card of the terminal,
 * not a copy of it: the same command, over the same sessions, with the same cache and the same
 * `stroq show` file left behind. The answer is checked by the presentation step, not here.
 */
export function executeCard(options) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('cancelled'));
    const child = (options.spawn ?? spawn)(
      process.execPath,
      ['--max-old-space-size=2048', options.paths.cli, 'card', '--json'],
      {
        cwd: options.project,
        env: cardEnvironment(options),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    let done = false;
    let problem = null;
    let output = '';
    let bytes = 0;
    let final;
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* Already gone. */
      }
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(final);
      options.signal?.removeEventListener('abort', abort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (problem) return reject(new Error(problem));
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error('invalid-report'));
      }
    };
    const stop = (code) => {
      if (done || problem) return;
      problem = code;
      kill();
      final = setTimeout(finish, 1000);
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(
      () => stop('deadline-exceeded'),
      options.timeoutMs ?? CARD_DEADLINE_MS,
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) return stop('output-limit');
      output += chunk.toString('utf8');
    });
    // What the card says on standard error is for a person at a terminal; it is not read here.
    child.stderr?.on('data', () => {});
    child.once('error', () => {
      problem ??= 'engine-unavailable';
      finish();
    });
    child.once('close', (code) => {
      if (!problem && code !== 0) problem = 'card-failed';
      finish();
    });
  });
}
