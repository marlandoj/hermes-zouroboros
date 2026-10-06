# Contributing

Keep distribution behavior under `integration/`, `factory/`, `deploy/`, and `docs/`. Changes to imported package source should preserve attribution and be described in `provenance/ADAPTATIONS.md`.

Run the verification commands in the README. Use fake executables and temporary databases in tests; never invoke a live paid provider in CI. Document the caller for each added capability and its configuration, failure behavior, and authority boundary.

Do not commit credentials, provider profiles, memory data, compiled output, dependency directories, or local task artifacts. Package-level licenses must be preserved.
