# Stroq site: product context

Durable facts about what the site is for. Visual decisions live in DESIGN.md next to this file. Kept in docs/site, not in site/, because site/ is the deploy root and everything in it is public.

## Surfaces

| Route | Mode | Job |
|---|---|---|
| `/` | Persuade | Get a developer to run `npx @stroq/cli sent --last`, then `init`. |
| `/docs/` | Read | Explain every command, the policy, the limits. |
| `/session-secret-scan/` | Read | Answer one question: what does `stroq sent` check, and what does it not prove. |

## Audience

Developers who let AI coding agents (Claude Code, Codex CLI, Cursor, Copilot CLI, Windsurf, Antigravity, OpenClaw) run in their own repositories. Technical and sceptical; they read the code before they trust the page. They arrive from npm, GitHub or a link in a thread, and give a page about five seconds.

## What a visitor must come away believing

1. Text an agent reads (a README, an issue, an MCP result) can decide what it does next.
2. A prompt or a command filter cannot see that; Stroq keeps the link from the text to the action and names it in the decision.
3. Every number on the page can be re-run (`stroq bench`, `stroq attack`, `pnpm test`), and the limits are written down first.

## Proof the page may use

Real CLI output (`examples/demo`, `stroq sent` layout), the 36 replayed incidents with sources, the 500-variant evasion run, cited third-party figures (Tenet, Rehberger, Anthropic). Illustrative material is labelled as an example. No claim without a command or a source behind it; no invented customers, prices or benchmarks.

## Voice

Plain, evidence-first, no hype. Says what it does not catch before a reader finds out. First person only in the about chapter.

## Brand commitments

- The hero headline "Find secrets in past AI coding agent sessions." leads; the session scan is the first thing offered.
- Light and dark themes both ship.
- The site is English.
- Verdicts are never colour alone.

## Constraints

- CSP has no `'unsafe-inline'`: no `style=""` attributes, no `<style>` blocks. `site/test/csp-safe.test.ts` enforces it.
- No tracking beyond Vercel's cookieless page views; no third-party request from the page except Google Fonts.
- Content must be visible without JavaScript and without scrolling; script only adds behaviour.
- The 36-incident list is hand-written in `index.html`. `site/test/home-data.test.ts` ties the headline, bar, wall, charts and `corpus.json` to it, so change them together.

## Anti-references

A dark terminal window on a gradient, grids of same-size stat cards, red/amber/green verdicts, decorative ornament that carries no data, stock "crime scene" imagery.
