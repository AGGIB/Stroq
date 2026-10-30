'use client';

import { Search } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { AGENTS, CALLS, TODAY_COUNTS, TODAY_TOTAL, dayLabel } from '@/lib/data';
import {
  NO_FILTER,
  filterCalls,
  filterToSearch,
  groupByDay,
  parseFilter,
  toAgentFilter,
  toDecisionFilter,
  type CallFilter,
} from '@/lib/filter';
import { DECISION_HELP, STATUS, type Decision } from '@/lib/status';
import { HelpPopover } from './help-popover';
import { ActionRow, RowList } from './rows';

const DOT: Readonly<Record<Decision, string>> = {
  block: 'bg-st-red',
  ask: 'bg-st-amber',
  flag: 'shadow-[inset_0_0_0_1.5px_var(--st-amber)]',
  allow: 'bg-st-green',
  nj: 'bg-hairline-strong',
};
const CHIP_ORDER: readonly Decision[] = ['block', 'ask', 'flag', 'allow', 'nj'];
const CHIP_LABEL: Readonly<Record<Decision, string>> = {
  block: 'Blocked',
  ask: 'Asked',
  flag: 'Flagged',
  allow: 'Allowed',
  nj: 'Not judged',
};

/** The full feed with working filters. The filter lives in the address, so a view can be shared. */
export function ActivityFeed() {
  const params = useSearchParams();
  const pathname = usePathname();
  const urlFilter = parseFilter(params);

  // The search box keeps its own draft so typing never waits for the address. When the address
  // changes by itself (a sidebar click, the back button), the draft follows it.
  const [draft, setDraft] = useState(urlFilter.query);
  const [seenUrlQuery, setSeenUrlQuery] = useState(urlFilter.query);
  if (seenUrlQuery !== urlFilter.query) {
    setSeenUrlQuery(urlFilter.query);
    if (urlFilter.query !== draft.trim()) setDraft(urlFilter.query);
  }

  // Next follows history.replaceState in useSearchParams. Reading the address at the moment of
  // the change means a chip click during a keystroke cannot overwrite it with an older value.
  function apply(patch: Partial<CallFilter>) {
    const current = parseFilter(new URLSearchParams(window.location.search));
    window.history.replaceState(null, '', `${pathname}${filterToSearch({ ...current, ...patch })}`);
  }

  const shown = filterCalls(CALLS, { ...urlFilter, query: draft });
  const filtered = urlFilter.decision !== 'all' || urlFilter.agent !== 'all' || draft.trim() !== '';

  return (
    <>
      <div className="mb-1 mt-8 flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          value={urlFilter.decision}
          onValueChange={(value) => apply({ decision: toDecisionFilter(value) })}
          aria-label="Decision"
          className="flex-wrap gap-0.5"
        >
          <ToggleGroupItem
            value="all"
            className="h-[30px] rounded-md px-2.5 text-[13px] font-medium text-ink-2 data-[state=on]:text-foreground"
          >
            All <span className="font-normal tabular-nums text-ink-3">{TODAY_TOTAL}</span>
          </ToggleGroupItem>
          {CHIP_ORDER.map((decision) => (
            <ToggleGroupItem
              key={decision}
              value={decision}
              aria-label={`${STATUS[decision].label}: ${TODAY_COUNTS[decision]}`}
              className="h-[30px] gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-ink-2 data-[state=on]:text-foreground"
            >
              <i aria-hidden="true" className={`size-2 rounded-[2px] ${DOT[decision]}`} />
              {CHIP_LABEL[decision]}{' '}
              <span className="font-normal tabular-nums text-ink-3">{TODAY_COUNTS[decision]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <HelpPopover label="What the decisions mean" items={DECISION_HELP} />
        <span className="hidden flex-1 sm:block" />
        <Select
          value={urlFilter.agent}
          onValueChange={(value) => apply({ agent: toAgentFilter(value) })}
        >
          <SelectTrigger size="sm" aria-label="Agent" className="w-[9.5rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {AGENTS.map((agent) => (
              <SelectItem key={agent.id} value={agent.name}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="relative flex-1 sm:flex-none">
          <span className="sr-only">Filter by command, file or host</span>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3"
          />
          <Input
            type="search"
            value={draft}
            maxLength={200}
            placeholder="Command, file or host"
            onChange={(event) => {
              setDraft(event.target.value);
              apply({ query: event.target.value });
            }}
            className="h-8 w-full pl-8 text-[13px] sm:w-56"
          />
        </label>
      </div>

      {shown.length === 0 ? (
        <div className="border-y border-border px-2.5 py-10 text-center text-ink-2">
          <p>Nothing here matches.</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => {
              setDraft('');
              apply(NO_FILTER);
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <RowList>
          {groupByDay(shown).map((group) => (
            <li key={group.date} className="contents">
              <span className="block border-b border-border px-2.5 pb-2 pt-4 text-xs font-semibold text-ink-3">
                {dayLabel(group.date)}
              </span>
              <ul>
                {group.calls.map((call) => (
                  <ActionRow key={call.id} call={call} />
                ))}
              </ul>
            </li>
          ))}
        </RowList>
      )}

      <p className="px-2.5 pt-3.5 text-[13px] text-ink-3">
        {filtered ? `${shown.length} shown` : `${shown.length} of ${TODAY_TOTAL}`}
      </p>
    </>
  );
}

/** What the page shows before the address is read: the unfiltered feed, no controls. */
export function ActivityFeedFallback() {
  return (
    <RowList className="mt-[76px]">
      {CALLS.map((call) => (
        <ActionRow key={call.id} call={call} />
      ))}
    </RowList>
  );
}
