import { join } from 'node:path';
import { runVet, type VetDeps } from '../../src/commands/vet.js';
import { PDF_SKILL, WEATHER_SERVER } from './inspect-fixtures.js';
import type { Files } from './inspect.js';
import { tempRoot, writeFiles } from './install-dir.js';

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

/** The small skill of the inspector tests, as a folder. Its digest is the one in the golden passport. */
export const skillFolder = (name = 'pdf-forms-fixture'): string => folder(name, textOf(PDF_SKILL));

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
