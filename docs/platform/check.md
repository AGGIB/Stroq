# Check

**Check** (`/`) is the first screen of the console. It is the card that `stroq` prints in a terminal,
made by the same code, over the same sessions.

## Where the card comes from

The console's engine runs `stroq card --json` (the built CLI, the same bundle, the same worker threads,
the same cache under `<Stroq home>/card/`, and the same `last.json` that `stroq show N` reads). The
answer is checked against the CLI's own schema (`packages/cli/src/card/data-schema.ts`) and then
turned into sentences by the CLI's own `cardView` (`packages/cli/src/card/render.ts`): the title, the
four counts, the notes about what could not be looked at, the moments and the next step. `renderCard`
prints the terminal's lines from the same view, so the console words nothing itself. A reply that is not
exactly the shape the client expects (`console/lib/card.ts`) is refused whole.

- `GET /api/card` reads the state: `idle`, `running`, `done` or `failed`, with the last card.
- `POST /api/card/start` (an empty body) starts a run. One run goes at a time; asking while one goes is
  the one that goes. The last card stays on screen while the next is made.
- The card runs in the environment of the console, as the terminal's would, so the keys it looks for
  are the keys the terminal's card looks for. Only the variables that make Node run other code first
  (`NODE_*`, `LD_*`, `DYLD_*`) are left out. It reads the session files Claude Code and Codex keep and
  the key files those sessions could have seen, on this machine; nothing is sent.
- The screen reads the state when it opens, starts a run when there is none or the one there is is more
  than ten minutes old, and follows a run that is going by asking again every second and a half. Nothing
  else polls.

## What the screen shows

- **Hoo.** The owl that says the result: alert when something is worth a look, happy when nothing is,
  idle when there were no sessions. The pictures are `console/public/hoo/{alert,happy,idle}.svg`,
  written by `pnpm owl:svg` from the grid and palette the terminal draws (`pnpm owl:svg --check` fails
  when they differ). They do not move, and the words beside them say the same thing.
- **The counts** (`#commands`, `#told`, `#keys`, `#autorun`): the commands the agents ran, how many a
  text they had read told them to run, the keys that left this machine and the repositories that run
  code as soon as an agent opens them. The older addresses of Secret exposure and Workspace review lead
  to `/#keys` and `/#autorun`; to look inside a folder, run `stroq inspect <folder>`.
- **Worth a look.** The first three moments, and the rest folded. A moment opens in place with the
  groups of rows `stroq show N` prints, and copy buttons for `stroq show N` and the commands that go
  deeper. Every word that came from a transcript was made safe once when the moment was built and once
  more when the console took it.
- **Your agents.** One line for each agent, in the words of `lib/agent-summary.ts`: whether Stroq's hooks
  are in its settings and when Stroq was last asked. The fix line is `npx @stroq/cli init`.
- **Setup checks.** The installation, rule-file and scenario checks of the older Protection screen,
  closed, and read only once opened (`protection-check.md`).

"Check again" makes a new card. The screen says plainly when it could not: an engine that is not built,
a run that took longer than two and a half minutes (what was read is kept, so the next run starts
further on), a card larger than the console accepts or one that could not be verified.
