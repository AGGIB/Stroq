# Workspace task controls

The workspace report offers **Make tasks manual** for a captured, regular
`.vscode/tasks.json` in the selected workspace. This action changes the explicit
`folderOpen` and `worktreeCreated` triggers to `default`. Commands and manually
invoked tasks remain present. It changes file configuration; it does not stop
running tasks, change editor trust or establish that a client has adopted the
new file.

## Review and change

Start with an explicit workspace capture, then open its **On open** source group.
The action is available only for the fixed workspace task file. Settings files,
multi-root workspace files, hidden labels, nested files and linked sources do not
become write targets. Comparison rows remain historical evidence.

Preview reselects the exact retained run and source fingerprint, verifies the
current runtime, roots, source bytes and mode, and reads the current file under
pinned parents. The returned counts describe the two actual trigger values that
will change. They are not derived from a grouped detector count. An incomplete
capture can still identify this exact readable source; it does not establish
absence elsewhere.

Two unchecked acknowledgements cover the workspace change and retention of a
complete private file copy. That copy can contain credentials or other private
configuration. No raw task names, commands, file contents or absolute paths are
sent to the browser. Preview is read-only and transient: eight plans within
8 MiB, each valid for two minutes, consumed once. Browser fields cannot supply a
path, replacement text, command or executable.

Apply repeats the source and runtime checks under the shared configuration lock.
The existing guarded atomic writer preserves the file mode and replaces only
the selected string literal values. Comments, trailing commas, BOM, CRLF,
Unicode and all other bytes remain unchanged. Duplicate decoded keys,
unsupported task shapes and unknown trigger values are refused. Source files
are bounded to 256 KiB and 256 tasks/changes.

## Recovery and verification

Before replacing the task file, Stroq durably retains the original bytes and an
intent record. Its own staged publication identity is recorded before the
target rename. A confirmed write is distinct from a successful subsequent static
capture. A new capture is associated only with the exact check started by this
operation. Unavailable or incomplete verification remains explicit; review does
not automatically accept a new baseline.

**Restore** requires a new preview, the retained record revision, an intact
backup and the exact file version published by Stroq. It requires separate
acknowledgement that automatic execution will be restored. A matching content
hash alone cannot authorize replacement of a different inode. Newer user edits,
source replacement and unsafe metadata are refused.

**Recheck** explicitly inspects one retained recovery record and may finish its
durable status after an interrupted publication. It never edits the task file.
Page loads and ordinary refreshes do not repair, roll back or clear an uncertain
write. An unavailable record cannot establish that a request made no change.
Confirmed historical writes remain visible if later edits change the current
file; current file state and restore availability are shown separately.

Protection also reads this recovery history. An unfinished change, later file
drift, an unavailable recovery copy or an absent, mismatching or partial
verification adds an attention row linked to the exact retained record. One
record contributes its highest-priority reason; six individual rows and an
exact overflow link keep the queue bounded. Opening that destination expands
the selected record and moves keyboard focus to its summary once. Refreshing
the record does not repeatedly steal focus.

**Recheck record** remains explicit. It inspects the current file and starts
its own associated static capture without changing task bytes or accepting a
review baseline. A complete matching capture can remove that record's follow-up;
it does not resolve independent captured signals or prove editor adoption.
Unavailable, invalid or foreign-workspace history remains a coverage gap.
Opening or refreshing Protection never applies, restores or rechecks a change.

The private, unencrypted recovery vault is shared within the selected Stroq
home: at most 32 records and 8 MiB, including reserved metadata space, with no
automatic eviction or expiry. Capacity or invalid storage prevents another
write. Unpublished private staging copies also consume this budget. A complete
entry is published before the task file can change; interrupted staging is
retained without granting recovery authority or being deleted by a read.
Recovery records are bound to the selected workspace/root and are
separate from the bounded workspace-capture history. Losing that history can
make an old capture link unavailable while the recovery copy still exists.

## Upstream behavior and limits

The released VS Code 1.143.1 task schema lists `default`, `folderOpen` and
`worktreeCreated`. Its parser treats the values case-insensitively. The
transformation uses those explicit direct-task fields; it refuses ambiguous
task-level OS overrides or unsupported task collections rather than guessing
inheritance. See the [released task schema](https://github.com/microsoft/vscode/blob/1.143.1/src/vs/workbench/contrib/tasks/common/jsonSchema_v2.ts),
[parser](https://github.com/microsoft/vscode/blob/1.143.1/src/vs/workbench/contrib/tasks/common/taskConfiguration.ts)
and [worktree task dispatcher](https://github.com/microsoft/vscode/blob/1.143.1/src/vs/sessions/contrib/chat/browser/worktreeCreatedTaskDispatcher.ts).

Automatic-task permission is a separate application/user setting in that release.
This operation does not change `task.allowAutomaticTasks`, prompt state or
workspace trust. See the [released configuration registration](https://github.com/microsoft/vscode/blob/1.143.1/src/vs/workbench/contrib/tasks/browser/task.contribution.ts)
and [automatic-task runner](https://github.com/microsoft/vscode/blob/1.143.1/src/vs/workbench/contrib/tasks/browser/runAutomaticTasks.ts).
JSONC comments and trailing commas follow the [editor format](https://code.visualstudio.com/docs/languages/json#_json-with-comments).

These checks do not execute tasks or use a model subscription. File effects in
disposable profiles are separate evidence from effective native editor behavior,
process termination or other operating systems. Same-user filesystem races and
replacement of the runtime together with its manifest retain the platform's
existing limits.
