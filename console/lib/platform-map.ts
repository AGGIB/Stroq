/**
 * One map of the console: every page, the group it sits in, when to open it and what to read on it.
 * The sidebar groups its links by it and the Guide page prints it, so the two cannot drift apart.
 * The words describe what each page shows; none of them says a page blocks, secures or protects.
 */

export const PLATFORM_SECTIONS = [
  { id: 'daily', label: 'Every day', hint: 'Look here first.' },
  { id: 'setup', label: 'Set up', hint: 'Once per agent, and again after you change something.' },
  { id: 'review', label: 'When you need it', hint: 'Open these when you have a reason to.' },
] as const;

export type PlatformSectionId = (typeof PLATFORM_SECTIONS)[number]['id'];

export interface PlatformPage {
  readonly href: string;
  readonly label: string;
  readonly section: PlatformSectionId;
  /** When to open it, in one sentence. */
  readonly when: string;
  /** What to read once it is open, in one sentence. */
  readonly read: string;
}

export const PLATFORM_PAGES: readonly PlatformPage[] = [
  {
    href: '/',
    label: 'Protection',
    section: 'daily',
    when: 'Start here, every time.',
    read: 'The answer at the top: which agents Stroq is asked about, then the list of what needs you.',
  },
  {
    href: '/live/',
    label: 'Live',
    section: 'daily',
    when: 'While an agent is working, or right after.',
    read: 'Denied and flagged rows. Leave it open and turn on notifications to hear about them.',
  },
  {
    href: '/activity/',
    label: 'Activity',
    section: 'daily',
    when: 'To find a decision from earlier.',
    read: 'Pick Deny or Needs review, then open a row to see what the agent read and what Stroq decided.',
  },
  {
    href: '/agents/',
    label: 'Agents & coverage',
    section: 'setup',
    when: 'Once for each agent you use, and after you update one.',
    read: 'One state per agent. Configure connects it; Test hook checks the hook without running the agent.',
  },
  {
    href: '/posture/',
    label: 'Settings check',
    section: 'setup',
    when: 'After you clone a repository or change an agent’s settings.',
    read: 'Critical and high findings first, and any file that could not be checked.',
  },
  {
    href: '/policies/',
    label: 'Policies',
    section: 'setup',
    when: 'When a decision is wrong for your work.',
    read: 'The rules Stroq applies, the checks they pass, and their history. Rules are changed here.',
  },
  {
    href: '/try/',
    label: 'Try an action',
    section: 'setup',
    when: 'Before you change a rule, or to see what a command would get.',
    read: 'Two answers for what you type: in a clean session, and after the agent read untrusted text.',
  },
  {
    href: '/skills/',
    label: 'Skills & MCP',
    section: 'review',
    when: 'Before you trust a new skill or MCP server, or when one changed.',
    read: 'Items awaiting review and items changed since you reviewed them.',
  },
  {
    href: '/incidents/',
    label: 'Investigations',
    section: 'review',
    when: 'When a session did something you did not expect.',
    read: 'Recorded denies, approval requests and content findings, and the evidence behind each.',
  },
  {
    href: '/sessions/',
    label: 'Sessions',
    section: 'review',
    when: 'To see one agent session from start to end.',
    read: 'Each session with its events and how often Stroq stepped in.',
  },
  {
    href: '/keys/',
    label: 'Secret exposure',
    section: 'review',
    when: 'When you think a key or token was sent somewhere.',
    read: 'Where each secret appeared, and what Stroq recorded for it.',
  },
  {
    href: '/overview/',
    label: 'Activity overview',
    section: 'review',
    when: 'For a look back over a week or a month.',
    read: 'Counts and one chart for the period you pick.',
  },
];

/** Plain meanings of the words the console uses for decisions and states. */
export const PLATFORM_WORDS: readonly { readonly word: string; readonly meaning: string }[] = [
  { word: 'Allowed', meaning: 'Stroq’s policy let the action run.' },
  { word: 'Asked you', meaning: 'Stroq’s policy asked for a person to confirm the action.' },
  {
    word: 'Denied',
    meaning:
      'Stroq’s policy refused the action. The agent’s host is expected to refuse it too; Stroq does not see whether it did.',
  },
  {
    word: 'Flagged',
    meaning:
      'Something the agent read looked like an instruction to it, and Stroq recorded that for the session.',
  },
  {
    word: 'Connected',
    meaning:
      'Stroq’s hooks are in the agent’s settings. That is not proof the agent calls them; Test hook and Live show that.',
  },
  {
    word: 'Not seen yet',
    meaning: 'The hooks are in place, but Stroq has not been asked about any action yet.',
  },
  {
    word: 'Recorded',
    meaning:
      'Written to the audit journal on this machine. Not proof that a host stopped anything.',
  },
];

export function pagesIn(section: PlatformSectionId): readonly PlatformPage[] {
  return PLATFORM_PAGES.filter((page) => page.section === section);
}
