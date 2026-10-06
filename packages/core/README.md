# zouroboros-core

> Core types, configuration, and utilities for Zouroboros

## Installation

```bash
npm install zouroboros-core
# or
pnpm add zouroboros-core
```

## Usage

```typescript
import { 
  loadConfig, 
  saveConfig, 
  setConfigValue, 
  DEFAULT_CONFIG,
  getWorkspaceRoot,
  ZouroborosConfig 
} from 'zouroboros-core';

// Load configuration
const config = loadConfig();

// Get a nested value
const dbPath = getConfigValue<string>(config, 'memory.dbPath');

// Update configuration
const updated = setConfigValue(config, 'memory.autoCapture', false);
saveConfig(updated);

// Initialize new configuration
const newConfig = await initConfig({
  workspaceRoot: getWorkspaceRoot(),
  dataDir: '/home/user/.zouroboros'
});
```

## Portable Runtime

Zouroboros resolves configuration and state through XDG directories on Linux:

| Purpose | Default |
|---|---|
| Configuration | `$XDG_CONFIG_HOME/zouroboros` or `~/.config/zouroboros` |
| Data | `$XDG_DATA_HOME/zouroboros` or `~/.local/share/zouroboros` |
| Cache | `$XDG_CACHE_HOME/zouroboros` or `~/.cache/zouroboros` |
| State and logs | `$XDG_STATE_HOME/zouroboros` or `~/.local/state/zouroboros` |
| Runtime | `$XDG_RUNTIME_DIR/zouroboros` or the state directory |

Canonical `ZOUROBOROS_*` variables override legacy `ZO_*` variables. Explicit
API or CLI values override both. Secrets are stored only as `env` or absolute
`file` references; required unresolved references fail startup validation.
Configuration loading validates structure and secret references without requiring
a capability inventory. Call `enforceCapabilityAvailability` or pass
`availableCapabilities` when startup must prove every required capability exists.

Portable state APIs export schema-versioned manifests with relative paths,
sizes, roles, and SHA-256 digests. Import validates the entire bundle and all
destinations before the first write, relocates configuration paths to the
target runtime, and rolls back prior files if a commit fails.

## API

### Types

All core types are exported from this package:

- `ZouroborosConfig` - Main configuration interface
- `MemoryConfig`, `MemoryEntry`, `EpisodicMemory` - Memory system types
- `SwarmConfig`, `SwarmCampaign`, `SwarmTask` - Swarm orchestration types
- `Persona`, `SafetyRule` - Persona management types
- `SeedSpec`, `EvaluationReport` - Workflow types
- And more...

### Configuration

- `loadConfig(path?)` - Load configuration from file
- `saveConfig(config, path?)` - Save configuration to file
- `initConfig(options?)` - Initialize new configuration
- `getConfigValue(config, path)` - Get nested config value
- `setConfigValue(config, path, value)` - Set nested config value
- `validateConfig(config)` - Validate configuration structure
- `mergeConfig(partial)` - Merge partial config with defaults
- `resolveRuntimeDirectories(options?)` - Resolve portable XDG and override paths

### Portable State

- `exportStateBundle(options)` - Export explicit state files to a portable bundle
- `validateStateBundle(bundleDir, options?)` - Validate schema, roles, paths, sizes, and digests
- `migrateStateBundle(source, destination)` - Migrate a supported bundle schema
- `importStateBundle(bundleDir, options)` - Transactionally import to explicit allowed roots
- `createBackup(options?)` - Snapshot configured runtime state, including live SQLite
- `restoreBackup(bundleDir, options?)` - Relocate and restore a portable backup
- `migrateLegacyBackup(source, destination)` - Convert a validated legacy backup without live import
- `pruneBackups(config, keep)` - Explicitly remove backups beyond the requested retention count

### Constants

- `DEFAULT_CONFIG` - Default configuration object
- `DEFAULT_CONFIG_PATH` - Default configuration file path
- `ZOUROBOROS_VERSION` - Current version
- `DECAY_DAYS` - Memory decay periods
- `COMPLEXITY_THRESHOLDS` - Complexity scoring thresholds
- And more...

### Utilities

- `generateUUID()` - Generate UUID v4
- `now()` - Get current ISO timestamp
- `retry(fn, options)` - Retry with exponential backoff
- `formatBytes(bytes)` - Format bytes to human readable
- `formatDuration(ms)` - Format milliseconds to duration
- `deepMerge(target, source)` - Deep merge objects
- And more...

## License

MIT
