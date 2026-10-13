// Which hosts a live protection check (`stroq prove`) can be run against.
//
// "Headless" means a host can be started with a prompt and no person, with Stroq's hook in the loop,
// and report what it did. Only then can a probe be handed to the model and the result read afterwards.
//
// WHAT THIS TABLE IS: assumptions, until a live run has measured them. Recorded driver fixtures document
// the measured versions: Claude Code 2.1.271 and Codex CLI 0.162.1. Other rows remain expectations,
// and the reason given for a host that is not headless is what is believed of it. A measured version
// does not establish the behavior of other versions or the loading of the user's installed hooks.
//
// The ids are the agent ids the rest of the code uses (`SELF_CHECK_AGENTS` in `init-selfcheck.ts` and the
// rows of the hook section of `doctor.ts`); `capabilities.test.ts` fails when one of them is missing.

export interface HostCapability {
  /** True when a live check can drive this host. */
  readonly headless: boolean;
  /** Why not, when `headless` is false. The words `stroq doctor` and `stroq prove` print. */
  readonly reason?: string;
  /**
   * What a result from this host does not show, as short codes. They are copied into the result, so
   * that whoever reads it later reads them too.
   */
  readonly caveats: readonly string[];
  /**
   * True for a check that is run with no host at all (the MCP proxy, against a server of ours): there is
   * no host version to know, so a missing one is not a reason to doubt that a stored check still applies.
   */
  readonly hostFree?: boolean;
}

/** What the table says of a host it has no headless mode for: none has been shown to work, not that none can. */
const NO_HEADLESS_HOOKS = 'no verified headless hook mode';

const entry = (capability: HostCapability): HostCapability =>
  Object.freeze({ ...capability, caveats: Object.freeze([...capability.caveats]) });

export const HOST_CAPABILITIES: Readonly<Record<string, HostCapability>> = Object.freeze({
  'claude-code': entry({ headless: true, caveats: [] }),
  // MEASURED on Codex CLI 0.162.1, Windows (2026-10-13): three allow/deny/control requests verified
  // the supplied inline hook. Hook trust and the sandbox were bypassed in both real and control runs;
  // this establishes hook enforcement, not ordinary-session loading or sandbox protection.
  codex: entry({ headless: true, caveats: ['hook-trust-bypassed', 'sandbox-disabled'] }),
  cursor: entry({ headless: false, reason: NO_HEADLESS_HOOKS, caveats: [] }),
  windsurf: entry({ headless: false, reason: NO_HEADLESS_HOOKS, caveats: [] }),
  antigravity: entry({ headless: false, reason: NO_HEADLESS_HOOKS, caveats: [] }),
  copilot: entry({ headless: false, reason: NO_HEADLESS_HOOKS, caveats: [] }),
  openclaw: entry({
    headless: false,
    reason: 'enforced inside the Gateway process; use the manual --prompt flow',
    caveats: [],
  }),
  // The MCP proxy needs no host: a real `stroq mcp` is run against a generated stdio server, so what
  // is shown is the proxy's own enforcement and not that of any client that would call it. There is no
  // host, so no host version to know.
  mcp: entry({ headless: true, hostFree: true, caveats: ['host-free proxy check'] }),
});

/** The entry of `agent`, or undefined for a name that is not in the table (and not an inherited one). */
export function capabilitiesFor(agent: string): HostCapability | undefined {
  return Object.hasOwn(HOST_CAPABILITIES, agent) ? HOST_CAPABILITIES[agent] : undefined;
}
