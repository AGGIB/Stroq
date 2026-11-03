/**
 * One map of the console: its five screens, in the order the menu lists them, when to open each and
 * what to read on it. The words describe what each screen shows; none of them says a screen blocks,
 * secures or protects. Addresses of the older console that moved into these screens are in
 * `scripts/console-redirects.mjs`.
 */

export interface PlatformPage {
  readonly href: string;
  readonly label: string;
  /** When to open it, in one sentence. */
  readonly when: string;
  /** What to read once it is open, in one sentence. */
  readonly read: string;
}

export const PLATFORM_PAGES: readonly PlatformPage[] = [
  {
    href: '/',
    label: 'Check',
    when: 'Start here, every time.',
    read: 'What your agents did in the last days: commands a text told them to run, keys that left this machine, and folders that run code when an agent opens them.',
  },
  {
    href: '/live/',
    label: 'Live',
    when: 'While an agent is working, or right after.',
    read: 'Every recorded decision, newest first. Open a row to see what the agent read, what it did and which rule decided.',
  },
  {
    href: '/agents/',
    label: 'Agents',
    when: 'Once for each agent you use, and after you update one.',
    read: 'Whether each agent has Stroq’s hooks, when Stroq was last asked, and which of its settings weaken them.',
  },
  {
    href: '/policies/',
    label: 'Rules',
    when: 'When a decision is wrong for your work, or before you change a rule.',
    read: 'What a command would get, the rules you can turn on or off, their history and the rules reference.',
  },
  {
    href: '/skills/',
    label: 'Skills & MCP',
    when: 'Before you trust a new skill or MCP server, or when one changed.',
    read: 'Every skill and MCP server by agent, where it came from, and what changed since you last looked.',
  },
];
