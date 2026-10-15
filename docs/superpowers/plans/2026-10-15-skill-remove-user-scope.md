# Support --user Scope in stroq remove Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `stroq remove <name> --user` to remove user-scoped skills from `~/.claude/skills/<name>`, matching `stroq add --user` and fulfilling `stroq doctor` recommendations.

---

### Task 1: Accept `--user` in `runRemove` and Forward to `removeSkill`

- [x] Declare `user: { type: 'boolean' }` in `packages/cli/src/commands/remove.ts`
- [x] Forward `user: parsed.values.user === true` to `removeSkill`
- [x] Reject `--user` with `--kind mcp` (`unknown option --user for --kind mcp`)

### Task 2: Help Synopsis and Flags for `stroq remove`

- [x] Update synopsis in `packages/cli/src/help.ts` to `remove <name> [--user] [--force] [--kind skill|mcp]`
- [x] Add `--user` entry to flags in `packages/cli/src/help.ts`

### Task 3: Documentation and Command Reference Updates

- [x] Update `docs/GUIDE.md` section "Add a skill after reading it" and command reference table
- [x] Update `site/docs/index.html` command reference table

### Task 4: Test Coverage

- [x] Add CLI boundary tests in `packages/cli/test/commands/skill-commands.test.ts`
- [x] Add unit test in `packages/cli/test/install/skill-install.test.ts`
