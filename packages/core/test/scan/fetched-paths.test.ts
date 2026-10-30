import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchedPaths, inFetched } from '../../src/scan/fetched-paths.js';

const cwd = '/home/dev/project';

describe('fetchedPaths', () => {
  it.each<[string, string[]]>([
    ['curl -s -o page.html https://docs.example/setup', [`${cwd}/page.html`]],
    ['curl -sSLo /tmp/page.html https://docs.example/setup', ['/tmp/page.html']],
    ['curl -O https://docs.example/guide.md', [`${cwd}/guide.md`]],
    ['wget -O docs/a.html https://docs.example/a', [`${cwd}/docs/a.html`]],
    ['curl -s https://docs.example/a > out/a.txt', [`${cwd}/out/a.txt`]],
    ['curl -o ~/Downloads/x.pdf https://docs.example/x.pdf', [join(homedir(), 'Downloads/x.pdf')]],
    ['git clone https://github.com/o/r.git', [`${cwd}/r`]],
    ['git clone --depth 1 https://github.com/o/r.git vendor-r', [`${cwd}/vendor-r`]],
    ['gh repo clone o/tool', [`${cwd}/tool`]],
    ['cd sub && curl -o x.html https://docs.example/x', [`${cwd}/sub/x.html`]],
    ['cd /tmp/w; curl -sO https://docs.example/readme.html', ['/tmp/w/readme.html']],
    [
      'curl -s -o a.tgz https://e.invalid/a.tgz && tar xzf a.tgz -C vendor-a',
      [`${cwd}/a.tgz`, `${cwd}/vendor-a`],
    ],
    [
      'curl -s -o p.zip https://e.invalid/p.zip && unzip -q p.zip -d pkg',
      [`${cwd}/p.zip`, `${cwd}/pkg`],
    ],
  ])('%s', (command, expected) => {
    // A path is resolved where Stroq runs: on Windows `/home/dev/project` is on the current drive.
    expect(fetchedPaths(command, cwd)).toEqual(expected.map((path) => resolve(path)));
  });

  it('leaves out what a variable or a substitution names, and what fetches nothing', () => {
    expect(fetchedPaths('curl -o "$OUT" https://docs.example/x', cwd)).toEqual([]);
    expect(fetchedPaths('cat page.html > copy.html', cwd)).toEqual([]);
    expect(fetchedPaths('curl -s https://docs.example/x', cwd)).toEqual([]);
  });

  it('says whether a path is one of them or inside one', () => {
    expect(inFetched(`${cwd}/r/README.md`, [`${cwd}/r`])).toBe(true);
    expect(inFetched(`${cwd}/r`, [`${cwd}/r`])).toBe(true);
    expect(inFetched(`${cwd}/rx/README.md`, [`${cwd}/r`])).toBe(false);
  });
});
