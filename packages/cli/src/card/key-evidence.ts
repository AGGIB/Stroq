// The evidence behind a moment about keys, as the groups of rows `stroq show` prints: the call's own text with
// every key taken out (`[NAME]` in its place), and the rule that linked the call to each key.
//
// A person reads this to decide whether Stroq is right, so it says plainly when the call does not hold the key at
// all ("The key is not in this command; Stroq linked it by …") and names the rule in words and as the check knows
// it (route, via, what matched). All of it came from a transcript or a key file: each string goes through
// `clean`, and the text was already taken apart by `sent/evidence.ts`, which keeps no value.
import type { Finding } from '../sent/findings.js';
import { markerName } from '../sent/evidence.js';
import { isEverywhere } from '../sent/file-paths.js';
import type { Evidence, Matched } from '../sent/place.js';
import type { Moment } from './schema.js';
import { clean, shortPath } from './text.js';

/** Calls shown for one moment, at most; the rest are counted. */
const MAX_CALLS = 3;
/** The longest call text a row holds: the evidence keeps about 600 characters and an ellipsis at each end. */
const TEXT = 700;

type Group = Moment['groups'][number];

const SPELLINGS: Readonly<Record<string, string>> = {
  value: 'Its value is in this command, as written',
  'value-json': 'Its value is in this command, JSON-escaped',
  'value-url': 'Its value is in this command, URL-encoded',
  'value-joined': 'Its value is in this command once the shell joins its quotes',
};

/** Where the last folder of a path ends: a key file found on Windows is spelled with `\`. */
const lastSeparator = (path: string): number =>
  Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));

/** The file name of a path: what a command names a key file by. */
const nameOf = (path: string): string => path.slice(lastSeparator(path) + 1);

/** Whether the masked text shows the key: its `[NAME]`, or the name of the file it is kept in. */
function showsKey(f: Finding, evidence: Evidence): boolean {
  if (evidence.text.includes(`[${markerName(f.name)}]`)) return true;
  const file = f.source === 'env' ? '' : nameOf(f.source);
  return file !== '' && evidence.text.includes(file);
}

/** What linked the call to the key, in two shapes: after "Stroq linked it by", and as a sentence of its own. */
function ruleWords(f: Finding, evidence: Evidence, home: string): { by: string; plain: string } {
  const word = evidence.word === undefined ? '' : clean(evidence.word, 60);
  const kept = shortPath(f.source, home, 50);
  const folder = shortPath(f.source.slice(0, Math.max(0, lastSeparator(f.source))), home, 50);
  switch (evidence.matched) {
    case 'file':
      return {
        by: `the word ${word === '' ? 'it names' : word}, which names the file the key is kept in, ${kept}`,
        plain: `The command names the file the key is kept in, ${kept}${word === '' ? '' : ` (the word ${word})`}.`,
      };
    case 'folder':
      // The root and the home folder have every key file under them: they are named as a whole.
      if (word !== '' && isEverywhere(word))
        return {
          by: `the word ${word}, a folder the key's file is under, ${kept}`,
          plain: `The command names ${word}, a folder the key's file is under, ${kept}.`,
        };
      return {
        by: `the word ${word === '' ? 'it names' : word}, a folder the key's file is in or under, ${folder}`,
        plain: `The command names the folder the key is kept in, ${folder}${word === '' ? '' : ` (the word ${word})`}.`,
      };
    case 'pattern':
      return {
        by: `the pattern ${word === '' ? 'it uses' : word}, which takes in the file the key is kept in, ${kept}`,
        plain: `The command names a pattern${word === '' ? '' : ` (${word})`} that takes in the file the key is kept in, ${kept}.`,
      };
    case 'environment':
      return {
        by: 'printing the environment, where the key is set',
        plain: 'The command prints the environment, where the key is set.',
      };
    case 'variable':
      return {
        by: `the variable ${word === '' ? 'it uses' : word}, which an earlier call put the key in`,
        plain: `The command uses ${word === '' ? 'a variable' : word}, which an earlier call put the key in.`,
      };
    case 'written-file':
      return {
        by: 'a file the AI wrote the key into, which a later call used',
        plain: 'The AI wrote the key into a file, and a later call used that file.',
      };
    default: {
      const spelling = SPELLINGS[evidence.matched] ?? 'Its value is in this command';
      return { by: spelling, plain: `${spelling}.` };
    }
  }
}

/** The sentence of a row: the rule, with the plain admission when the call does not hold the key. */
function linkedBy(f: Finding, evidence: Evidence, home: string): string {
  const rule = ruleWords(f, evidence, home);
  if (evidence.matched.startsWith('value') || evidence.matched === 'written-file')
    return rule.plain;
  return showsKey(f, evidence)
    ? rule.plain
    : `The key is not in this command; Stroq linked it by ${rule.by}.`;
}

/** The rule as the check knows it: route, via, what matched. */
function checkRule(f: Finding, evidence: Evidence): string {
  const via = f.place.via === undefined ? '' : `, via ${f.place.via}`;
  return `route ${f.place.route}${via}, matched ${evidence.matched}`;
}

/** The groups of `stroq show` for the evidence of the findings of a moment; none when there is none. */
export function evidenceGroups(group: readonly Finding[], home: string): Group[] {
  const proved = group.flatMap((f) =>
    f.place.evidence === undefined ? [] : [[f, f.place.evidence] as const],
  );
  if (proved.length === 0) return [];
  const calls = new Map<string, (readonly [Finding, Evidence])[]>();
  for (const one of proved) {
    const held = calls.get(one[1].text);
    if (held === undefined) calls.set(one[1].text, [one]);
    else held.push(one);
  }
  const shown = [...calls.entries()].slice(0, MAX_CALLS);
  const out: Group[] = shown.map(([text, members], at) => {
    // Each distinct rule once, with the keys it covers when the call covers several.
    const rules = new Map<string, { names: string[]; check: string }>();
    for (const [f, evidence] of members) {
      const sentence = clean(linkedBy(f, evidence, home), 400);
      const held = rules.get(sentence);
      if (held === undefined)
        rules.set(sentence, { names: [clean(f.name, 60)], check: checkRule(f, evidence) });
      else held.names.push(clean(f.name, 60));
    }
    const several = members.length > 1 || calls.size > 1;
    const ruleRows = [...rules.entries()].flatMap(
      ([sentence, { names, check }], i): [string, string][] => [
        [
          i === 0 ? 'Linked by' : '',
          rules.size > 1 ? `${names.join(', ')}: ${sentence}` : sentence,
        ],
        [i === 0 ? 'Rule' : '', check],
      ],
    );
    return {
      title: calls.size > 1 ? `The call (${at + 1} of ${calls.size})` : 'The call',
      rows: [
        ...(text === '' ? [] : ([['Command', clean(text, TEXT)]] as [string, string][])),
        ...(several
          ? ([['Keys', members.map(([f]) => clean(f.name, 60)).join(', ')]] as [string, string][])
          : []),
        ...ruleRows,
      ].slice(0, 16),
    };
  });
  if (calls.size > MAX_CALLS)
    out.push({ title: 'More calls', rows: [['', `and ${calls.size - MAX_CALLS} more calls`]] });
  return out;
}
