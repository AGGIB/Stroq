# MITRE ATLAS — vendored denominator

`ATLAS-2026.08.yaml` is the unmodified `dist/v6/ATLAS-2026.08.yaml` from
<https://github.com/mitre-atlas/atlas-data>, fetched 2026-09-14.

|                |                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------ |
| Source         | `https://raw.githubusercontent.com/mitre-atlas/atlas-data/main/dist/v6/ATLAS-2026.08.yaml` |
| sha256         | `a8d32f676854cc57721c217ec5b39f07db518076dee4a6c1335df0a7bc8271a2`                         |
| Size           | 808,834 bytes                                                                              |
| Release        | `2026.08`                                                                                  |
| Format version | `6.0.0`                                                                                    |
| License        | Apache-2.0 (`LICENSE` in this directory), ©2021-2026 The MITRE Corporation                 |

It is vendored rather than fetched so the denominator Stroq measures itself
against is auditable in this repository and CI needs no network. It is not
published to npm: `pnpm build:atlas` derives `packages/cli/src/coverage/atlas.json`
from it, and that derived file is what ships.

Updating: re-run the `curl` above with the new release path, update the table,
run `pnpm build:atlas`, and commit both files together. `pnpm check:atlas` fails
if the committed JSON does not match a fresh derivation.
