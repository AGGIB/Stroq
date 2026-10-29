# Stored session taint

An investigation can inspect the current stored taint of the session referenced
by its exact recorded finding. **Clear stored session taint** changes only that
session's native taint value to `null`. It preserves learned-origin provenance,
pending/incomplete markers, the audit journal, trust settings, policy and task
permissions. This narrower action differs from CLI `untaint`, which also clears
the session's provenance.

Clearing taint weakens one recorded restriction. Provenance-based or independent
policy decisions may still refuse the next action. The operation does not judge
the finding false positive, approve its content, retry a tool call, empty an
agent's context or establish that a running host has adopted the change.

## Inspect and preview

The browser selects an immutable finding ID and evidence fingerprint. A private
server callback supplies its sequence and time; the worker reselects the exact
entry from a complete verified journal snapshot. Browser inputs cannot supply a
raw session ID, path, replacement state or an all-sessions selector. The public
session reference is an opaque digest, not a filesystem locator.

Inspection reports current taint and bounded provenance counts and flags. It
keeps unreadable, invalid and incomplete evidence distinct from a verified empty
state. Audit consistency is not signed authenticity or protection against a
rewritten chain or tail truncation. Host/project attribution absent from the
original event stays unknown; selecting a workspace does not manufacture it.

Preview binds the exact inspection revision, native source identity, provenance,
journal prefix, selected roots and runtime. Pending input refuses a preview; an
observation may still begin after that check. Preview never writes session
state. At most eight private previews fit within 8 MiB, counting their retained
public/private evidence and runtime binding. Each expires after two minutes;
unreferenced timers release its private bytes without waiting for another visit.

## Clear and recheck

Two unchecked acknowledgements cover weakening restrictions and retaining a
private recovery copy. Every clear attempt consumes its recognized preview,
including failed consent, a busy operation or changed context. A fresh preview
is required to try again.

Clear holds the shared configuration lock until the fixed worker has terminated.
The native session writer independently checks expiry and current source pins
under its existing session lock. Durable prepared evidence and the intended
staged inode precede native publication. The preserved provenance is checked at
the write boundary; it is not erased to make a later decision pass.

Private, unencrypted recovery retains original native session bytes and metadata
inside the selected Stroq home. It may contain sensitive source labels or session
identifiers. The global store is bounded to 32 records and 32 separate opaque
temporary-file slots within the same 8 MiB budget, with no automatic eviction,
stage adoption or cleanup. A retained temporary file does not authorize a session
write. Only records for the selected
workspace are projected to the browser; capacity and malformed storage refuse
further changes.

Records distinguish `prepared`, `cleared`, `unchanged` and `uncertain`. A confirmed
historical publication remains separate from a fresh current inspection: a later
input or an in-flight observer can taint the session again. An already-running
proxy may retain its own in-memory state. This action provides no guarantee that
all future calls are unrestricted.

A lost worker, timeout or abort after clear starts has unknown completion.
Post-receipt runtime/root validation failure also refuses a trusted completion
response. There is no automatic retry or rollback. **Recheck** explicitly selects
the retained record and examines the exact native publication identity; identical
foreign bytes cannot establish that Stroq performed the write. Recheck never
clears taint again. Opening a page, refreshing history or reviewing a finding does
not repair an interrupted change.

Eight exact code/status pairs identify explicit refusals before publication. The
browser releases only its matching pending attempt, invalidates its inspection
and consents, and reads history before another explicit preview. Plain error text,
forged metadata, a wrong status, timeouts and lost responses remain unknown; human
messages are not parsed into mutation authority. Other unfinished records keep
their explicit recheck requirement.

## Evidence and acceptance boundary

The public protocol uses `/api/session-taint` history and fixed POST operations
`inspect`, `preview`, `clear` and `recheck`. Authentication, exact Host/Origin,
strict bounded JSON, immutable context and finite sanitized errors apply. Raw
session identifiers, native bytes, provenance text and private paths stay outside
responses and exports.

The clear has been tested with synthetic hook events only; native Claude
behavior has not been verified. That evidence is separate from native-client
adoption and from the formerly refused action actually running.
