// What the artifact says it is called, as lines of the passport.
//
// The title of the passport never comes from here (see `identity.ts`). The declaration is a line on the
// basis `declared`, so that a person reads it as what the artifact claims, and when the source names the
// artifact and the declared name is another one it is a sensitive signal: the name is the thing an
// artifact borrows to look like another. Only the declared name, made safe and cut, is in the subject.
import type { Findings } from './findings.js';
import { declaredNameDiffers, type DeclaredIdentity } from './identity.js';
import { showable } from './safe-text.js';
import type { SourceRef } from '../types.js';

const NAME_MAX = 100;
const VERSION_MAX = 64;

const DECLARED_DETECTOR =
  'the name and version the artifact gives itself, in its own files; they have not been checked against anything, and the title of this passport is not taken from them where the source names the artifact';
const DIFFERS_DETECTOR =
  'the name the artifact gives itself is not the name of the source it was taken from, and a name is what an artifact borrows to look like another; the title of this passport is the name of the source; a signal to look at, not a verdict';

export function addIdentityLines(
  findings: Findings,
  source: SourceRef,
  declared: DeclaredIdentity | null,
): void {
  if (declared === null) return;
  const name = declared.name === null ? '' : showable(declared.name, NAME_MAX);
  const version = declared.version === null ? '' : showable(declared.version, VERSION_MAX);
  if (name === '' && version === '') return;
  findings.line({
    kind: 'signal',
    subject:
      name === ''
        ? `declared-version: ${version}`
        : `declared-name: ${name}${version === '' ? '' : ` ${version}`}`,
    basis: 'declared',
    sensitive: false,
    file: declared.file,
    line: null,
    detector: DECLARED_DETECTOR,
  });
  if (declared.name !== null && name !== '' && declaredNameDiffers(source, declared.name)) {
    findings.signal({
      ruleId: 'declared-name-differs',
      file: declared.file,
      line: null,
      sensitive: true,
      basis: 'declared',
      detail: name,
      detector: DIFFERS_DETECTOR,
    });
  }
}
