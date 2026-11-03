# Rules

**Rules** (`/policies/`) is one screen with four parts, in this order:

1. **Try an action.** What a command, a file read or write, or a page fetch would get, in a clean
   session and after untrusted text (`try-action.md`). Nothing is run, written or sent.
2. **Rules you can change.** Deny selected action categories, strengthen the answer for unmatched
   actions, lower the detection threshold, or promote approval rules to deny. **Preview & test
   changes** validates the candidate and replays it against the current policy and the saved checks,
   and shows which ordinary actions would start to be interrupted; applying needs an explicit
   acknowledgement, and nothing is written before it (`policy-workflow.md`). The saved policy checks
   that gate a write are at `/policies/checks/`, linked from here, and nothing about them changed.
3. **History.** What changed in the rules, with a private recovery copy of each. A recorded change can
   be **undone**: a preview tests the earlier version against the current policy and the saved checks,
   and the undo restores exact bytes or selects the current bundled default (`policy-recovery.md`).
   `/policies/?entry=<id>#history` opens one recorded change.
4. **Rules reference.** The bundled default rules, searchable. `/policies/?find=<rule id>#reference`
   opens it on a rule; that is where the rule in the chain of a Live row leads.

The older addresses lead here: `/try/` to the first part, `/policies/history/` to the third (keeping
the recorded change it named), `/policies/reference/` to the fourth.
