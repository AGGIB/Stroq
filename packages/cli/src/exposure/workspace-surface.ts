import { agentSurface, type AgentSurface } from './agent-tree.js';
import { folderSurface, repoSurface, type RepoSurface } from './repo-surface.js';
import { resolveGitMetadata } from './surface-git-metadata.js';
import {
  SurfaceCapture,
  recheckWorkspaceSurface,
  surfaceHash,
  type SurfaceBinding,
  type SurfaceExclusion,
  type SurfaceLimits,
  type SurfaceObservation,
  type SurfaceSource,
} from './surface-capture.js';
export { recheckWorkspaceSurface };
export type { SurfaceBinding, SurfaceExclusion, SurfaceLimits, SurfaceObservation, SurfaceSource };
export const WORKSPACE_SURFACE_PROFILE = 'stroq-workspace-surface/1';
export interface WorkspaceSurfaceCapture {
  profile: typeof WORKSPACE_SURFACE_PROFILE;
  repo: RepoSurface;
  agent: AgentSurface;
  sources: SurfaceSource[];
  exclusions: SurfaceExclusion[];
  observations: SurfaceObservation[];
  manifestSha256: string;
  privateBinding: SurfaceBinding;
  complete: boolean;
}

/** A read-only current-folder capture. It executes neither Git nor repository programs. */
export function captureWorkspaceSurface(options: {
  project: string;
  workspaceId?: string;
  limits?: SurfaceLimits;
  deadline?: number;
  ignoredRoots?: readonly string[];
}): WorkspaceSurfaceCapture {
  const context = new SurfaceCapture(
    options.project,
    options.limits,
    options.deadline,
    options.ignoredRoots,
  );
  resolveGitMetadata(context);
  const registered = repoSurface(context.root, process.platform, context);
  const repo = registered.isRepo ? registered : folderSurface(context.root, context);
  const agent = agentSurface(context.root, context);
  for (const hit of agent.hits)
    if (hit.kind === 'config-link-outside')
      context.gap('outside-root', `${context.root}/${hit.file}`);
  for (const hit of agent.hits)
    if (hit.kind === 'unreadable-config')
      context.gap('unparsed', hit.file.startsWith('/') ? hit.file : `${context.root}/${hit.file}`);
  if (repo.capped || agent.capped) context.gap('limit', context.root);
  for (const hit of [...repo.preTrust, ...repo.onOpen, ...agent.hits]) {
    const path = hit.file.startsWith('git-metadata/') ? null : `${context.root}/${hit.file}`;
    if (path !== null) context.captureStructure(path);
  }
  const privateBinding = context.binding();
  if (!recheckWorkspaceSurface(privateBinding)) context.gap('source-changed', context.root);
  const byJSON = <T>(a: T, b: T) => JSON.stringify(a).localeCompare(JSON.stringify(b));
  const sources = [...context.sources].sort(byJSON);
  const observations = [...context.observations].sort(byJSON);
  // Keyed display digests and volatile filesystem pins are deliberately excluded.
  const semantic = {
    profile: WORKSPACE_SURFACE_PROFILE,
    platform: process.platform,
    isRepo: repo.isRepo,
    sources,
    exclusions: context.exclusions,
    observations,
    repo: { preTrust: repo.preTrust, onOpen: repo.onOpen, capped: repo.capped },
    agent: { capped: agent.capped, hits: agent.hits.map(({ shown: _shown, ...hit }) => hit) },
  };
  return {
    profile: WORKSPACE_SURFACE_PROFILE,
    repo,
    agent,
    sources,
    exclusions: context.exclusions,
    observations,
    manifestSha256: surfaceHash(JSON.stringify(semantic)),
    privateBinding,
    complete: observations.length === 0 && !repo.capped && !agent.capped,
  };
}
