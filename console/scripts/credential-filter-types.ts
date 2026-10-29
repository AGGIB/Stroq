import type { CredentialFilterRow, CredentialFilterReason } from '../lib/credential-filters.ts';

export interface CredentialResolverOptions {
  project: string;
  userHome: string;
  home: string;
  platform: NodeJS.Platform;
  claudeConfigDir?: string;
}
export interface CredentialRoot {
  path: string;
  dev: string;
  ino: string;
  uid: string;
  mode: number;
}
export interface CredentialTarget extends Pick<
  CredentialFilterRow,
  'id' | 'recipe' | 'agent' | 'scope' | 'target' | 'required' | 'location' | 'context'
> {
  root: string;
  file: string;
  reason: CredentialFilterReason | null;
}
export interface CredentialResolution {
  roots: { project: CredentialRoot; user: CredentialRoot; home: string };
  workspaceId: string;
  facts: readonly Readonly<Record<string, string | number>>[];
  targets: CredentialTarget[];
}
