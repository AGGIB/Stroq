# Repository guidance

Read CONTRIBUTING.md and SECURITY.md before changing behavior or reviewing a PR.
Use the checks in .github/workflows/ci.yml; merging and publishing are separate
steps. Preserve the private reporting process for bypasses of documented
protections.

## Code Review Rules

- Preserve the distinction between a host observing an action and actually
  blocking it. Flag claims of protection for unsupported or unmeasured channels;
  use recorded host fixtures and docs/AGENTS.md as evidence.
- Changes to classifiers, secret handling, installation pins, or hook decisions
  must retain negative cases and fail safely when input cannot be understood.
  Flag bypasses, lost provenance, credential exposure, and writes outside the
  intended project. Handle exploitable details privately under SECURITY.md.
- Review code against the acceptance criteria of linked issues. Tests with
  fabricated host input do not establish behavior of an unmeasured real host.
  Changes to .github/, these instructions, or agent policy require human review.
