import { Terminal } from 'lucide-react';

// Unmodified vendor assets. Provenance is in public/brands/SOURCES.txt.
const ASSETS: ReadonlyMap<string, { light: string; dark?: string }> = new Map([
  ['Claude Code', { light: '/brands/claude.png' }],
  ['Cursor', { light: '/brands/cursor-light.svg', dark: '/brands/cursor-dark.svg' }],
  ['Windsurf', { light: '/brands/windsurf-light.svg', dark: '/brands/windsurf-dark.svg' }],
  ['Codex CLI', { light: '/brands/codex-light.png', dark: '/brands/codex-dark.png' }],
]);

/** Decorative mark: the adjacent agent name supplies the accessible label. */
export function AgentBrand({ name, size = 24 }: { name: string; size?: number }) {
  const asset = ASSETS.get(name);
  if (!asset) return <Terminal size={size} strokeWidth={1.7} aria-hidden="true" />;
  return (
    <span className="agent-brand" aria-hidden="true">
      <img
        src={asset.light}
        alt=""
        width={size}
        height={size}
        className={asset.dark ? 'brand-light' : undefined}
      />
      {asset.dark && (
        <img src={asset.dark} alt="" width={size} height={size} className="brand-dark" />
      )}
    </span>
  );
}
