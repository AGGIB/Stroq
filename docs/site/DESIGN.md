---
name: Stroq
description: A chain of custody in black ink on cold paper, with one signal-orange thread from the text an agent read to the action it took.
colors:
  paper: "#f1f2f0"
  paper-2: "#e5e7e3"
  ink: "#0d0e10"
  ink-2: "#464a50"
  signal: "#fe4813"
  signal-text: "#b3290a"
  paper-dark: "#0d0e10"
  paper-2-dark: "#181a1e"
  ink-dark: "#f1f2f0"
  ink-2-dark: "#aeb3bb"
  signal-dark: "#ff5a28"
  signal-text-dark: "#ff8a63"
  term: "#0d0e10"
  term-2: "#17181b"
  term-fg: "#e6e8ef"
  term-dim: "#9aa3b5"
  deny-docs: "#d7263d"
  ask-docs: "#d19a00"
  allow-docs: "#1f9d55"
  info-docs: "#0b7285"
typography:
  h1:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(2.7rem, 1.1rem + 5.2vw, 5rem)"
    fontWeight: 800
    lineHeight: 0.94
    letterSpacing: "-0.012em"
    fontVariation: "'wdth' 78"
  h2:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(2rem, 1.2rem + 2.8vw, 3.6rem)"
    fontWeight: 800
    lineHeight: 0.98
    letterSpacing: "-0.012em"
    fontVariation: "'wdth' 78"
  h3:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.3rem"
    fontWeight: 700
    lineHeight: 1.15
    fontVariation: "'wdth' 88"
  lead:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(1.08rem, 1rem + 0.35vw, 1.25rem)"
    fontWeight: 400
    lineHeight: 1.45
  body:
    fontFamily: "Archivo, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.55
    fontVariation: "'wdth' 100"
  data:
    fontFamily: "Martian Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.8rem"
    fontWeight: 500
    lineHeight: 1.7
    fontVariation: "'wdth' 80"
  label:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "0.7rem"
    fontWeight: 700
    letterSpacing: "0.05em"
    fontVariation: "'wdth' 85"
rounded:
  base: "2px"
  lg: "4px"
  pill: "999px"
spacing:
  gutter: "clamp(1rem, 2.5vw, 2rem)"
  section: "clamp(3.5rem, 2rem + 5vw, 7rem)"
  head: "clamp(1.75rem, 1.5rem + 1.5vw, 3rem)"
  container: "1160px"
components:
  button:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.base}"
    padding: "0.65rem 1.2rem"
    height: "46px"
  button-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.base}"
    padding: "0.65rem 1.2rem"
    height: "46px"
  button-primary-hover:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.ink}"
  install-pill:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0.25rem 0.25rem 0.25rem 1rem"
  chip-deny:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.base}"
    padding: "0.24rem 0.55rem"
  viewer:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
    rounded: "0"
    padding: "2rem"
  code-panel:
    backgroundColor: "{colors.term}"
    textColor: "{colors.term-fg}"
    rounded: "0"
    padding: "1.1rem 1.25rem"
---

# Design System: Stroq

Recorded from the shipped `site/styles.css`, `site/home.css` and `site/main.js`. Where the build and the plan differed, this file follows the build.

## Overview

**Creative North Star: "The Chain of Custody"**

The page is a piece of evidence with one visible thread. A cold light ground, black ink, and a single signal orange that exists to connect the text an agent read to the action it took. Everything else is ink: hairlines, 2px chapter rules, solid and hatched fills. There are no cards, no gradients behind content, no traffic-light verdicts on the landing page. Density is editorial and ruled, like a case file: chapters are separated by a heavy rule, content sits in a 12-column-ish asymmetric grid (7/5, 5/7, 6/5), and numbers are set large and condensed.

Archivo does the speaking, in a condensed width for display and a normal width for reading. Martian Mono is reserved for data, code, counts and axis labels. Real CLI output is the one place a dark panel appears, because it is the CLI's own output and keeps the CLI's own colours.

