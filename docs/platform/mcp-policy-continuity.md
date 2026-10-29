# MCP launch-policy continuity

The current CLI proxy checks that its selected policy still matches the policy
used to create its engine before forwarding a new `tools/call`. A changed or
unverifiable policy withholds the call until that proxy is restarted. Saving a
policy does not hot-reload a running engine or retry any operation.

This control applies to proxies started by a Stroq runtime that has it. Older running
proxies still require restart to load the current runtime and policy. Applying a
wrapper configuration in the console does not replace an existing process.

## Operator workflow

1. Preview, test and explicitly apply a policy through the existing Policies
   workflow, or edit the selected policy outside the platform.
2. A proxy using an earlier parsed-policy fingerprint refuses its next otherwise
   forwardable tool call with a fixed restart explanation.
3. Restart the proxy/client connection so the CLI loads the current policy. A
   malformed or unavailable policy refuses startup rather than falling back to
   the old engine or exposing a parser error.
4. Explicitly retry only the intended operation. The new policy, taint, tool
   contract approval and other existing controls still decide independently.

The policy receipt continues to say **Restart running proxies**. It cannot infer
that every running client uses a runtime with this control. Existing Task Lock parents
retain their separate signed launch-policy contract; this MCP control does not
change permits, extend access, clear taint or revoke a running task.

## Bound policy source

Production `runMcp` captures one resolved Stroq home and performs one bounded
initial policy read. That same parsed policy creates the engine, while its
canonical parsed-policy fingerprint is retained for continuity checks. The
captured home also selects proxy audit, tool-contract and cloak storage.

Only `<captured Stroq home>/policy.yaml` is read. `--cwd` selects workspace/event
and project secret-index context; it does not select another policy. Changes to
ambient `STROQ_HOME` or the process working directory cannot switch the source
mid-session. Browser requests introduce no new filesystem or execution argument.

Only verified absence uses the bundled default. Missing nested directories are
checked without creating them. `ENOTDIR`, denied reads, dangling links and
nonregular entries are unavailable rather than an absent override. Stable regular
files and verified stable source links to regular files are supported; multi-link
files, invalid UTF-8 and files above the existing **1 MiB** policy limit refuse.

Reading uses a bounded descriptor buffer, an extra-byte growth check, nonblocking
and no-follow flags where supported, source/target/descriptor metadata checks and
the existing policy parser. A changed source during reading is unavailable.
Portable metadata checks do not make this an atomic filesystem snapshot or an OS
security boundary against every process running as the same user.

The fingerprint uses the existing `policySha256` over the parsed policy. Comments,
YAML object-key layout, stripped unknown fields and equivalent parsed defaults
do not change it. Rule ordering and other parsed fields remain part of the
fingerprint. This is canonical policy identity, not a general logical-equivalence
solver. An unavailable intermediate edit may still require restart even when the
owner later restores the same final bytes.

## Dispatch and failure semantics

The final synchronous check sits at physical tool dispatch after asynchronous
judgment and cloak preparation. With tool approval enabled it runs inside the
approved-contract dispatch callback, after its lock wait. No await separates the
successful continuity check, request tracking and stream write.

The first `changed` or `unavailable` result latches for that process. Restoring the
file cannot silently regain authority. A supplied guard that throws or returns
an unsupported result is unavailable. In-process tests or internal callers that
inject an engine do not silently acquire an ambient policy source; production
CLI startup supplies the explicit binding.

Refusal returns one proxy-generated tool error with rule
`mcp-policy-changed` or `mcp-policy-unavailable`. Its fixed explanation contains no
policy bytes, filesystem error, path or tool arguments. The separate refusal audit
entry records the same bounded producer-owned reason in the selected Stroq home.
Audit failure cannot grant dispatch. A refused call creates no physical upstream
write or strict pending request. Existing pre-decision audit records remain intent
evidence; they are not proof of delivery.

Cloak audit text records **prepared for dispatch**, including unresolved
placeholders retained as written, rather than claiming they were forwarded. Its
preparation metadata has no secret sightings or decision fields and does not
create a Sent finding or incident by itself. A later continuity refusal remains
separate evidence.

Initialization, tool discovery, cancellation, shutdown and already pending result
handling retain their existing lifecycle. This gate covers new `tools/call`
dispatch, not every MCP method. It does not stop the upstream server, undo a
forwarded request, sandbox independent server activity, prove native-client
adoption or establish the outcome of already sent work.

## Verification

Tests exercise these boundaries with temporary profiles and an inert upstream
server, covering the final dispatch check, queued approval, cloak preparation and
the production CLI process. They do not cover native clients or every release
platform.
