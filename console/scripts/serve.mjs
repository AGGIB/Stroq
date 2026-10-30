import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readLocalSnapshot } from './local-snapshot.mjs';
import { createControl } from './control.mjs';
import { routeControl, jsonAction } from './control-http.mjs';
import { REPOSITORY, ENGINE_PATHS } from './control-engine.mjs';
import { runtimeDigest } from './runtime-digest.mjs';
import { createAgentSetup } from './agent-setup.mjs';
import { createAgentDisconnect } from './agent-disconnect.mjs';
import { routeAgentSetup } from './agent-setup-http.mjs';
import { createPolicyService } from './policy-service.mjs';
import { createPolicyHistoryService } from './policy-history-service.mjs';
import { createPolicyCasesStore } from './policy-cases-store.mjs';
import { createPolicyCasesService } from './policy-cases.mjs';
import { runPolicyAdapter, runPolicyCaseEvaluation } from './policy-worker.mjs';
import { createInventory } from './inventory.mjs';
import { createSkillQuarantine } from './skill-quarantine.mjs';
import { createCredentialFilterService } from './credential-filters.mjs';
import { routeCredentialFilters } from './credential-filter-http.mjs';
import { createMcpContainmentService } from './mcp-containment.mjs';
import {
  routeMcpContainment,
  routeMcpToolContracts,
  routeMcpCallControls,
} from './mcp-containment-http.mjs';
import {
  createMcpToolContractService,
  createMcpCallControlService,
} from './mcp-tool-contracts.mjs';
import { createAgentStatus } from './agent-status.mjs';
import { createIncidentService } from './incidents.mjs';
import { createIncidentAssessmentService, routeIncidentAssessments } from './incidents-worker.mjs';
import { createLiveProofService } from './live-proof-service.mjs';
import { createHookCheckService } from './hook-check-service.mjs';
import { createTaskLockService } from './task-lock-service.mjs';
import { createTaskAccessService } from './task-access-service.mjs';
import { createWorkspaceReviewService } from './workspace-review-service.mjs';
import {
  createWorkspaceMonitorControl,
  routeWorkspaceMonitor,
  createInventoryMonitorControl,
  routeInventoryMonitor,
  createWorkspaceTaskControl,
  routeWorkspaceTasks,
  createSessionTaintControl,
  routeSessionTaint,
  acquireProtectionCheckLease,
  createJournalViewService,
  createPostureService,
  createThreatFeedService,
  routeJournalView,
  routePosture,
  routeThreatFeed,
} from './workspace-monitor-bridge.mjs';
import { createSecretScanService } from './secret-scan-service.mjs';
import { createIncidentRecheckService } from './incident-recheck.mjs';
import { routeOperational } from './operational-http.mjs';
import { runtimeLayout } from './runtime-layout.mjs';
import { createRunStore } from './run-store.mjs';
import { executeCodexNetworkCheck } from './hook-check-process.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../out');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // Next's static export includes inline bootstrap scripts and styles. No remote
  // scripts, connections or framing are allowed, and eval stays disabled.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function respond(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { ...HEADERS, 'Content-Type': type });
  res.end(body);
}

