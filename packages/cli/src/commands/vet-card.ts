// `stroq vet --card`: a snippet of Markdown for the README of the artifact.
//
// It is meant to be pasted where other people read it, so it holds the least that is true and useful: the
// name, the digest, the counts and the command that reproduces the digest. It holds nothing else from the
// artifact: no subject, no place, no sentence of a blind spot, because every one of those is text that its
// author wrote and a README is where it would be believed. The name is the one string that comes from the
// artifact, and it is made safe (one line, no control character, cut) and put in a code span that it
// cannot close.
import { failedReadings } from '../install/inspect/index.js';
import type { Passport } from '../install/types.js';
import { isPlatformDependent } from './vet-render.js';
import { count, lineText } from './vet-text.js';

const NAME_MAX = 100;
const RULE_MAX = 48;

/** `text` as Markdown code: with no backtick in it, nothing in it can end the span. */
const code = (text: string): string => `\`${text.replaceAll('`', "'")}\``;

/** The command that gives the same digest, or why there is none where the digest depends on the platform. */
function reproduceLine(passport: Passport): string {
  if (isPlatformDependent(passport)) {
    return 'Reproduce: not available, because this folder was read where the executable bit is not known (Windows), so its digest depends on the platform.';
  }
  const from = passport.artifact.source.type === 'tarball' ? '<archive>' : '<dir>';
  return `Reproduce: ${code(`stroq vet --from ${from} --expect sha256:${passport.artifact.digest}`)}`;
}

export function renderCard(passport: Passport): string {
  const { kind, name, digest, files, bytes } = passport.artifact;
  const sensitive = passport.lines.filter((line) => line.sensitive).length;
  const platform = isPlatformDependent(passport) ? ' (platform-dependent: no executable bit)' : '';
  const failed = failedReadings(passport).map((reading) => lineText(reading, RULE_MAX));
  const incomplete =
    failed.length === 0
      ? []
      : [
          `- Incomplete: ${count(failed.length, 'reading')} failed (${failed.join(', ')}), so what it finds is missing`,
        ];
  return [
    `**Stroq vet** ${code(lineText(name, NAME_MAX))} (${kind})`,
    '',
    `- Digest: ${code(`stroq-tree/1 sha256:${digest}`)}${platform}`,
    `- ${count(files, 'file')}, ${count(bytes, 'byte')}`,
    `- ${sensitive} sensitive lines of ${passport.lines.length}`,
    `- ${count(passport.signals.length, 'signal')}`,
    `- ${count(passport.blindSpots.length, 'blind spot')} (what Stroq did not look at)`,
    ...incomplete,
    `- Made by Stroq ${lineText(passport.analysis.stroq, 32)} with ${lineText(passport.analysis.rules, 48)}`,
    '',
    reproduceLine(passport),
    '',
    'Not a security certificate.',
    '',
  ].join('\n');
}
