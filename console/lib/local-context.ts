import { closed, member, text } from './local-guards';
export interface LocalContext {
  schema: 'stroq-context/1';
  workspace: { id: string; label: string };
  userScope: 'Current OS user';
  homeMode: 'default' | 'custom';
}
export function validateLocalContext(v: unknown): v is LocalContext {
  return (
    closed(v, ['schema', 'workspace', 'userScope', 'homeMode']) &&
    v.schema === 'stroq-context/1' &&
    closed(v.workspace, ['id', 'label']) &&
    typeof v.workspace.id === 'string' &&
    /^workspace-[a-f0-9]{24}$/.test(v.workspace.id) &&
    text(v.workspace.label, 80) &&
    v.userScope === 'Current OS user' &&
    member(v.homeMode, ['default', 'custom'])
  );
}
