import type { Scenario } from '../scenario.js';
import { drizzleForcePush, parentDirWipe, rmRfHome } from './destructive.js';
import {
  envDumpExfil,
  roguepilotSchemaUrl,
  s1ngularityPublicRepo,
  tokenInMcpComment,
} from './exfiltration.js';
import {
  fetchedPageSshKeyUpload,
  readmePipeToShell,
  sentryAgentjacking,
  settingsHookRemoval,
  skillBase64Installer,
} from './injection.js';

/** The launch suite, in id order. Each scenario cites the public incident it models. */
export const SCENARIOS: readonly Scenario[] = [
  readmePipeToShell,
  sentryAgentjacking,
  tokenInMcpComment,
  s1ngularityPublicRepo,
  roguepilotSchemaUrl,
  envDumpExfil,
  settingsHookRemoval,
  rmRfHome,
  drizzleForcePush,
  skillBase64Installer,
  fetchedPageSshKeyUpload,
  parentDirWipe,
];
