# Distribution adaptations

- Imported runtime package files are copied from the revision in `workspace.json`; generated `dist` output is excluded from Git.
- `packages/control-plane/tsconfig.json` and `packages/capability-runtime/tsconfig.json` remove the source host's absolute `typeRoots`. TypeScript now resolves types from the installed workspace dependencies. The original and distributed hashes are both retained in `workspace.json`.
- The root package/workspace manifests are new and use a dedicated lockfile. The upstream root postbuild/init hooks are not executed.
- New `integration/` provides the profile, CLI, MCP and bounded swarm worker. It selects a dedicated `hermes-vps` executor to avoid production model-router defaults.
- The worker disables production-installation seed/gap audits and automatic RAG enrichment. Its task contract validates the DAG, and post-flight result evaluation remains enabled. This is an explicit release boundary, not evidence of production Factory certification.
- Factory TypeScript intake requires explicit board and manifest paths; production defaults were removed. Python offline intake is retained with original tests.
- Live settings, identities, memories, model catalogs, run results, credentials, and host service configuration are not exported.
