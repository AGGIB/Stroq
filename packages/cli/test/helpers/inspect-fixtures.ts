import type { Files } from './inspect.js';

/**
 * A skill as a person might write one: front matter that asks for a few tools, a body with commands to
 * run, a script, and a reference page. Everything in it is made up, and the hosts end in `.example`.
 */
export const PDF_SKILL: Files = {
  'SKILL.md': `---
name: pdf-forms
description: Fill in and check PDF forms
version: 1.2.0
allowed-tools: Read, Grep, Write(forms/**), Bash(python3:*), WebFetch
---

# PDF forms

Install the reader once:

\`\`\`bash
pip install pypdf
\`\`\`

Fill a form and check the result with the service:

\`\`\`bash
python3 scripts/fill.py form.pdf answers.json
curl -s https://api.pdf-tools.example/v1/check -o check.json
\`\`\`

See [the reference](reference.md) for the fields.
`,
  'reference.md': `# Reference

Fields are listed by name. The service is documented at https://docs.pdf-tools.example/api.

\`\`\`
untagged blocks are not read as shell
\`\`\`
`,
  'scripts/fill.py': `import os
import subprocess
import json

API_KEY = os.environ["PDF_API_KEY"]
REGION = os.getenv("PDF_REGION", "eu")


def check(path):
    url = "https://api.pdf-tools.example/v1/check"
    return subprocess.run(["curl", "-s", url, "-F", f"file=@{path}"], check=True)


if __name__ == "__main__":
    print(json.dumps(check("form.pdf")))
`,
  'LICENSE.txt': 'MIT License\n',
};

/** An MCP server as a package: a bin, a lifecycle script, a dependency on the SDK, and source that reads the environment. */
export const WEATHER_SERVER: Files = {
  'package.json': JSON.stringify(
    {
      name: '@acme/weather-mcp',
      version: '1.2.0',
      bin: { 'weather-mcp': 'dist/index.js' },
      main: 'dist/index.js',
      scripts: {
        postinstall: 'node scripts/postinstall.js',
        build: 'tsc -p .',
        test: 'vitest run',
      },
      dependencies: {
        '@modelcontextprotocol/sdk': '^1.0.0',
        zod: '^3.23.0',
        'left-pad-fork': 'github:acme/left-pad-fork#v2',
      },
    },
    null,
    2,
  ),
  'dist/index.js': `#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { execFile } from 'node:child_process';

const key = process.env.WEATHER_API_KEY;
const home = process.env.HOME;

async function forecast(city) {
  const res = await fetch('https://api.weather.example/v2/forecast?city=' + city, {
    headers: { authorization: 'Bearer ' + key },
  });
  return res.json();
}

execFile('uname', ['-a'], () => {});
export { forecast, Server, home };
`,
  'scripts/postinstall.js': `// Warms a cache after install.
const url = 'https://cdn.weather.example/data/stations.json';
console.log('fetching', url);
`,
  'README.md': `# weather-mcp

\`\`\`json
{ "mcpServers": { "weather": { "command": "npx", "args": ["-y", "@acme/weather-mcp"] } } }
\`\`\`
`,
};
