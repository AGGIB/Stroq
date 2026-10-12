// What a reading of an artifact did not look at, in the words a passport says it with.
//
// A passport is a list of what was found and never a promise of what is not there, so the list of what
// was not looked at is as much a part of it as the lines. The wording is fixed here and nowhere else:
// an inspector counts (`Findings.tally`) and the text is made once, at the end, from the counts, so the
// same artifact always gives the same words. No name of a file from the artifact is ever in a blind
// spot; they say how many, not which.
/** The most lines a passport lists. */
export const MAX_LINES = 500;
/** The most places a line lists. */
export const MAX_PLACES = 20;
/** How much of a file is read for inspection; the rest of a longer file is a blind spot. */
export const READ_CAP_BYTES = 1024 * 1024;
/** How much front matter is read. */
export const FRONTMATTER_CAP_BYTES = 16 * 1024;

const some = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** What is true of every reading, whatever it found. */
export const ALWAYS_BLIND_SPOTS: readonly string[] = [
  'nothing was run: this is a reading of the files, and what the program does when it runs was not observed',
  'anything the program fetches, builds or decides at run time was not looked at',
  'code in languages other than JavaScript, TypeScript, Python and shell was not read',
];

/** What a reading counts as it goes; each count becomes one blind spot if it is not zero. */
export const TALLY_KEYS = [
  'unreadable-text',
  'partial-file',
  'frontmatter-too-long',
  'obfuscated-file',
  'shell-over-budget',
  'shell-text-cut',
  'untagged-fence',
  'lfs-pointer',
  'gitlink',
  'native-code',
  'unreadable-manifest',
  'dependencies',
  'symlink',
  'list-cut',
] as const;
export type TallyKey = (typeof TALLY_KEYS)[number];

const SPOTS: Readonly<Record<TallyKey, (count: number) => string>> = {
  'unreadable-text': (n) =>
    `${some(n, 'file looked', 'files looked')} binary or ${n === 1 ? 'was' : 'were'} not valid UTF-8 text, and ${n === 1 ? 'was' : 'were'} not read`,
  'partial-file': (n) =>
    `${some(n, 'file was', 'files were')} not read in full (only the first ${READ_CAP_BYTES / 1024 / 1024} MiB of ${n === 1 ? 'it was' : 'each was'} looked at)`,
  'frontmatter-too-long': (n) =>
    `${some(n, 'front matter block was', 'front matter blocks were')} not read, because ${n === 1 ? 'it is' : 'they are'} longer than ${FRONTMATTER_CAP_BYTES / 1024} KiB or never closed`,
  'obfuscated-file': (n) =>
    `${some(n, 'file looks', 'files look')} minified or obfuscated, so what ${n === 1 ? 'it does is' : 'they do is'} not understood`,
  'shell-over-budget': (n) =>
    `${some(n, 'piece of shell text was', 'pieces of shell text were')} not read, because the reading of shell text has a limit`,
  'shell-text-cut': (n) =>
    `${some(n, 'piece of shell text was', 'pieces of shell text were')} not read in full`,
  'untagged-fence': (n) =>
    `${some(n, 'code block', 'code blocks')} in markdown without a language tag ${n === 1 ? 'was' : 'were'} not read as shell`,
  'lfs-pointer': (n) =>
    `${some(n, 'Git LFS pointer file stands', 'Git LFS pointer files stand')} for content that is not in this tree`,
  gitlink: (n) =>
    `${some(n, 'nested repository (a gitlink) was', 'nested repositories (gitlinks) were')} recorded and not opened`,
  'native-code': (n) =>
    `${some(n, 'file of native code was', 'files of native code were')} not looked at (a binding.gyp, a .node file or a compiled program)`,
  'unreadable-manifest': (n) =>
    `${some(n, 'manifest could', 'manifests could')} not be parsed, so what ${n === 1 ? 'it declares' : 'they declare'} was not read`,
  dependencies: () => 'dependencies were not followed, fetched or read',
  symlink: (n) =>
    `${some(n, 'symbolic link was', 'symbolic links were')} recorded and not followed`,
  'list-cut': () => 'a list of tools, hooks or entries was cut at the number a reading takes',
};

/** The blind spots for the counts of a reading, in a fixed order. */
export function tallySpots(counts: Readonly<Partial<Record<TallyKey, number>>>): string[] {
  return TALLY_KEYS.flatMap((key) => {
    const count = counts[key] ?? 0;
    return count > 0 ? [SPOTS[key](count)] : [];
  });
}

/** What is said when more was found than a passport lists. */
export const moreLinesSpot = (hidden: number): string =>
  `${some(hidden, 'more finding was', 'more findings were')} found and ${hidden === 1 ? 'is' : 'are'} not listed, because a passport lists at most ${MAX_LINES}`;

export const morePlacesSpot =
  'some findings have more places than are listed, because a passport lists a few places for each';
