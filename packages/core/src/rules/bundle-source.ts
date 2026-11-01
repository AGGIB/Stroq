import bundleJson from '../rules.bundle.json' with { type: 'json' };

/**
 * The rule bundle, as parsed JSON.
 *
 * From source it is the whole `rules.bundle.json`. The CLI's build swaps this module for one that
 * reads the cut-down bundle (`runtime-rule.ts`) from a file beside the code, when the rules are first
 * needed and not before (`packages/cli/tsup.config.ts`): a PreToolUse call never needs them, and
 * 900 KB of JSON inside the code was read, checked and evaluated by every hook call all the same.
 */
export const bundledRulesJson = (): unknown => bundleJson;
