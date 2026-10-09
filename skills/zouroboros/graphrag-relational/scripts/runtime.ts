import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheDir as defaultCacheDir } from "./paths.ts";

// falkordblite (MIT) is a dependency of this skill only, installed with `bun install` in the skill
// directory. It is loaded on first use so that extraction, validation and the offline tests run
// without it; these are the parts of its API the skill uses.
export interface GraphResult<T> { data?: T[] }
export interface Graph {
  query<T = unknown>(query: string, options?: { params?: Record<string, unknown> }): Promise<GraphResult<T>>;
  roQuery<T = unknown>(query: string, options?: { params?: Record<string, unknown> }): Promise<GraphResult<T>>;
}
interface FalkorDBLite {
  pid: number | undefined;
  socketPath: string;
  selectGraph(name: string): Graph;
  close(): Promise<void>;
}
interface FalkorDBLiteModule {
  FalkorDB: { open(options: Record<string, unknown>): Promise<FalkorDBLite> };
}
const FALKORDBLITE = "falkordblite";
const PLATFORM_PACKAGE = "@falkordblite/linux-x64";

export const REDIS_VERSION = "8.2.3";
export const REDIS_SOURCE_URL = `https://github.com/redis/redis/archive/refs/tags/${REDIS_VERSION}.tar.gz`;
export const REDIS_SOURCE_SHA256 = "42d4d3f037db92eea4437ba03f87627cd636ed15a1f2dde7af9650aa94b035d8";
export const FALKORDB_MODULE_SHA256 = "7e9e39ce69780fbae2cf7a31c28e05a51b4e9177b73e755384de0c3cf9f812e5";

interface RuntimeReceipt {
  version: 1;
  redis_version: string;
  source_url: string;
  source_sha256: string;
  binary_sha256: string;
  built_at: string;
}

export interface EmbeddedGraphOptions {
  path: string;
  graphName?: string;
  cacheDir?: string;
  redisServerPath?: string;
  modulePath?: string;
  timeoutMs?: number;
}

