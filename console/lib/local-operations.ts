const JOB = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const OPERATION = new RegExp(
  '^/api/(?:context|control|agents|card(?:/start)?|(?:quarantine|mcp-containment)(?:/(?:preview|apply))?|' +
    'incidents(?:/(?:review|verify|compare|evidence))?|' +
    'journal/(?:tail|summary|since)|posture|' +
    'incident-assessments(?:/(?:preview|apply|recheck))?|' +
    'session-taint(?:/(?:inspect|preview|clear|recheck))?|' +
    'workspace-review(?:/(?:check|cancel|review))?|' +
    'workspace-task-controls(?:/(?:preview|apply|restore-preview|restore|recheck))?|' +
    'workspace-monitor(?:/(?:preview|apply))?|' +
    'inventory-monitor(?:/(?:preview|apply))?|' +
    'mcp-tool-contracts(?:/(?:preview|apply))?|' +
    'mcp-call-controls(?:/(?:inspect|preview|apply|recheck))?|' +
    'mcp-governance(?:/(?:capture|preview|apply|recheck))?|' +
    `hook-checks(?:/(?:preview|start|cancel|jobs/${JOB}))?|` +
    `secrets(?:/(?:preview|start|cancel|jobs/${JOB}))?|runs(?:/(?:cancel|${JOB}))?|` +
    'inventory(?:/(?:review|inspect|compare|signals/(?:state|preview|apply)))?|agent-(?:setup|disconnect)(?:/(?:preview|apply))?|policy(?:/(?:preview|apply|try|history|restore/(?:preview|apply)|cases(?:/(?:save|remove))?))?)$',
);
/** Tokens are sent only to these exact same-origin local operations. */
export function isLocalOperation(path: unknown): path is string {
  return typeof path === 'string' && OPERATION.test(path);
}