The orange appears in exactly these roles: the thread (SVG lines, the chain spine), rules and underlines, a highlight on the evidence line, selected-tile ring, the scroll hairline under the header, hover on the primary button, and one full field (the install chapter).

**Key Characteristics:**
- Cold paper ground, near-black ink, one orange. Dark theme swaps paper and ink and lifts the orange slightly.
- Verdicts are shapes: solid ink means blocked, hatched ink (135deg diagonal lines) means asked.
- Archivo variable width axis carries the hierarchy (78% display, 88-94% titles, 100% body); Martian Mono at 80% width for data.
- 2px corners, 2px ink chapter rules, 1px hairlines, no cards, no soft shadows on content.
- One motion idea: the thread draws, the wall fills, scale markers land. Once, on entering view.

## Colors

A two-pole neutral pair (paper and ink) with one saturated signal. Hex is canonical; the dark values are in the frontmatter with a `-dark` suffix and apply under `prefers-color-scheme: dark` (there is no manual toggle).

### Primary
- **Signal Orange** (#fe4813 light, #ff5a28 dark): fills, rules, threads, the chain spine, selected-tile ring, the highlight under evidence phrases, the full install field. As small text on paper it is 2.9:1, so it is never used as text.
- **Signal Text Orange** (#b3290a light, #ff8a63 dark): the only orange allowed on text (for example the thread label inside the flow diagram).

### Neutral
- **Cold Paper** (#f1f2f0; dark #0d0e10): page ground and the header.
- **Paper Shade** (#e5e7e3; dark #181a1e): the single raised surface, used for the attack viewer, the limits box and the "asked" snippet.
- **Ink** (#0d0e10; dark #f1f2f0): text, borders, chapter rules, every "blocked" fill.
- **Ink Secondary** (#464a50; dark #aeb3bb): leads, captions, axis labels.
- **Hairlines**: ink at 16% (`--line`) for row dividers, ink at 38% (`--line-2`) for section and hatch strokes. Inline code tint is ink at 7%.

### Terminal (real CLI output only)
Term ground #0d0e10 (dark #181b22), header strip #17181b, text #e6e8ef, dim #9aa3b5, with the CLI's own deny/ask/allow/info tints (#ff6b7a, #ffc94d, #5cd68a, #5fd3e6).

### Docs-only verdict colours
`--deny` #d7263d, `--ask` #d19a00, `--allow` #1f9d55, `--info` #0b7285 (with text and tint variants) remain defined because the docs pages still read them. The landing page does not use them for verdicts.

### Named Rules
**The Thread Rule.** Signal orange marks the link from source to action and nothing else: threads, rules, evidence highlights, one field. If a new element is orange only to look lively, it is wrong.
**The Shape-Not-Colour Rule.** A verdict on the landing page is solid ink (blocked) or hatched ink (asked). Never green/amber/red there.
**The Orange Text Rule.** Text that must be orange uses the signal-text value, never the fill orange.
**The One Field Rule.** The install chapter is the only full-bleed orange field; it locks its own scheme (black ink on orange, in both themes) and does not follow the theme swap.

## Typography

**Display and Body Font:** Archivo (variable, weight 400-900, width axis 62-125), fallback Helvetica Neue, Arial, sans-serif. Loaded from Google Fonts.
**Data Font:** Martian Mono (variable, width 75-112.5), fallback ui-monospace, SF Mono, Menlo, Consolas.

**Character:** A tight condensed grotesque for statements and numbers against a wide, quiet reading width; mono only where the content is literally data, commands or labels.

### Hierarchy
- **H1** (800, clamp 2.7-5rem, line-height .94, width 78%): hero only; capped at 11ch.
- **H2** (800, clamp 2-3.6rem, .98, width 78%): chapter titles. Install h2 is larger (clamp 2.7-5.4rem, .92); about h2 is smaller (1.9-3rem).
- **Statement / bridge** (800, clamp 2-3.9rem, 1, width 78%): the single pull-line between incident and mechanism.
- **H3** (700, 1.3rem, 1.15, width 88%): legend, chart and chain titles.
- **Numerals** (800, width 78%, tabular-nums): bar values (1.6-2.2rem), segment counts (2.4-4rem), viewer index (3.2-5.6rem).
- **Lead** (400, clamp 1.08-1.25rem, 1.45, 44ch max, Ink Secondary).
- **Body** (400, 1.0625rem, 1.55, width 100%).
- **UI text** (600-700, .9-.95rem, width 92-94%): nav, buttons, summaries.
- **Data** (Martian Mono 500, .7-.8rem, width 80%): code, ledger, axes, tallies. Chips are 700 uppercase, .7rem, letter-spacing .05em, width 85%.

### Named Rules
**The Width-Axis Rule.** Hierarchy is made with `font-stretch`, not only size: 78% for display and numerals, 82-94% for titles and UI, 100% for body, 80% for mono. New headings pick a stop from this set.
**The Mono-Is-Data Rule.** Martian Mono carries code, counts, axes, tallies and chips only. Prose never goes in it.
**The Highlight Rule.** Emphasis in leads is `em` rendered upright (not italic) with a signal underline or highlighter band, never bold orange text.

## Layout

One container of 1160px with a fluid gutter (clamp 1-2rem). Each chapter is a full-width block with `padding-block` of the section token (clamp 3.5-7rem) and a 2px ink rule on top. Chapter heads are a 7/5 grid (title left, lead right, bottom-aligned) with the head token as the gap below. Content grids vary on purpose: hero 1.05/1, incident 6/5, wall 5/7, policy 5/7, install 5/6, about 5/7, versus 1/1; do not default everything to equal columns.

Chapters in order: scan (hero with the session x-ray), the incident (chain, film, unit bars, bridge line), how it works (two-lane diagram, three-item legend, collapsed policy), 36 attacks (verdict bar, wall plus viewer, unit chart plus matrix, provenance key, collapsed full list), comparison (two snippets side by side), install (orange field), about.

Responsive: everything collapses to one column at 1000px; the viewer moves above the wall. At 860px the full flow diagram is swapped for a compact names-only version drawn at near-real size. At 700px nav and footer stack, row tallies are dropped to screen-reader-only, CTAs go full width. At 480px the wall gap tightens to 4px. The nav collapses to a toggle at the shared breakpoint (JS only; without JS the menu stays open).

## Elevation & Depth

Flat. Depth comes from rules, tonal shift (Paper Shade for one surface) and the dark code panel, not shadows. The only shadow is the code panel's soft two-layer drop (`0 1px 2px` plus `0 18px 40px -22px`), used on real CLI output. The header is sticky with a blurred translucent paper (88%) where supported and a 1px bottom line. Tiles lift 2px on hover (transform), the only hover elevation.

### Named Rules
**The Flat-Content Rule.** Content never sits in a shadowed card. The code panel shadow is the single exception and belongs to the terminal figure only.

## Shapes

Sharp. Base radius 2px everywhere (buttons, chips, tiles, code spans, redaction bars); 4px exists as a token but the landing page does not rely on it. Pills (999px) are only the install command and its copy button. Borders are 1.5px ink on interactive and figure elements, 2px ink on the major panels (verdict bar, viewer, limits box, chapter rules, the full-list disclosure), 1px hairlines for rows. Circles are used for chain-step numbers, legend numbers and the ledger dot; squares for evidence markers.

### The verdict grammar
- **Blocked:** solid ink fill, paper text. Reused in chip, wall tile, verdict-bar segment, unit-chart square, group dot, scale marker, matrix cell, inline highlight, compare snippet, flow verdict node.
- **Asked:** paper ground with 135deg diagonal ink hatch; the hatch spacing scales with the element (3px to 7px steps). Same reuse list as blocked.
- Forced-colors mode restores these as Canvas/CanvasText, with asked drawn as a dashed border.

## Components

### Buttons
- **Shape:** 2px corners, 1.5px ink border, min-height 46px (nav variant 40px), Archivo 700 at width 92%.
- **Default:** transparent with ink text; hover inverts to ink fill and paper text.
- **Primary:** ink fill, paper text; hover turns signal orange with ink text (ink border retained). Active nudges down 1px.
- **Focus:** 2px ink outline, 3px offset (on dark code panels the outline flips to terminal-foreground).

### Install pill and copy button
A 999px-radius pill with 1.5px ink border holding the mono command and an ink copy button; copy hover goes signal. Hidden without JS (the command remains selectable). A smaller nav copy of the pill fades in once the hero command scrolls out of view.

### Navigation
Sticky paper header, 64px. Links are Archivo 600 at 92% width in Ink Secondary; hover, focus and the current chapter (`aria-current`, set by an intersection observer on a thin mid-viewport band) go to ink and draw a 2px signal underline from the left. A 2px signal hairline under the header tracks scroll progress through a CSS scroll timeline (only where supported and motion is allowed).

### Chapter disclosure (`<details>`)
Used for the policy, the full attack list, six attack groups inside it, the install alternatives and the film. Native `<details>`, no JS dependency. Summary is a flex row with a 9px chevron built from two borders (rotates -45 to 45 degrees on open), Archivo 700, optional right-aligned mono meta. Lists are 1px hairline-bordered; the full-list disclosure uses 2px rules top and bottom.

### Session x-ray (signature)
An SVG strip of 64 ticks (ink at 50%) with three signal-tinted hits, each tied by an orange thread to its line in a ledger below. The ledger has a 2px signal left rail, mono text, a round signal dot for the tool name and square signal markers for hits. The report is inset 2% to match the SVG's thread endpoints.

### Incident chain
An ordered list on a 2px signal spine; numbered ink-ringed circles, the final step filled orange. Result tags are small solid ink labels.

### Two-lane flow diagram
Inline SVG styled only by classes (`fl-*`): paper nodes with 1.5px ink stroke, solid-ink policy node, orange taint node, dashed hairline lane separator, an orange thread path, verdict nodes using the shape grammar. A compact variant (`fl-*-c` size classes) replaces it under 860px.

### Attack wall and viewer
A 6-column grid of square tiles (6px gap), one per incident, solid or hatched by verdict, forming a radio group with `aria-checked`; the selected tile gets a 4px inset orange ring. The viewer (Paper Shade, 2px ink border) shows the selected incident with a large condensed index. The wall is built by JS and hidden until `.js-ready`; the plain list below it is the full truth without a script.

### Scale markers and unit charts
Figures sit on a shared 0-100% axis drawn with four gradient lines (baseline and ticks at 0, 50, 100); a 16px ink square marks a point, a hatched bar marks a range. Positions are set by utility classes (`.at-85`, `.from-60`, `.w-20`), not inline styles. The unit chart draws one 14px square per attack, solid or hatched.

### Compare snippets
Two mono blocks with a 1.5px ink border: "asked" on Paper Shade, "blocked" solid ink. The evidence phrase inside is the one place orange marks text, as a solid orange band with ink text (`thread-mark`).

### Code panel
Dark real-CLI figure with a 44px header strip, mono 0.8rem at 1.7 line height, `Martian Mono` width 80%, hairline term borders, a dark ghost copy button. Stays dark in both themes (slightly lighter in dark theme).

### Install field
Full-bleed #fe4813 block with locked ink-on-orange tokens (the local `--signal` becomes paper so hover and selection invert correctly). Buttons and pills inside use the same primary/ghost grammar. Agent list uses mono-free Archivo 600 with inline marks.

## Motion

One grammar, three expressions, all once, on entering view, easing `cubic-bezier(.16, 1, .3, 1)`:
1. **Thread draws:** SVG threads (`.thread`, `.fl-thread`) animate `stroke-dashoffset` 1 to 0 over 1.1s; the second and third threads delay .15s and .3s. The incident chain spine grows from the top over 1.3s via `scaleY`.
2. **Wall fills:** tiles scale in from .6 with opacity over .45s, staggered diagonally by (column + row) x 45ms; scale markers land with a .6s scale-in staggered .12s.
3. **Hover/focus:** 150ms colour and 2px tile lift; nav underline 320ms scale.

Safety: elements carrying `data-draw` are drawn by default. Only when `IntersectionObserver` exists and `prefers-reduced-motion` is not reduce does `main.js` add `.is-armed` (hidden start) and later `.is-drawn` (visible end); every hidden starting state in CSS is scoped under `.js` and `.is-armed` and inside `prefers-reduced-motion: no-preference`. No JS, no observer, or reduced motion means everything is simply drawn and static. Only `transform`, `opacity` and `stroke-dashoffset` animate.

## CSP constraint

The site's CSP has no `unsafe-inline`: no `style=""` attributes and no `<style>` blocks (enforced by `site/test/csp-safe.test.ts`; index.html currently has zero `style="` occurrences). Dynamic values are therefore carried by classes: scale positions (`.at-85`, `.from-60`, `.w-20`), verdict segment ratios (`flex-grow` 17 and 19 set in CSS), wall stagger via `:nth-child` custom properties `--c` and `--r`. SVG is styled by class (`fl-*`, `ticks`, `thread`, `matrix-cell`), with fills and strokes drawn from the tokens so both themes work.

## What docs pages inherit

`site/docs` and `site/session-secret-scan` load `styles.css` only (plus `docs/docs.css` for the docs shell): tokens, base typography with the width-axis headings, header and nav, buttons, install pill, code panels and the footer. They also still use the docs-only deny/ask/allow/info colours and tints. They do not load `home.css`, so chapters, the verdict grammar classes, the wall and the install field are landing-only unless deliberately promoted.

## Do's and Don'ts

### Do:
- **Do** use ink for everything and orange only for threads, rules, evidence highlights, the selected ring and the install field.
- **Do** draw verdicts as solid ink (blocked) and hatched ink (asked) with the 135deg hatch.
- **Do** build hierarchy with Archivo width stops (78 / 88-94 / 100) and put only data in Martian Mono.
- **Do** keep corners at 2px, chapter rules at 2px ink, hairlines at 1px.
- **Do** keep hidden starting states under `.js` plus `.is-armed` and inside the no-preference motion query; the no-JS page must be complete.
- **Do** carry dynamic values with classes or CSS custom properties set in CSS, never inline styles.
- **Do** use `<details>` for long material.
- **Do** check any new orange text against the signal-text value.

### Don't:
- **Don't** put orange on body text, or use it decoratively as a second accent.
- **Don't** reintroduce green/amber/red verdicts on the landing page; they live on in the docs only.
- **Don't** wrap content in shadowed cards, or put a dark terminal window on a gradient.
- **Don't** add stat-card grids; numbers are condensed Archivo on a rule or an axis.
- **Don't** animate layout properties or add a second motion idea next to the thread.
- **Don't** add `style=""` attributes or `<style>` blocks (CSP).

## Known defects, not canonized

- Fixed during the finish pass: the scale marker briefly shared the class `.mark` with the install chapter's agent logos and broke them. The scale marker is `.pin` (and `.pin-range`); `.mark` is only the agent-logo glyph. Keep one class per job.
- The install field hard-codes `#fe4813` and `#0d0e10` instead of referencing tokens, and the page loads fonts from the Google Fonts CDN rather than self-hosting; both are build facts, not design rules.
- The code panel's soft drop shadow is recorded under Elevation as a single-use exception, not a vocabulary for new surfaces.
