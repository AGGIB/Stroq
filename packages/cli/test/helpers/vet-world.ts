import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runVet, type VetDeps } from '../../src/commands/vet.js';
import { PDF_SKILL, WEATHER_SERVER } from './inspect-fixtures.js';
import type { Files } from './inspect.js';
import { tempRoot, writeFiles } from './install-dir.js';
import { tarOf, tgzOf, type TarEntry } from './tar-writer.js';

/**
 * The world of the tests of `stroq vet`: folders on a disk that is a fresh temporary one, and the command run in this
 * process with its two streams collected. Nothing here touches the real home or `STROQ_HOME`, and nothing
 * from a fixture is run: the command only reads.
 */
export interface VetRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `stroq vet` with the version of Stroq fixed, so that a passport does not change when the package is
 * released. A test may override anything but the two streams.
 */
export async function vet(args: readonly string[], deps: VetDeps = {}): Promise<VetRun> {
  let stdout = '';
  let stderr = '';
  const code = await runVet(args, {
    stroqVersion: '0.0.0-test',
    ...deps,
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

const textOf = (files: Files): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([path, spec]) => [path, String(spec)]));

/**
 * A folder called `name` with these files, under a root of its own: two folders of one name in two roots
 * are the same artifact in two places, which is what a test of "the same on any machine" needs.
 */
export function folder(name: string, files: Readonly<Record<string, string | Uint8Array>>): string {
  const dir = join(tempRoot('vet'), name);
  writeFiles(dir, files);
  return dir;
}

/**
 * An archive file called `name`, under a root of its own, made of these entries: gzipped unless `zipped` is
 * false. The entries are the writer's, so that every archive a test reads says what is in it.
 */
export function archive(
  name: string,
  entries: readonly (TarEntry | Uint8Array)[],
  zipped = true,
): string {
  const file = join(tempRoot('vet'), name);
  writeFileSync(file, zipped ? tgzOf(entries) : tarOf(entries));
  return file;
}

/** The files of a spec as entries of an archive, under one folder as npm and GitHub wrap theirs. */
export const entriesIn = (
  top: string,
  files: Readonly<Record<string, string | Uint8Array>>,
  modes: Readonly<Record<string, number>> = {},
): TarEntry[] =>
  Object.entries(files).map(([path, data]) => ({
    name: `${top}/${path}`,
    data,
    mode: modes[path] ?? 0o644,
  }));

/** The small skill of the inspector tests, as a folder. Its digest is the one in the golden passport. */
export const skillFolder = (name = 'pdf-forms-fixture'): string => folder(name, textOf(PDF_SKILL));

/** The same skill as an archive: the files of `skillFolder` under `package/`, with the modes of a folder. */
export const skillArchive = (
  name = 'pdf-forms-fixture.tgz',
  modes: Readonly<Record<string, number>> = {},
): string => archive(name, entriesIn('package', textOf(PDF_SKILL), modes));

/** The small MCP server of the inspector tests (a postinstall script, a URL), as a folder. */
export const mcpFolder = (name = 'weather-fixture'): string => folder(name, textOf(WEATHER_SERVER));

/** A plugin: a manifest, and a server that it starts through `.mcp.json`. */
export const pluginFolder = (name = 'formatter-fixture'): string =>
  folder(name, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'formatter', version: '0.3.0' }),
    '.mcp.json': JSON.stringify({
      mcpServers: {
        fmt: { command: 'node', args: ['server.js'], env: { FMT_TOKEN: '${FMT_PAT}' } },
      },
    }),
    'server.js': 'process.stdout.write("hi");\n',
  });

/**
 * Anything that would reach a terminal as a control: C0 except tab and newline, DEL, C1, the zero-width
 * and direction characters, line and paragraph separators, and the byte order mark.
 */
export const RAW_UNSAFE =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/;

/**
 * What the digest line carries where a folder is read without an executable bit (Windows): the tests that
 * run on every platform expect it there and not elsewhere. The ones that compare a whole screen with a
 * file, or use `--expect`, are for the platforms that have the bit.
 */
export const PLATFORM_NOTE =
  process.platform === 'win32' ? ' (platform-dependent: no executable bit)' : '';

/**
 * A skill whose front matter and shell block carry characters that act on a terminal or hide (an escape, a
 * direction override, a zero-width space, the 8-bit CSI), in its name, its version, its tools and a command.
 * Nothing here may reach a terminal as itself.
 */
export const HOSTILE_SKILL = [
  '---',
  'name: "evil\\e[31m\\u202ename\\x07"',
  'version: "1\\u200b.0\\e]52;c;eA=="',
  'allowed-tools: "Bash(echo \\e[2Jhi:*), Read\\u202e, WebFetch\\x9b"',
  '---',
  '# s',
  '',
  '```bash',
  'curl https://host\u202e.example/\u001b[1A',
  '```',
  '',
].join('\n');
