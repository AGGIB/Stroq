// What a Python project declares: where its requirements come from, and that pip runs `setup.py`.
//
// Requirements are read a line at a time, and each line only up to a bound, with patterns that cannot
// backtrack into one another. A requirement that is a repository, an archive at an address, or a local
// path is a signal, as is a pointer to another index (`--extra-index-url`, the way a package is
// swapped for another of the same name). `setup.py` is code that pip runs when it builds the package.
import { addressOf, type Address } from './addresses.js';
import type { Findings } from './findings.js';
import type { InspectInput } from './input.js';
import { showable } from './safe-text.js';
import type { TextFile } from './text-files.js';

const DETECTOR =
  'a requirement that does not come from the package index: what it fetches is what is at the address when it is installed; a signal to look at, not a verdict';
const ADDRESS_DETECTOR = 'the address of a requirement, as the project declares it';
const SETUP_DETECTOR =
  'setup.py is code that pip runs when it builds the package, as the project declares it by having one';

/** A line is read up to this many characters. */
const LINE_MAX = 500;

const REQUIREMENTS_FILE = /^requirements[\w.-]*\.txt$/i;
const INDEX_OPTION =
  /^(?:--index-url|-i|--extra-index-url|--find-links|-f|--trusted-host)(?:[\s=]+)(\S+)/;
/** `name @ address`, or `name[extra] @ address` (PEP 508); the optional group takes its own trailing blanks. */
const DIRECT_REFERENCE = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\]\s*)?@\s*(\S+)/;
const DEFAULT_INDEX_HOSTS: ReadonlySet<string> = new Set(['pypi.org', 'files.pythonhosted.org']);
const EGG = /#egg=([\w.-]+)/;
const VCS_IN_LINE = /(?:git|hg|svn|bzr)\+[a-z]+:\/\/[^\s"',\]]+/i;
const AT_ADDRESS = /@\s*((?:https?|file):\/\/[^\s"',\]]+)/i;
const SOURCE_KEY = /\b(git|url|path)\s*=\s*"([^"]{1,300})"/;
const LEADING_NAME = /^\W*([A-Za-z0-9][A-Za-z0-9._-]*)/;
const TABLE = /^\s*\[([^\]]{1,80})\]/;

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

function flag(
  file: TextFile,
  line: number,
  name: string,
  address: Address,
  findings: Findings,
): void {
  findings.signal({
    ruleId: 'non-registry-dependency',
    file: file.path,
    line,
    sensitive: true,
    detail: `${name === '' ? '' : `${name} `}(${address.kind}, ${address.display})`,
    basis: 'declared',
    detector: DETECTOR,
  });
  if (address.host !== null) {
    findings.line({
      kind: 'net',
      subject: address.host,
      basis: 'declared',
      sensitive: true,
      file: file.path,
      line,
      detector: ADDRESS_DETECTOR,
    });
  }
}

/** The address a requirement line names, and the name it gives, or null for a requirement from the index. */
function requirementAddress(text: string): { name: string; address: Address } | null {
  const direct = DIRECT_REFERENCE.exec(text);
  if (direct !== null) {
    const address = addressOf((direct[2] ?? '').replace(/^git\+/i, 'git+'));
    return address === null ? null : { name: direct[1] ?? '', address };
  }
  const address = addressOf(text.split(/\s/, 1)[0] ?? '');
  return address === null ? null : { name: EGG.exec(text)?.[1] ?? '', address };
}

function requirementsLines(file: TextFile, findings: Findings): void {
  const lines = file.text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const body = raw.slice(0, LINE_MAX);
    const comment = body.search(/(?:^|\s)#/);
    const text = (comment === -1 ? body : body.slice(0, comment)).trim();
    if (text === '') continue;
    const number = index + 1;
    const option = INDEX_OPTION.exec(text);
    if (option !== null) {
      const address = addressOf(option[1] ?? '');
      // The index everybody uses, named out loud, is not another place to fetch from.
      if (address !== null && !DEFAULT_INDEX_HOSTS.has(address.host ?? '')) {
        flag(file, number, 'index', address, findings);
      }
      continue;
    }
    if (text.startsWith('-') && !/^(?:-e|--editable)\s/.test(text)) continue;
    const requirement = text.replace(/^(?:-e|--editable)\s+/, '');
    const found = requirementAddress(requirement);
    if (found !== null) flag(file, number, found.name, found.address, findings);
  }
}

/** The address a key of a table of sources names (`path`, a repository, or an address). */
function sourceAddress(source: RegExpExecArray): Address | null {
  const text = source[2] ?? '';
  if (source[1] === 'path') return { kind: 'file', host: null, display: showable(text, 120) };
  const address = addressOf(text);
  return address === null ? null : { ...address, kind: source[1] === 'url' ? address.kind : 'git' };
}

function pyprojectLines(file: TextFile, findings: Findings): void {
  let table = '';
  for (const [index, raw] of file.text.split('\n').entries()) {
    const body = raw.slice(0, LINE_MAX);
    const header = TABLE.exec(body);
    if (header !== null) {
      table = (header[1] ?? '').trim();
      continue;
    }
    const name = LEADING_NAME.exec(body)?.[1] ?? '';
    const number = index + 1;
    const sources = /^tool\.(?:uv\.sources|poetry\.(?:group\.[\w-]+\.)?dependencies)$/.test(table);
    const vcs = VCS_IN_LINE.exec(body)?.[0] ?? AT_ADDRESS.exec(body)?.[1];
    const source = sources ? SOURCE_KEY.exec(body) : null;
    const address =
      vcs !== undefined ? addressOf(vcs) : source === null ? null : sourceAddress(source);
    if (address !== null) flag(file, number, name, address, findings);
  }
}

export function inspectPython(input: InspectInput, findings: Findings): void {
  let any = false;
  for (const file of input.texts) {
    const name = basename(file.path);
    if (REQUIREMENTS_FILE.test(name)) {
      any = true;
      requirementsLines(file, findings);
    } else if (name === 'pyproject.toml') {
      any = true;
      pyprojectLines(file, findings);
    } else if (name === 'setup.py') {
      findings.line({
        kind: 'install-script',
        subject: 'setup.py (run by pip when the package is built)',
        basis: 'observed',
        sensitive: true,
        file: file.path,
        line: 1,
        detector: SETUP_DETECTOR,
      });
    }
  }
  if (any) findings.tally('dependencies');
}