export interface EmbeddedGraphSession {
  graph: Graph;
  redisServerPath: string;
  modulePath: string;
  pid: number | undefined;
  socketPath: string;
  close(): Promise<void>;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

function validateExecutable(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Redis server not found: ${resolved}`);
  return resolved;
}

function resolveModulePath(override?: string): string {
  const path = override
    ? resolve(override)
    : resolve(dirname(fileURLToPath(import.meta.resolve(PLATFORM_PACKAGE))), "bin/falkordb.so");
  if (!existsSync(path)) throw new Error(`FalkorDB module not found: ${path}`);
  const digest = sha256File(path);
  if (digest !== FALKORDB_MODULE_SHA256) {
    throw new Error(`FalkorDB module checksum mismatch: expected ${FALKORDB_MODULE_SHA256}, got ${digest}`);
  }
  return path;
}

function readValidReceipt(binaryPath: string, receiptPath: string): RuntimeReceipt | null {
  if (!existsSync(binaryPath) || !existsSync(receiptPath)) return null;
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as RuntimeReceipt;
    if (
      receipt.version !== 1 ||
      receipt.redis_version !== REDIS_VERSION ||
      receipt.source_sha256 !== REDIS_SOURCE_SHA256 ||
      receipt.binary_sha256 !== sha256File(binaryPath)
    ) return null;
    return receipt;
  } catch {
    return null;
  }
}

/** A build lock left by a killed process (older than the longest plausible build) is removed. */
const STALE_LOCK_MS = 30 * 60_000;
function clearStaleLock(lockPath: string): void {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // no lock
  }
}

async function waitForConcurrentBuild(binaryPath: string, receiptPath: string, lockPath: string): Promise<string | null> {
  for (let attempt = 0; attempt < 900; attempt++) {
    if (readValidReceipt(binaryPath, receiptPath)) return binaryPath;
    if (!existsSync(lockPath)) return null;
    await Bun.sleep(1_000);
  }
  throw new Error(`Timed out waiting for Redis ${REDIS_VERSION} build lock`);
}

export async function ensureRedisServer(options: Pick<EmbeddedGraphOptions, "cacheDir" | "redisServerPath"> = {}): Promise<string> {
  if (options.redisServerPath) return validateExecutable(options.redisServerPath);
  if (process.env.FALKORDBLITE_REDIS_SERVER) return validateExecutable(process.env.FALKORDBLITE_REDIS_SERVER);

  const cacheDir = resolve(options.cacheDir ?? defaultCacheDir());
  const binaryPath = join(cacheDir, `redis-server-${REDIS_VERSION}`);
  const receiptPath = `${binaryPath}.receipt.json`;
  const lockPath = `${binaryPath}.lock`;
  if (readValidReceipt(binaryPath, receiptPath)) return binaryPath;
  const refusal = buildRefusal();
  if (refusal) throw new Error(`Redis ${REDIS_VERSION} is not cached in ${cacheDir} and ${refusal}; set FALKORDBLITE_REDIS_SERVER to a verified binary`);

  mkdirSync(cacheDir, { recursive: true });
  clearStaleLock(lockPath);
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const concurrent = await waitForConcurrentBuild(binaryPath, receiptPath, lockPath);
    if (concurrent) return concurrent;
    mkdirSync(lockPath);
  }

  const buildRoot = mkdtempSync(join(tmpdir(), "zouroboros-redis-build-"));
  const archivePath = join(buildRoot, `redis-${REDIS_VERSION}.tar.gz`);
  const stagedBinary = `${binaryPath}.tmp-${process.pid}`;
  const stagedReceipt = `${receiptPath}.tmp-${process.pid}`;
  try {
    const response = await fetch(REDIS_SOURCE_URL);
    if (!response.ok) throw new Error(`Redis source download failed: HTTP ${response.status}`);
    writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
    const sourceDigest = sha256File(archivePath);
    if (sourceDigest !== REDIS_SOURCE_SHA256) {
      throw new Error(`Redis source checksum mismatch: expected ${REDIS_SOURCE_SHA256}, got ${sourceDigest}`);
    }
    await run("tar", ["-xzf", archivePath, "-C", buildRoot]);
    const sourceDir = join(buildRoot, `redis-${REDIS_VERSION}`);
    // OPTIMIZATION=-O2 drops Redis' default -flto: GCC 15's LTO linker plugin crashes under make -j.
    await run("make", ["-j2", "BUILD_TLS=no", "MALLOC=libc", "OPTIMIZATION=-O2", "redis-server"], join(sourceDir, "src"));
    const builtBinary = join(sourceDir, "src", "redis-server");
    if (!existsSync(builtBinary)) throw new Error("Redis build completed without redis-server");
    copyFileSync(builtBinary, stagedBinary);
    chmodSync(stagedBinary, 0o755);
    const receipt: RuntimeReceipt = {
      version: 1,
      redis_version: REDIS_VERSION,
      source_url: REDIS_SOURCE_URL,
      source_sha256: REDIS_SOURCE_SHA256,
      binary_sha256: sha256File(stagedBinary),
      built_at: new Date().toISOString(),
    };
    writeFileSync(stagedReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
    renameSync(stagedBinary, binaryPath);
    renameSync(stagedReceipt, receiptPath);
    return binaryPath;
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
    rmSync(stagedBinary, { force: true });
    rmSync(stagedReceipt, { force: true });
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/** Why a first-use download and build must not run here, or null when it may. CI never builds Redis. */
export function buildRefusal(env: Record<string, string | undefined> = process.env): string | null {
  if (env.GRAPHRAG_NO_BUILD === "1") return "GRAPHRAG_NO_BUILD=1 forbids the first-use build";
  if (env.CI && env.CI !== "false") return "the first-use build is disabled in CI";
  return null;
}

async function loadFalkorDB(): Promise<FalkorDBLiteModule> {
  try {
    return (await import(FALKORDBLITE)) as FalkorDBLiteModule;
  } catch (error) {
    throw new Error(`falkordblite is not installed; run \`bun install\` in the graphrag-relational skill directory (${error instanceof Error ? error.message : String(error)})`);
  }
}

export async function openEmbeddedGraph(options: EmbeddedGraphOptions): Promise<EmbeddedGraphSession> {
  const { FalkorDB } = await loadFalkorDB();
  const redisServerPath = await ensureRedisServer(options);
  const modulePath = resolveModulePath(options.modulePath);
  const database = await FalkorDB.open({
    path: resolve(options.path),
    redisServerPath,
    modulePath,
    timeout: options.timeoutMs ?? 20_000,
    logLevel: "warning",
  });
  const graph = database.selectGraph(options.graphName ?? "zouroboros");
  return {
    graph,
    redisServerPath,
    modulePath,
    pid: database.pid,
    socketPath: database.socketPath,
    close: () => database.close(),
  };
}

// `bun scripts/runtime.ts prepare` runs the first-use download and build explicitly (for example
// before the live tests) and prints the verified binary path.
if (import.meta.main) {
  const [command] = process.argv.slice(2);
  if (command !== "prepare") {
    console.error("usage: bun scripts/runtime.ts prepare");
    process.exit(2);
  }
  ensureRedisServer()
    .then((path) => console.log(path))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
