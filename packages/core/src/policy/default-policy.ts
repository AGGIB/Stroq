import type { Policy } from './policy-types.js';

export const DEFAULT_POLICY: Policy = {
  version: 1,
  threshold: 0.6,
  default: 'allow',
  rules: [
    {
      id: 'deny-self-tamper',
      effect: 'deny',
      reason: 'Modifying agent security configuration is blocked',
      when: { classes: ['config.self'], taint: 'any' },
    },
    {
      id: 'ask-self-touch',
      effect: 'ask',
      reason: 'Command references agent security configuration; confirm',
      when: { classes: ['config.self_touch'], taint: 'any' },
    },
    {
      id: 'deny-encoded-exec',
      effect: 'deny',
      reason: 'Executing decoded or remotely fetched code is blocked',
      when: { classes: ['shell.exec_encoded'], taint: 'any' },
    },
    {
      id: 'deny-network-when-tainted',
      effect: 'deny',
      reason: 'Session is tainted by suspicious content; outbound network command blocked',
      when: { classes: ['shell.network'], taint: 'suspect' },
    },
    {
      id: 'deny-fetch-when-tainted',
      effect: 'deny',
      reason: 'Session is tainted by suspicious content; web fetch blocked',
      when: { classes: ['network.fetch'], taint: 'suspect' },
    },
    {
      id: 'deny-secrets-when-tainted',
      effect: 'deny',
      reason: 'Session is tainted by suspicious content; access to secrets blocked',
      when: { classes: ['fs.secrets'], taint: 'suspect' },
    },
    {
      id: 'deny-push-external-when-tainted',
      effect: 'deny',
      reason: 'Session is tainted by suspicious content; push to external remote blocked',
      when: { classes: ['git.push_external'], taint: 'suspect' },
    },
    {
      id: 'ask-mcp-side-effect-when-tainted',
      effect: 'ask',
      reason: 'Session is tainted by suspicious content; confirm this side-effecting MCP call',
      when: { classes: ['mcp.side_effect'], taint: 'suspect' },
    },
    {
      id: 'ask-destructive',
      effect: 'ask',
      reason: 'Destructive command requires confirmation',
      when: { classes: ['shell.destructive'], taint: 'any' },
    },
    {
      id: 'ask-push-external',
      effect: 'ask',
      reason: 'Push to an external remote requires confirmation',
      when: { classes: ['git.push_external'], taint: 'any' },
    },
  ],
};
