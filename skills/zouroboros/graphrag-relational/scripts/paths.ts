// Portable locations for graphrag-relational. Nothing is written inside the skill tree.
//   source inputs   --factory-dir, else GRAPHRAG_FACTORY_DIR (swarm.db, state/factory-log.jsonl, state/exec-*.json);
//                   no default: the skill never guesses a host project path
//   graph + state   GRAPHRAG_DB_DIR, else <ZOUROBOROS_STATE_DIR>/graphrag-relational/{falkordblite,graphrag-state.json}
//   Redis cache     GRAPHRAG_CACHE_DIR, else <ZOUROBOROS_CACHE_DIR>/falkordblite (built on first use, never at install)
// The state and cache roots fall back to the hermes-zouroboros profile data directory.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

function dataDir(env: Env): string {
  return resolve(env.HERMES_ZOUROBOROS_HOME || join(env.XDG_DATA_HOME || join(homedir(), ".local/share"), "hermes-zouroboros"));
}

export function stateDir(env: Env = process.env): string {
  return resolve(env.GRAPHRAG_DB_DIR || join(env.ZOUROBOROS_STATE_DIR || join(dataDir(env), "state"), "graphrag-relational"));
}

export function defaultDbPath(env: Env = process.env): string {
  return join(stateDir(env), "falkordblite");
}

export function defaultIndexStatePath(env: Env = process.env): string {
  return join(stateDir(env), "graphrag-state.json");
}

export function cacheDir(env: Env = process.env): string {
  return resolve(env.GRAPHRAG_CACHE_DIR || join(env.ZOUROBOROS_CACHE_DIR || join(dataDir(env), "cache"), "falkordblite"));
}

export function factoryDir(env: Env = process.env): string | null {
  return env.GRAPHRAG_FACTORY_DIR ? resolve(env.GRAPHRAG_FACTORY_DIR) : null;
}

/** Source inputs under a factory directory: <dir>/swarm.db and <dir>/state/{factory-log.jsonl,exec-*.json}. */
export function factorySources(dir: string) {
  return {
    swarmDbPath: join(dir, "swarm.db"),
    factoryLogPath: join(dir, "state", "factory-log.jsonl"),
    stateDir: join(dir, "state"),
  };
}

export const NO_SOURCE_MESSAGE =
  "No source configured: pass --factory-dir <dir> (or set GRAPHRAG_FACTORY_DIR), or name the inputs with --swarm-db/--factory-log/--state-dir/--tickets-json";
