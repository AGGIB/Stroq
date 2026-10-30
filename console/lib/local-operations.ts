const JOB = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const TASK = 'task-[a-f0-9]{64}';
const SHA = '[a-f0-9]{64}';
const OPERATION = new RegExp(
  '^/api/(?:context|control|agents|(?:quarantine|mcp-containment|credential-filters)(?:/(?:preview|apply))?|' +
    'incidents(?:/(?:review|verify|compare|task|evidence))?|' +
    'journal/(?:tail|summary|since)|posture|threats|' +
    'incident-assessments(?:/(?:preview|apply|recheck))?|' +
    'session-taint(?:/(?:inspect|preview|clear|recheck))?|' +
    'workspace-review(?:/(?:check|cancel|review))?|' +
    'workspace-task-controls(?:/(?:preview|apply|restore-preview|restore|recheck))?|' +
    'workspace-monitor(?:/(?:preview|apply))?|' +
    'inventory-monitor(?:/(?:preview|apply))?|' +
    'mcp-tool-contracts(?:/(?:preview|apply))?|' +
    'mcp-call-controls(?:/(?:inspect|preview|apply|recheck))?|' +
    'mcp-governance(?:/(?:capture|preview|apply|recheck))?|' +
    'codex-network-guard(?:/(?:capture|preview|apply|recheck))?|' +
    'codex-network-checks(?:/(?:preview|start|cancel))?|' +
    'codex-path-guard(?:/(?:capture|preview|apply|recheck))?|' +
    `hook-checks(?:/(?:preview|start|cancel|jobs/${JOB}))?|` +
    `task-locks(?:/(?:page|preview|apply|access/(?:preview|issue|${TASK}/${SHA})))?|` +
    `(?:live|secrets)(?:/(?:preview|start|cancel|jobs/${JOB}))?|runs(?:/(?:cancel|${JOB}))?|` +
    'inventory(?:/(?:review|inspect|compare|codex-sources|codex-controls|codex-control-(?:preview|apply|recheck)|signals/(?:state|preview|apply)))?|agent-(?:setup|disconnect)(?:/(?:preview|apply))?|policy(?:/(?:preview|apply|try|history|restore/(?:preview|apply)|cases(?:/(?:save|remove))?))?)$',
);
/** Tokens are sent only to these exact same-origin local operations. */
export function isLocalOperation(path: unknown): path is string {
  return typeof path === 'string' && OPERATION.test(path);
}
