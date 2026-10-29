import { Folder } from 'lucide-react';
import { AgentGlyph, Badge } from '@/components/platform-ui';
import { INVENTORY_AGENTS, type InventoryItem } from '@/lib/inventory';
import { SKILL_SOURCES, skillSourceOf, type SkillSourceCoverage } from '@/lib/skill-sources';
import { validateSkillLocation } from '@/lib/skill-location';

type SourceItem = Pick<
  InventoryItem,
  'id' | 'kind' | 'agent' | 'scope' | 'skillSource' | 'location'
>;
const locationLabel = (item: SourceItem) =>
  validateSkillLocation(item.location)
    ? `${item.location.label}${item.location.redacted ? ` · ${item.id.slice(-8)}` : ''}`
    : null;

export function inventorySourceSearchText(item: InventoryItem) {
  const id = skillSourceOf(item);
  const source = id ? SKILL_SOURCES[id] : null;
  return [
    item.name,
    INVENTORY_AGENTS[item.agent],
    source?.label,
    source && (item.scope === 'project' ? source.projectLabel : source.userLabel),
    locationLabel(item),
  ].join(' ');
}

export function inventorySourceLabel(item: SourceItem) {
  const id = skillSourceOf(item);
  const source = id ? SKILL_SOURCES[id] : null;
  const label = source
    ? item.scope === 'project'
      ? source.projectLabel
      : source.userLabel
    : (INVENTORY_AGENTS[item.agent] ?? 'Source unavailable');
  return `${label} · ${item.scope === 'project' ? 'Workspace' : 'User'}${locationLabel(item) ? ` · ${locationLabel(item)}` : ''}`;
}

/** A filesystem origin does not identify a running or loaded host. */
export function InventorySource({ item }: { item: SourceItem }) {
  const id = skillSourceOf(item);
  const source = id ? SKILL_SOURCES[id] : null;
  const shared = item.agent === 'shared';
  const devin = id === 'devin-skills';
  const label = shared ? 'Shared source' : devin ? 'Devin' : INVENTORY_AGENTS[item.agent];
  const brand =
    item.agent === 'claude-desktop' ? 'Claude Code' : item.agent === 'codex' ? 'Codex CLI' : label;
  return (
    <span className="inventory-origin">
      <span className="inventory-agent">
        {shared || devin || !brand ? (
          <Folder size={20} aria-hidden="true" />
        ) : (
          <AgentGlyph name={brand} />
        )}
        {label ?? 'Source unavailable'}
      </span>
      {source ? (
        <code>{item.scope === 'project' ? source.projectLabel : source.userLabel}</code>
      ) : item.kind === 'skill' ? (
        <small>Source unavailable</small>
      ) : null}
      {item.kind === 'skill' && locationLabel(item) && (
        <code className="inventory-location">{locationLabel(item)}</code>
      )}
    </span>
  );
}

const COVERAGE_LABELS = { complete: 'Read', absent: 'Absent', partial: 'Partial' } as const;
export function InventorySourceCoverage({ sources }: { sources?: SkillSourceCoverage[] }) {
  if (!sources?.length)
    return <p className="control-meta">Source coverage unavailable for this capture.</p>;
  return (
    <section className="inventory-source-coverage" aria-label="Skill source coverage">
      <h3>Skill source folders</h3>
      <ul>
        {sources.map((entry) => {
          const source = SKILL_SOURCES[entry.id];
          return (
            <li className="inventory-source-coverage-row" key={`${entry.id}:${entry.scope}`}>
              <span>
                <code>{entry.scope === 'project' ? source.projectLabel : source.userLabel}</code>
                <small>
                  {entry.scope === 'project' ? 'Workspace' : 'User'} · {entry.candidates}{' '}
                  {entry.candidates === 1 ? 'candidate' : 'candidates'}
                </small>
              </span>
              <Badge tone={entry.status === 'partial' ? 'orange' : 'muted'}>
                {COVERAGE_LABELS[entry.status]}
              </Badge>
            </li>
          );
        })}
      </ul>
      <p className="control-meta">
        Fixed source folders; this does not establish which skills an agent loaded.
      </p>
      <p className="control-meta">
        Ancestor folders, plugin caches, system roots and custom homes are outside this inspection.
      </p>
    </section>
  );
}
