# Source and license notice

This independent repository was assembled from the local Zouroboros VPS workspace. `provenance/workspace.json` records the source revision and original SHA-256 of each selected file. `factory/PROVENANCE.json` records the Factory adaptations separately. The Muse repository was read as a product reference, not copied or forked.

The root MIT license covers new integration code and inherited source already marked MIT. Package-level declarations remain authoritative. `packages/control-plane` and `packages/capability-runtime` are private, UNLICENSED packages; inclusion here does not grant a new redistribution license. This release is initially private.

The upstream CLI is retained to validate its portable configuration/state contract. Its optional bundled skills, TUI and standalone self-healing probe scripts are excluded. Imported package READMEs describe upstream capabilities and are reference material; the root README defines this distribution's supported surface.

Hermes Agent and external harnesses are separate installations, not vendored here. The observation hook credits rohitg00/agentmemory in its source. Dependencies retain their respective package licenses.