function authenticated(req, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(
    typeof req.headers.authorization === 'string' ? req.headers.authorization : '',
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function safePath(raw) {
  // Reject before URL normalization, which would otherwise erase traversal.
  if (typeof raw !== 'string' || raw.length > 4096 || !raw.startsWith('/') || raw.startsWith('//'))
    return null;
  try {
    const path = decodeURIComponent(raw.split('?')[0]);
    if (/[\\%\u0000-\u001f\u007f]/.test(path)) return null;
    const parts = path.split('/').filter(Boolean);
    if (parts.some((part) => part === '..' || part.startsWith('.'))) return null;
    return { path, parts };
  } catch {
    return null;
  }
}

async function staticFile(root, parts) {
  let handle;
  try {
    let path = root;
    for (const part of parts) {
      path = join(path, part);
      const info = await lstat(path);
      if (info.isSymbolicLink()) return null;
    }
    const info = await lstat(path);
    if (info.isDirectory()) path = join(path, 'index.html');
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > 20 * 1024 * 1024 ||
      (await realpath(path)) !== path
    )
      return null;
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.size !== before.size
    )
      return null;
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) return null;
    return { bytes, type: MIME[extname(path)] || 'application/octet-stream' };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Authenticated loopback console with an allowlist of local diagnostic jobs. */
export async function startServer({
  root = DEFAULT_ROOT,
  home,
  userHome,
  project,
  control: suppliedControl,
  setup: suppliedSetup,
  disconnect: suppliedDisconnect,
  policy: suppliedPolicy,
  policyHistory: suppliedPolicyHistory,
  mcpGovernance: suppliedMcpGovernance,
  inventory: suppliedInventory,
  quarantine: suppliedQuarantine,
  credentialFilters: suppliedCredentialFilters,
  claudeConfigDir: suppliedClaudeConfigDir,
  mcp: suppliedMcp,
  mcpToolContracts: suppliedMcpToolContracts,
  mcpCallControls: suppliedMcpCallControls,
  mcpEnvironment: suppliedMcpEnvironment,
  codexEnvironment: suppliedCodexEnvironment,
  codexNetworkGuard: suppliedCodexNetworkGuard,
  codexPathGuard: suppliedCodexPathGuard,
  codexNetworkChecks: suppliedCodexNetworkChecks,
  agents: suppliedAgents,
  incidents: suppliedIncidents,
  incidentAssessments: suppliedIncidentAssessments,
  live: suppliedLive,
  hookChecks: suppliedHookChecks,
  taskLocks: suppliedTaskLocks,
  taskAccess: suppliedTaskAccess,
  workspaceReview: suppliedWorkspaceReview,
  workspaceTasks: suppliedWorkspaceTasks,
  sessionTaint: suppliedSessionTaint,
  workspaceMonitor: suppliedWorkspaceMonitor,
  inventoryMonitor: suppliedInventoryMonitor,
  journalView: suppliedJournalView,
  posture: suppliedPosture,
  threatFeed: suppliedThreatFeed,
  secrets: suppliedSecrets,
  comparisons: suppliedComparisons,
  port = 47815,
  token = randomBytes(32).toString('base64url'),
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new TypeError('Invalid console port');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new TypeError('Invalid console token');
  const staticRoot = await realpath(root);
  if (!(await lstat(staticRoot)).isDirectory())
    throw new Error('Build the console before starting its server');
  const selectedUserHome = await realpath(resolve(userHome ?? homedir()));
  const selectedProject = await realpath(resolve(project ?? REPOSITORY));
  const selectedHome = resolve(home ?? process.env.STROQ_HOME ?? join(selectedUserHome, '.stroq'));
  const mcpEnvironment =
    suppliedMcpEnvironment ??
    (userHome === undefined
      ? { APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
      : {});
  const codexEnvironment =
    suppliedCodexEnvironment ??
    (userHome === undefined ? { CODEX_HOME: process.env.CODEX_HOME } : {});
  const context = {
    home: selectedHome,
    userHome: selectedUserHome,
    project: selectedProject,
    mcpEnvironment,
    codexEnvironment,
  };
  const setup = suppliedSetup ?? (await createAgentSetup(context));
  const workspaceId = `workspace-${createHash('sha256').update(selectedProject).digest('hex').slice(0, 24)}`;
  const disconnect =
    suppliedDisconnect ?? (await createAgentDisconnect({ ...context, workspaceId }));
  const policyCaseStore = createPolicyCasesStore({ home: selectedHome });
  const policy =
    suppliedPolicy ?? createPolicyService({ home: selectedHome, caseStore: policyCaseStore });
  const policyHistory =
    suppliedPolicyHistory ??
    createPolicyHistoryService({ home: selectedHome, caseStore: policyCaseStore });
  const inventory = suppliedInventory ?? createInventory(context);
  let networkSchema;
  try {
    networkSchema = await import(
      pathToFileURL(runtimeLayout().adapter('local-api-schema.js')).href
    );
  } catch {
    /* Finite feature refusal when the local runtime is unavailable. */
  }
  const mcpGovernance = suppliedMcpGovernance ??
    networkSchema?.createMcpGovernanceService?.({
      ...context,
      workspaceId,
      platform: process.platform,
      caseStore: policyCaseStore,
      adapter: runPolicyAdapter,
      runtimeDigest: () => runtimeDigest(ENGINE_PATHS),
      cli: ENGINE_PATHS.cli,
    }) ?? {
      ...Object.fromEntries(
        ['read', 'capture', 'preview', 'apply', 'recheck'].map((name) => [
          name,
          async () => ({ status: 503, body: { error: 'mcp-governance-unavailable' } }),
        ]),
      ),
      close: async () => {},
    };
  const unavailableNetwork = {
    read: async () => ({ status: 503, body: { error: 'codex-network-unavailable' } }),
    capture: async () => ({ status: 503, body: { error: 'codex-network-unavailable' } }),
    preview: async () => ({ status: 503, body: { error: 'codex-network-unavailable' } }),
    apply: async () => ({ status: 503, body: { error: 'codex-network-unavailable' } }),
    recheck: async () => ({ status: 503, body: { error: 'codex-network-unavailable' } }),
    start: async () => ({ status: 503, body: { error: 'codex-network-check-unavailable' } }),
    cancel: async () => ({ status: 503, body: { error: 'codex-network-check-unavailable' } }),
    close: async () => {},
  };
  const codexNetworkGuard =
    suppliedCodexNetworkGuard ??
    networkSchema?.createCodexNetworkGuardService?.({ inventory }) ??
    unavailableNetwork;
  const codexPathGuard = suppliedCodexPathGuard ??
    networkSchema?.createCodexPathGuardService?.({ inventory }) ?? {
      ...Object.fromEntries(
        ['read', 'capture', 'preview', 'apply', 'recheck'].map((name) => [
          name,
          async () => ({ status: 503, body: { error: 'codex-path-guard-unavailable' } }),
        ]),
      ),
      close: async () => {},
    };
  let codexNetworkChecks = suppliedCodexNetworkChecks;
  if (!codexNetworkChecks && typeof networkSchema?.createCodexNetworkCheckService === 'function') {
    const [p, u] = await Promise.all([lstat(selectedProject), lstat(selectedUserHome)]);
    const storeId = createHash('sha256')
      .update(
        JSON.stringify([
          'stroq-codex-network-checks/1',
          selectedProject,
          p.dev,
          p.ino,
          selectedUserHome,
          u.dev,
          u.ino,
          selectedHome,
          codexEnvironment.CODEX_HOME ?? null,
        ]),
      )
      .digest('hex');
    const store = await createRunStore({
      home: selectedHome,
      workspaceId: storeId,
      namespace: 'codex-network-checks',
      loadValidator: async () => ({
        validateRun: (job) =>
          networkSchema.validateCodexNetworkCheckJob(job) &&
          job.binding.workspaceId === workspaceId,
      }),
    });
    codexNetworkChecks = await networkSchema.createCodexNetworkCheckService({
      inventory,
      workspaceId,
      store,
      acquireLease: () =>
        acquireProtectionCheckLease({
          home: selectedHome,
          storeId: createHash('sha256')
            .update(
              JSON.stringify([
                'stroq-codex-network-check-lease/1',
                selectedProject,
                p.dev,
                p.ino,
                selectedUserHome,
                u.dev,
                u.ino,
                selectedHome,
              ]),
            )
            .digest('hex'),
        }),
      run: (input, extra) =>
        executeCodexNetworkCheck(input, {
          ...extra,
          adapterPath: runtimeLayout().adapter('hook-check-engine.js'),
          validateResult: networkSchema.validateCodexNetworkCheckResult,
          timeoutMs: 30000,
        }),
    });
  }
  codexNetworkChecks ??= unavailableNetwork;
  const quarantine = suppliedQuarantine ?? createSkillQuarantine(context);
  const credentialFilters =
    suppliedCredentialFilters ??
    createCredentialFilterService({
      ...context,
      claudeConfigDir:
        suppliedClaudeConfigDir ??
        (userHome === undefined ? (process.env.CLAUDE_CONFIG_DIR ?? '') : ''),
    });
  const mcp = suppliedMcp ?? createMcpContainmentService(context);
  const mcpToolContracts = suppliedMcpToolContracts ?? createMcpToolContractService(context);
  const mcpCallControls = suppliedMcpCallControls ?? (await createMcpCallControlService(context));
  const agents = suppliedAgents ?? (await createAgentStatus(context));
  const incidents = suppliedIncidents ?? createIncidentService(context);
  const incidentAssessments =
    suppliedIncidentAssessments ?? (await createIncidentAssessmentService(context));
  const live = suppliedLive ?? (await createLiveProofService(context));
  const hookChecks =
    suppliedHookChecks ?? (await createHookCheckService({ ...context, workspaceId }));
  const workspaceReview =
    suppliedWorkspaceReview ?? (await createWorkspaceReviewService({ ...context, workspaceId }));
  const workspaceTasks =
    suppliedWorkspaceTasks ??
    (await createWorkspaceTaskControl({ ...context, workspaceId, workspaceReview }));
  const workspaceMonitor =
    suppliedWorkspaceMonitor ??
    (await createWorkspaceMonitorControl({ ...context, workspaceId, workspaceReview }));
  const inventoryMonitor =
    suppliedInventoryMonitor ??
    (await createInventoryMonitorControl({
      ...context,
      workspaceId,
      inventory: {
        read: () =>
          typeof inventory.observe === 'function'
            ? inventory.observe()
            : Promise.resolve({ status: 503, body: { error: 'inventory-unavailable' } }),
      },
    }));
  const taskLocks =
    suppliedTaskLocks ??
    (await createTaskLockService({
      ...context,
      workspaceId,
      selectEvidence: (request) => incidents.selectForComparison(request),
    }));
  const sessionTaint =
    suppliedSessionTaint ??
    (await createSessionTaintControl({
      ...context,
      workspaceId,
      selectEvidence: (request) => incidents.selectForComparison(request),
    }));
  const secrets = suppliedSecrets ?? (await createSecretScanService(context));
  const taskAccess =
    suppliedTaskAccess ??
    (await createTaskAccessService({
      ...context,
      workspaceId,
      selectEvidence: (request) => incidents.selectForComparison(request),
    }));
  const comparisons =
    suppliedComparisons ??
    createIncidentRecheckService({
      home: selectedHome,
      selectEvidence: (request) => incidents.selectForComparison(request),
    });
  const policyCases = createPolicyCasesService({
    home: selectedHome,
    workspaceId,
    store: policyCaseStore,
    compare: (request) => comparisons.compare(request),
    evaluate: runPolicyCaseEvaluation,
  });
  const control =
    suppliedControl ?? (await createControl({ ...context, workspaceReview, policyCases }));
  let origin;
  const server = createServer(async (req, res) => {
    try {
      const site = req.headers['sec-fetch-site'];
      if (
        req.headers.host !== origin.slice('http://'.length) ||
        (req.headers.origin !== undefined && req.headers.origin !== origin) ||
        (site !== undefined && site !== 'same-origin' && site !== 'none')
      )
        return respond(res, 403, 'Request origin refused');
      const parsed = safePath(req.url);
      if (parsed === null) return respond(res, 400, 'Invalid path');
      if (parsed.path.startsWith('/api/')) {
        if (!authenticated(req, token))
          return respond(res, 401, 'Open the private console URL printed at startup');
        if (parsed.path === '/api/context') {
          if (req.method !== 'GET') return respond(res, 405, 'Context requires GET');
          const label =
            basename(selectedProject)
              .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
              .slice(0, 80) || 'Local workspace';
          const body = {
            schema: 'stroq-context/1',
            workspace: {
              id: workspaceId,
              label,
            },
            userScope: 'Current OS user',
            homeMode: selectedHome === join(selectedUserHome, '.stroq') ? 'default' : 'custom',
          };
          return respond(res, 200, JSON.stringify(body), 'application/json; charset=utf-8');
        }
        if (parsed.path === '/api/snapshot') {
          if (req.method !== 'GET') return respond(res, 405, 'Snapshot requires GET');
          const snapshot = await readLocalSnapshot({ home: selectedHome });
          return respond(res, 200, JSON.stringify(snapshot), 'application/json; charset=utf-8');
        }
        let response;
        if (
          parsed.path === '/api/agents' ||
          parsed.path.startsWith('/api/incidents') ||
          parsed.path.startsWith('/api/live') ||
          parsed.path.startsWith('/api/hook-checks') ||
          parsed.path.startsWith('/api/task-locks') ||
          parsed.path.startsWith('/api/workspace-review') ||
          parsed.path.startsWith('/api/secrets')
        ) {
          response = await routeOperational(req, parsed.path, origin, {
            agents,
            incidents,
            live,
            hookChecks,
            taskLocks,
            taskAccess,
            workspaceReview,
            secrets,
            comparisons,
          });
        } else if (parsed.path.startsWith('/api/codex-path-guard') && req.url.includes('?')) {
          response = { status: 404, body: { error: 'not-found' } };
        } else if (parsed.path === '/api/codex-path-guard') {
          response =
            req.method === 'GET'
              ? await codexPathGuard.read()
              : { status: 405, body: { error: 'method-not-allowed' } };
        } else if (
          /^\/api\/codex-path-guard\/(?:capture|preview|apply|recheck)$/.test(parsed.path)
        ) {
          response = await jsonAction(
            req,
            origin,
            (input) => codexPathGuard[parsed.parts.at(-1)](input),
            4096,
          );
        } else if (
          parsed.path === '/api/codex-network-guard' ||
          parsed.path === '/api/codex-network-checks'
        ) {
          response =
            req.method === 'GET'
              ? await (
                  parsed.path.endsWith('-guard') ? codexNetworkGuard : codexNetworkChecks
                ).read()
              : { status: 405, body: { error: 'method-not-allowed' } };
        } else if (
          /^\/api\/codex-network-guard\/(?:capture|preview|apply|recheck)$/.test(parsed.path)
        ) {
          response = await jsonAction(
            req,
            origin,
            (input) => codexNetworkGuard[parsed.parts.at(-1)](input),
            4096,
          );
        } else if (/^\/api\/codex-network-checks\/(?:preview|start|cancel)$/.test(parsed.path)) {
          response = await jsonAction(
            req,
            origin,
            (input) => codexNetworkChecks[parsed.parts.at(-1)](input),
            4096,
          );
        } else if (parsed.path.startsWith('/api/incident-assessments')) {
          response = await routeIncidentAssessments(req, parsed.path, origin, incidentAssessments);
        } else if (parsed.path.startsWith('/api/session-taint')) {
          response = await routeSessionTaint(req, parsed.path, origin, sessionTaint);
        } else if (parsed.path.startsWith('/api/workspace-task-controls')) {
          response = await routeWorkspaceTasks(req, parsed.path, origin, workspaceTasks);
        } else if (parsed.path.startsWith('/api/journal')) {
          response = await routeJournalView(req, parsed.path, origin, journalView);
        } else if (parsed.path.startsWith('/api/posture')) {
          response = await routePosture(req, parsed.path, origin, posture);
        } else if (parsed.path === '/api/threats') {
          response = await routeThreatFeed(req, parsed.path, origin, threatFeed);
        } else if (parsed.path.startsWith('/api/inventory-monitor')) {
          response = await routeInventoryMonitor(req, parsed.path, origin, inventoryMonitor);
        } else if (parsed.path.startsWith('/api/workspace-monitor')) {
          response = await routeWorkspaceMonitor(req, parsed.path, origin, workspaceMonitor);
        } else if (parsed.path.startsWith('/api/agent-setup')) {
          response = await routeAgentSetup(req, parsed.path, origin, setup);
        } else if (parsed.path.startsWith('/api/credential-filters')) {
          response = await routeCredentialFilters(req, parsed.path, origin, credentialFilters);
        } else if (parsed.path.startsWith('/api/mcp-call-controls')) {
          response = await routeMcpCallControls(req, parsed.path, origin, mcpCallControls);
        } else if (parsed.path.startsWith('/api/mcp-tool-contracts')) {
          response = await routeMcpToolContracts(req, parsed.path, origin, mcpToolContracts);
        } else if (parsed.path.startsWith('/api/mcp-containment')) {
          response = await routeMcpContainment(req, parsed.path, origin, mcp);
        } else if (parsed.path === '/api/quarantine') {
          response =
            req.method === 'GET'
              ? await quarantine.read()
              : { status: 405, body: { error: 'method-not-allowed' } };
        } else if (
          parsed.path === '/api/quarantine/preview' ||
          parsed.path === '/api/quarantine/apply'
        ) {
          response = await jsonAction(
            req,
            origin,
            (input) => quarantine[parsed.path.endsWith('/preview') ? 'preview' : 'apply'](input),
            4096,
          );
        } else if (parsed.path === '/api/inventory') {
          response =
            req.method === 'GET'
              ? await inventory.read()
              : { status: 405, body: { error: 'method-not-allowed' } };
        } else if (parsed.path === '/api/inventory/review') {
          response = await jsonAction(req, origin, (input) => inventory.review(input), 4096);
        } else if (parsed.path === '/api/inventory/codex-sources') {
          response = await jsonAction(req, origin, (input) => inventory.codexSources(input), 4096);
        } else if (parsed.path === '/api/inventory/codex-controls') {
          response =
            req.method === 'GET'
              ? await inventory.codexControlState({})
              : { status: 405, body: { error: 'method-not-allowed' } };
        } else if (parsed.path === '/api/inventory/codex-control-preview') {
          response = await jsonAction(
            req,
            origin,
            (input) => inventory.codexControlPreview(input),
            4096,
          );
        } else if (parsed.path === '/api/inventory/codex-control-apply') {
          response = await jsonAction(
            req,
            origin,
            (input) => inventory.codexControlApply(input),
            4096,
          );
        } else if (parsed.path === '/api/inventory/codex-control-recheck') {
          response = await jsonAction(
            req,
            origin,
            (input) => inventory.codexControlRecheck(input),
            4096,
          );
        } else if (parsed.path === '/api/inventory/inspect') {
          response = await jsonAction(req, origin, (input) => inventory.inspect(input), 4096);
        } else if (parsed.path === '/api/inventory/compare') {
          response = await jsonAction(req, origin, (input) => inventory.compare(input), 4096);
        } else if (parsed.path === '/api/inventory/signals/state') {
          response = await jsonAction(req, origin, (input) => inventory.signalState(input), 4096);
        } else if (parsed.path === '/api/inventory/signals/preview') {
          response = await jsonAction(req, origin, (input) => inventory.signalPreview(input), 4096);
        } else if (parsed.path === '/api/inventory/signals/apply') {
          response = await jsonAction(req, origin, (input) => inventory.signalApply(input), 4096);
        } else if (parsed.path === '/api/agent-disconnect') {
          response =
            req.method === 'GET'
              ? { status: 200, body: await disconnect.getState() }
              : { status: 405, body: { error: 'method-not-allowed' } };
        } else if (
          parsed.path === '/api/agent-disconnect/preview' ||
          parsed.path === '/api/agent-disconnect/apply'
        ) {
          response = await jsonAction(
            req,
            origin,
            (input) => disconnect[parsed.path.endsWith('/preview') ? 'preview' : 'apply'](input),
            4096,
          );
        } else if (parsed.path === '/api/mcp-governance') {
          response = req.url.includes('?')
            ? { status: 400, body: { error: 'invalid-request' } }
            : req.method === 'GET'
              ? await mcpGovernance.read()
              : { status: 405, body: { error: 'method-not-allowed' } };
        } else if (/^\/api\/mcp-governance\/(?:capture|preview|apply|recheck)$/.test(parsed.path)) {
          response = req.url.includes('?')
            ? { status: 400, body: { error: 'invalid-request' } }
            : await jsonAction(
                req,
                origin,
                (input) => mcpGovernance[parsed.path.split('/').at(-1)](input),
                16 * 1024,
                (text) => {
                  const parsed = networkSchema?.parsePolicyHistoryJson?.(text);
                  if (!parsed?.ok) throw Error('invalid-request');
                  const pending = [parsed.value];
                  while (pending.length) {
                    const value = pending.pop();
                    if (typeof value === 'string' && !value.isWellFormed())
                      throw Error('invalid-request');
                    if (value && typeof value === 'object') {
                      if (Object.keys(value).some((key) => !key.isWellFormed()))
                        throw Error('invalid-request');
                      pending.push(...Object.values(value));
                    }
                  }
                  return parsed.value;
                },
              );
        } else if (parsed.path === '/api/policy/cases') {
          response =
            req.method === 'GET'
              ? await policyCases.read()
              : { status: 405, body: { error: 'method-not-allowed' } };
        } else if (
          parsed.path === '/api/policy/cases/save' ||
          parsed.path === '/api/policy/cases/remove'
        ) {
          response = await jsonAction(
            req,
            origin,
            (input) => policyCases[parsed.path.endsWith('/save') ? 'save' : 'remove'](input),
            4096,
          );
        } else if (parsed.path === '/api/policy/history') {
          response =
            req.method === 'GET'
              ? await policyHistory.inspect()
              : { status: 405, body: { error: 'method-not-allowed' } };
        } else if (
          parsed.path === '/api/policy/restore/preview' ||
          parsed.path === '/api/policy/restore/apply'
        ) {
          response = await jsonAction(
            req,
            origin,
            (input) => policyHistory[parsed.path.endsWith('/preview') ? 'preview' : 'apply'](input),
            4096,
          );
        } else if (parsed.path === '/api/policy') {
          response =
            req.method === 'GET'
              ? await policy.inspect()
              : { status: 405, body: { error: 'method-not-allowed' } };
        } else if (parsed.path === '/api/policy/try') {
          response = await jsonAction(req, origin, (input) => policy.tryAction(input), 4096);
        } else if (parsed.path === '/api/policy/preview' || parsed.path === '/api/policy/apply') {
          const action = parsed.path.endsWith('/preview') ? 'preview' : 'apply';
          response = await jsonAction(req, origin, (input) => policy[action](input), 16 * 1024);
        } else {
          response = await routeControl(req, parsed.path, origin, control);
        }
        return respond(
          res,
          response.status,
          JSON.stringify(response.body),
          'application/json; charset=utf-8',
        );
      }
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return respond(res, 405, 'Method not allowed');
      const file = await staticFile(staticRoot, parsed.parts);
      if (!file) return respond(res, 404, 'Not found');
      return respond(res, 200, req.method === 'HEAD' ? undefined : file.bytes, file.type);
    } catch {
      respond(res, 500, 'Console could not read the requested data');
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolveListen();
    });
  });
  await workspaceMonitor.start();
  await inventoryMonitor.start();
  const journalView =
    suppliedJournalView ?? (await createJournalViewService({ home: selectedHome }));
  const posture =
    suppliedPosture ??
    (await createPostureService({
      userHome: selectedUserHome,
      project: selectedProject,
      codexHome: process.env.CODEX_HOME ?? null,
    }));
  // Downloads pwn.watch's list only when the page asks, which it does only once you turn the feed on.
  const threatFeed =
    suppliedThreatFeed ??
    (await createThreatFeedService({
      userHome: selectedUserHome,
      project: selectedProject,
      codexHome: process.env.CODEX_HOME ?? null,
    }));
  return {
    server,
    token,
    url: `${origin}/#token=${token}`,
    close: async () => {
      await workspaceMonitor.close();
      await inventoryMonitor.close();
      await Promise.allSettled(
        [
          control,
          setup,
          disconnect,
          policy,
          policyHistory,
          mcpGovernance,
          inventory,
          codexNetworkGuard,
          codexPathGuard,
          codexNetworkChecks,
          quarantine,
          credentialFilters,
          mcp,
          mcpToolContracts,
          mcpCallControls,
          agents,
          incidents,
          incidentAssessments,
          live,
          hookChecks,
          taskLocks,
          taskAccess,
          workspaceReview,
          workspaceTasks,
          sessionTaint,
          secrets,
          comparisons,
          policyCases,
          journalView,
          posture,
          threatFeed,
        ].map((service) => Promise.resolve().then(() => service.close())),
      );
      return new Promise((resolveClose, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const port =
      process.env.STROQ_CONSOLE_PORT === undefined ? 47815 : Number(process.env.STROQ_CONSOLE_PORT);
    const app = await startServer({ port });
    // The fragment is never sent in an HTTP request. This is the only token log.
    console.log(`Stroq console — private local preview\n${app.url}`);
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, async () => {
        await app.close();
        process.exit(0);
      });
  } catch {
    console.error(
      'Could not start the local console. Build it first and check that its loopback port is available.',
    );
    process.exitCode = 1;
  }
}
