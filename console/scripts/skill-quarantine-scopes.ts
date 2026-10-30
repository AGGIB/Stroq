/** Call only after both roots have been canonicalized with realpath. */
export function skillScopes(project: string, userHome: string): readonly ('project' | 'user')[] {
  // A home opened as a workspace still contains the shared personal installation.
  return project === userHome ? ['user'] : ['project', 'user'];
}
