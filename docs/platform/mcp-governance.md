# MCP call governance

**Govern MCP calls** in **Skills & MCP** edits a deny-first gate for MCP calls observed by updated Stroq hooks and proxies. **Policies** links to the same workflow. This is an exact list of reported server labels per channel; it does not authenticate a server, pin a registration or endpoint, prevent server startup, or sandbox the process.

## Operator workflow

1. **Open the control.** The initial read shows the current policy and this workspace’s retained operations. It does not inspect MCP registrations, start servers, write configuration or repair unknown outcomes.
2. **Inspect configured servers.** This explicit action reads bounded, fixed configuration sources selected by the local server: supported Claude, Cursor and Windsurf JSON registrations, plus selected Codex user/project TOML. Capture is partial; excluded, unavailable and ambiguous sources remain visible as gaps. It performs no MCP RPC, model or provider request.
3. **Choose reported identities.** A host binding and a verified same-home Stroq proxy binding are separate channel-labelled choices. Identical pairs coalesce across captured sources. Existing allowances with no captured registration remain available to retain or remove. Masked labels can still be selected through their opaque IDs. Unsupported or ambiguous identities cannot be selected. The browser submits only captured choice IDs and their expected hashes.
4. **Preview MCP policy.** The candidate replaces the **entire MCP allow-set**, upgrades the policy to version 2, and preserves other rules, threshold and default. An empty set denies every governed MCP call. Review added/removed identities, ordinary-work interruptions, saved policy checks and model-free core gate fixtures. With an empty list, the listed-identity fixture is explicitly not applicable. These checks do not prove a live host adopted the policy.
5. **Apply MCP policy.** Confirm shared-home scope, version compatibility and unencrypted recovery copies. New allowances relative to an existing v2 policy require a weakening acknowledgement; removed identities or relevant interruptions require impact review. The preview expires after two minutes and Apply is one-use. Changed source, policy, runtime or saved-check bindings require a fresh inspection/preview.
6. **Read the receipt.** A confirmed write, current policy correspondence and native hook/proxy adoption are separate facts. Existing proxies need restart. Existing tasks may retain their launch policy. Saving a policy does not install or approve hooks or upgrade running processes.

The policy affects every workspace and agent using the selected **Stroq home**, rather than only the workspace whose registrations were inspected. Version 1 without this gate remains supported by the updated runtime. Version 2 requires `mcpGovernance.allowed`; older runtimes that only understand v1 reject v2 instead of silently ignoring the gate.

## Identity and enforcement boundary

A policy entry is an exact, case-sensitive `(channel, name)` pair. Up to 64 unique pairs are supported. Policy names use the ASCII subset `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; a client may report names that cannot be represented safely by this editor.

| Channel            | Evidence used for the reported label                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Claude Code, Codex | Original `mcp__<server>__<tool>` envelope, only when parsing is unambiguous; no reconstruction from normalized tool names |
| Cursor             | Outer `mcp_server_name` field                                                                                             |
| Windsurf           | `tool_info.mcp_server_name` field                                                                                         |
| Stroq MCP proxy    | Server name fixed in the proxy context, outside incoming tool arguments                                                   |

Unknown or unlisted identities are denied under v2 when the action is classified as MCP or carries MCP identity evidence. Hosts without a usable supported witness cannot gain an allowance through a synthetic name. A listed identity only passes this prerequisite: existing policy, secret-egress, provenance, task and other independent checks continue to apply. Non-MCP calls retain their existing behavior.

Registration discovery is not proof that a client emits the same label, that a hook is active, or that a server is trustworthy. Calls outside the observed hook/proxy boundary remain outside this control. Existing per-registration containment controls are a separate operation.

## History, unknown completion and recovery

**History** retains exact operations across restart. **Recheck exact operation** uses the operation/context, record revision and candidate binding; it never retries Apply. A staged write is confirmed only with the recorded physical file/parent identity, candidate digest and recovery evidence. Matching bytes alone cannot establish which operation published them. An exclusively rechecked operation that never reached staging can be recorded as **not applied**. Missing or changed proof can leave completion unknown.

A normal history read never settles unknown operations. An absent record, matching current bytes, later successful change or whole-policy Restore does not prove an earlier unknown write succeeded or failed. Browser pending intents remain visible independently of retained history.

To recover without replaying an uncertain write, explicitly inspect the current configuration and preview a **fresh independent change**. Review the exact retained unconfirmed operations bound into that preview, plus any browser-local unknown intents. Their acknowledgements permit a new operation; they do not resolve the old outcomes.

The private `<STROQ_HOME>/mcp-governance` journal retains at most **32 metadata records / 8 MiB across the home**, with no automatic expiry or eviction. A full journal refuses a new write intent; existing records remain available for recheck. It stores derived bindings and publication evidence, not raw MCP configuration, policy bodies, commands or server labels. Separately, the existing `<STROQ_HOME>/backups/console-policy` recovery store retains **full policy pre-images when a policy file existed**, unencrypted and without automatic expiry; these can contain private rules and names. Raw registration configurations are not added to either store by this workflow.

**Preview whole-policy restore** opens existing policy recovery history. Restore tests and restores the complete retained policy, including all rules and the MCP gate. Its preview shows policy versions, gate presence and added/removed identities; restoring v1 removes this gate. Restore requires its own shared-scope, recovery-copy and reduced-protection acknowledgements, plus interruption consent when applicable. It is not a surgical undo of only the MCP list and does not prove live adoption or settle another unknown operation.

Stroq writers coordinate through local locks and verify captured revisions before and after publication. These filesystem checks are not an operating-system compare-and-swap against an unrelated process writing the same policy path. In particular, the existing whole-policy removal path cannot atomically exclude a non-cooperating same-user writer between its final check and unlink. Publication evidence and Recheck do not imply that stronger guarantee.

Implementation: [public contracts](../../console/lib/mcp-governance-types.ts), [local service](../../console/scripts/mcp-governance-service.ts), [capture](../../console/scripts/mcp-governance-capture.ts), [publication proof](../../console/scripts/mcp-governance-publication.ts), [core gate](../../packages/core/src/policy/mcp-governance.ts), [whole-policy workflow](policy-workflow.md).

## What has been tested

The workflow has been tested with disposable profiles, real policy and saved-check stores and workers, and Stroq's own hook handlers. These are handler fixtures, not native-client adoption tests: no native client, model or provider request or registered MCP server program was started. It has not been tested with a real Claude client.

The gate is absent until an operator explicitly captures, reviews and applies a policy.
