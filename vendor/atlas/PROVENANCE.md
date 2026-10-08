# MITRE ATLAS — vendored denominator

`ATLAS-2026.09.yaml` is the unmodified `dist/v6/ATLAS-2026.09.yaml` from
<https://github.com/mitre-atlas/atlas-data>, fetched 2026-10-04.

|                |                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------ |
| Source         | `https://raw.githubusercontent.com/mitre-atlas/atlas-data/main/dist/v6/ATLAS-2026.09.yaml` |
| sha256         | `935efa93e28294432d3e2f537eb94991ef8d1f8c58341cd360ea3321ddb66688`                         |
| Size           | 841,482 bytes                                                                              |
| Release        | `2026.09`                                                                                  |
| Format version | `6.0.0`                                                                                    |
| License        | Apache-2.0 (`LICENSE` in this directory), ©2021-2026 The MITRE Corporation                 |

It is vendored rather than fetched so the denominator Stroq measures itself
against is auditable in this repository and CI needs no network. It is not
published to npm: `pnpm build:atlas` derives `packages/cli/src/coverage/atlas.json`
from it, and that derived file is what ships.

Updating: re-run the `curl` above with the new release path, update the table,
run `pnpm build:atlas`, and commit both files together. `pnpm check:atlas` fails
if the committed JSON does not match a fresh derivation.
