import { PRE_TRUST, WHY, repoFindings, type RepoSurface } from './repo-surface.js';

const SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const HELP = 'https://github.com/AGGIB/Stroq/blob/main/docs/GUIDE.md#before-you-open-a-repository';
/**
 * GitHub ranks a code-scanning alert by this number, and 9.0 and above is critical —
 * which is what `stroq inspect` already calls every one of these, and why it exits 1.
 */
const SECURITY_SEVERITY = '9.0';

const ruleId = (kind: string): string => `stroq/${kind}`;

/**
 * `stroq inspect` as a SARIF 2.1.0 log, for GitHub code scanning and any other tool
 * that reads the format: a repository's pre-trust execution shown on the pull request
 * that adds it, before anyone opens the checkout with an agent.
 *
 * One rule per kind of pre-trust execution, all five always listed so the rule set
 * does not change with the repository scanned, and one result per finding, placed at
 * its repository-relative file. What runs on an ordinary open or build is left out,
 * exactly as it is left out of the exit code: a check that flags every repository with
 * a pre-commit hook is a check people turn off.
 *
 * `stroq exposure` has no SARIF form on purpose. Its findings are about this machine —
 * an agent without hooks, an MCP server outside the proxy — and have no file in the
 * repository to point at, which code scanning requires of every result.
 */
export function inspectSarif(surface: RepoSurface, version: string): object {
  const kinds = [...PRE_TRUST];
  const findings = repoFindings(surface);
  return {
    $schema: SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'stroq',
            version,
            informationUri: 'https://stroq.dev',
            rules: kinds.map((kind) => ({
              id: ruleId(kind),
              name: kind,
              shortDescription: { text: `Repository-supplied execution: ${kind}` },
              fullDescription: { text: WHY[kind] ?? 'repository-supplied execution' },
              helpUri: HELP,
              defaultConfiguration: { level: 'error' },
              properties: { 'security-severity': SECURITY_SEVERITY, tags: ['security'] },
            })),
          },
        },
        results: surface.preTrust.map((hit, i) => {
          const finding = findings[i];
          const fix = finding?.fix ? ` Fix: ${finding.fix}.` : '';
          return {
            ruleId: ruleId(hit.kind),
            ruleIndex: kinds.indexOf(hit.kind),
            level: 'error',
            message: { text: `${finding?.detail ?? `${hit.file} — ${hit.what}`}.${fix}` },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: hit.file.replace(/\\/g, '/'), uriBaseId: '%SRCROOT%' },
                },
              },
            ],
          };
        }),
      },
    ],
  };
}
