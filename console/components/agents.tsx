import Link from 'next/link';
import { AGENTS, CHECK_NAMES } from '@/lib/data';
import { GUARD_HELP, STATUS, type Check } from '@/lib/status';
import { CopyCommand } from './copy-command';
import { HelpPopover } from './help-popover';
import { StatusSquare } from './status-square';

/** One line per agent: is each one really guarded? */
export function AgentStrip() {
  return (
    <ul className="grid grid-cols-2 border-y border-border md:grid-cols-4">
      {AGENTS.map((agent) => (
        <li key={agent.id}>
          <Link
            href={`/agents/#${agent.id}`}
            className="flex h-full items-center gap-3 rounded-sm px-2.5 py-3.5 transition-colors duration-150 hover:bg-accent"
          >
            <StatusSquare kind={agent.state} decorative />
            <span className="min-w-0">
              <span className="block truncate font-semibold">{agent.name}</span>
              <span className="block text-[13px] text-ink-3">{STATUS[agent.state].label}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const LEGEND: readonly Check[] = ['yes', 'no', 'notyet', 'na'];

/** The four checks behind each verdict. On a phone only the verdict and the next step remain. */
export function AgentsMatrix() {
  const head =
    'border-b border-border px-2.5 pb-2.5 align-bottom text-xs font-medium leading-4 text-ink-3';
  const cell = 'border-b border-border px-2.5 py-3.5 align-middle';
  return (
    <>
      <div
        tabIndex={0}
        role="region"
        aria-label="Agent checks"
        className="overflow-x-auto outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th scope="col" className={`${head} text-left`}>
                Agent
              </th>
              {CHECK_NAMES.map((name) => (
                <th key={name} scope="col" className={`${head} hidden text-center sm:table-cell`}>
                  {name}
                </th>
              ))}
              <th scope="col" className={`${head} text-left`}>
                <span className="inline-flex items-center gap-0.5">
                  Result <HelpPopover label="What the agent states mean" items={GUARD_HELP} />
                </span>
              </th>
              <th scope="col" className={`${head} text-left`}>
                Next step
              </th>
            </tr>
          </thead>
          <tbody>
            {AGENTS.map((agent) => (
              <tr key={agent.id} id={agent.id} className="scroll-mt-6 target:bg-accent">
                <th scope="row" className={`${cell} text-left font-normal`}>
                  <span className="block font-semibold">{agent.name}</span>
                  <span className="block text-xs text-ink-3">{agent.version}</span>
                </th>
                {agent.checks.map((check, i) => (
                  <td key={CHECK_NAMES[i]} className={`${cell} hidden text-center sm:table-cell`}>
                    <StatusSquare kind={check} className="align-middle" />
                  </td>
                ))}
                <td className={`${cell} whitespace-nowrap`}>
                  <span className="inline-flex items-center gap-2 font-semibold">
                    <StatusSquare kind={agent.state} decorative />
                    {STATUS[agent.state].label}
                  </span>
                </td>
                <td className={`${cell} min-w-[150px] sm:min-w-[240px]`}>
                  {agent.next === undefined ? (
                    <span className="text-ink-3">Nothing</span>
                  ) : (
                    <CopyCommand command={agent.next} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 hidden flex-wrap items-center gap-1.5 text-xs text-ink-3 sm:flex">
        {LEGEND.map((check) => (
          <span key={check} className="mr-2 inline-flex items-center gap-1.5">
            <StatusSquare kind={check} size="sm" decorative />
            {STATUS[check].label.toLowerCase()}
          </span>
        ))}
      </p>
    </>
  );
}
