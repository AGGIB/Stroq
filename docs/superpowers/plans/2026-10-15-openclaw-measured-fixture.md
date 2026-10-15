# OpenClaw adapter replay fixture scope

The supplied `2026.10.3-darwin-arm64` fixture is a synthetic harness sequence at the
Stroq OpenClaw plugin-to-CLI boundary. The version and platform identify the
intended target. It does not resolve native Gateway wire-contract or enforcement
validation: original Gateway event/context pairs, plugin return values, and host
execution provenance are not retained.

## Included work

- Correct the shipped plugin package's extension entry format to `["./index.js"]`.
- Provide opt-in capture, recorder, and cleaner helpers for marked throwaway
  environments. Their output requires review before any native-host attestation.
- Preserve the supplied CLI inputs/responses, audit records, and seven disk
  snapshots for offline adapter replay.
- Test allowed execution/write/read/delete inputs, denied self-tamper, and a final
  write with no pre record. Disk transitions are harness observations.
- Document the absent plugin-byte restore proof, the unrecorded sentinel reset,
  and the mismatch between the final result's byte count and its supplied content.

## Verification

Run the focused offline replay and capture-helper tests, CLI type checks, and
format checks. They do not launch a native Gateway or make model requests.
Native host validation remains future work requiring separate execution provenance
and event/context evidence; synthetic replay must not be labeled a measured native
wire contract.
