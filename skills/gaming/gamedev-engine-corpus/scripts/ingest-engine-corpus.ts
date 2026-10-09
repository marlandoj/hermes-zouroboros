#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join, relative } from "node:path";

import { buildSparseVector, embeddings } from "../../../../integration/qdrant-corpus.ts";

const QDRANT_URL = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";
const DENSE_DIM = 1536;
const CHUNK_CHARS = 3_500;
const BATCH_SIZE = Math.max(1, Number(process.env.CORPUS_BATCH_SIZE) || 32);
const MAX_FILE_BYTES = 400_000;

export interface RepoSource {
  repo: string;
  url: string;
  license: string;
  root: string;
  kind: "docs" | "code" | "api";
  extensions: string[];
  excludePattern?: string;
}

export interface EngineConfig {
  engine: string;
  collection: string;
  repos: RepoSource[];
}

export interface PreparedChunk {
  id: string;
  text: string;
  payload: Record<string, unknown>;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".rst": "restructuredtext",
  ".md": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".gd": "gdscript",
  ".cs": "csharp",
  ".tscn": "godot-scene",
  ".godot": "godot-project",
  ".lua": "luau",
  ".luau": "luau",
  ".ts": "typescript",
  ".js": "javascript",
  ".h": "cpp",
  ".hpp": "cpp",
  ".inl": "cpp",
  ".cpp": "cpp",
  ".usf": "hlsl",
  ".ush": "hlsl",
  ".ini": "ini",
  ".udn": "udn",
};

export const ENGINE_CONFIGS: Record<string, EngineConfig> = {
  godot: {
    engine: "godot",
    collection: "godot-game-development",
    repos: [
      {
        repo: "godotengine/godot-docs",
        url: "https://github.com/godotengine/godot-docs",
        license: "CC-BY-3.0",
        root: "godot-docs",
        kind: "docs",
        extensions: [".rst"],
        excludePattern: "^\\.github/|^classes/",
      },
      {
        repo: "godotengine/godot-docs",
        url: "https://github.com/godotengine/godot-docs",
        license: "CC-BY-3.0",
        root: "godot-docs",
        kind: "api",
        extensions: [".rst"],
        excludePattern: "^(?!classes/)",
      },
      {
        repo: "godotengine/godot-demo-projects",
        url: "https://github.com/godotengine/godot-demo-projects",
        license: "MIT",
        root: "godot-demos",
        kind: "code",
        extensions: [".gd", ".cs", ".md", ".godot"],
        excludePattern: "^\\.github/|/addons/",
      },
    ],
  },
  unity: {
    engine: "unity",
    collection: "unity-game-development",
    repos: [
      {
        repo: "Unity-Technologies/Graphics",
        url: "https://github.com/Unity-Technologies/Graphics",
        license: "Unity-Companion-License",
        root: "u-Graphics",
        kind: "docs",
        extensions: [".md"],
        excludePattern: "^\\.github/|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|LICENSE",
      },
      {
        repo: "Unity-Technologies/InputSystem",
        url: "https://github.com/Unity-Technologies/InputSystem",
        license: "Unity-Companion-License",
        root: "u-InputSystem",
        kind: "docs",
        extensions: [".md"],
        excludePattern: "^\\.github/|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|LICENSE",
      },
      {
        repo: "Unity-Technologies/com.unity.netcode.gameobjects",
        url: "https://github.com/Unity-Technologies/com.unity.netcode.gameobjects",
        license: "Unity-Companion-License",
        root: "u-com.unity.netcode.gameobjects",
        kind: "docs",
        extensions: [".md"],
        excludePattern: "^\\.github/|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|LICENSE",
      },
      {
        repo: "Unity-Technologies/com.unity.cinemachine",
        url: "https://github.com/Unity-Technologies/com.unity.cinemachine",
        license: "Unity-Companion-License",
        root: "u-com.unity.cinemachine",
        kind: "docs",
        extensions: [".md"],
        excludePattern: "^\\.github/|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|LICENSE",
      },
      {
        repo: "Unity-Technologies/EntityComponentSystemSamples",
        url: "https://github.com/Unity-Technologies/EntityComponentSystemSamples",
        license: "Unity-Companion-License",
        root: "u-EntityComponentSystemSamples",
        kind: "code",
        extensions: [".md"],
        excludePattern: "^\\.github/|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|LICENSE",
      },
    ],
  },
  unreal: {
    engine: "unreal",
    collection: "unreal-game-development",
    repos: [
      {
        repo: "EpicGames/UnrealEngine",
        url: "https://github.com/EpicGames/UnrealEngine",
        license: "Unreal-Engine-EULA",
        root: "unreal-engine",
        kind: "docs",
        extensions: [".udn", ".md"],
        excludePattern: "^(?!Engine/)|^Engine/.*(CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT|LICENSE)",
      },
      {
        repo: "EpicGames/UnrealEngine",
        url: "https://github.com/EpicGames/UnrealEngine",
        license: "Unreal-Engine-EULA",
        root: "unreal-engine",
        kind: "api",
        extensions: [".h"],
        excludePattern: "^(?!Engine/(Source|Plugins)/)",
      },
      {
        repo: "EpicGames/UnrealEngine",
        url: "https://github.com/EpicGames/UnrealEngine",
        license: "Unreal-Engine-EULA",
        root: "unreal-engine",
        kind: "code",
        extensions: [".cpp", ".h", ".cs", ".ini", ".usf", ".ush"],
        excludePattern: "^(?!(Templates/|Samples/|Engine/Shaders/|Engine/Config/))",
      },
      {
        repo: "EpicGames/UnrealEngine",
        url: "https://github.com/EpicGames/UnrealEngine",
        license: "Unreal-Engine-EULA",
        root: "unreal-engine",
        kind: "code",
        extensions: [".cs"],
        excludePattern: "^(?!Engine/(Source|Plugins)/)",
      },
    ],
  },
  roblox: {
    engine: "roblox",
    collection: "roblox-game-development",
    repos: [
      {
        repo: "Roblox/creator-docs",
        url: "https://github.com/Roblox/creator-docs",
        license: "CC-BY-4.0",
        root: "roblox-creator-docs",
        kind: "docs",
        extensions: [".md"],
        excludePattern: "^\\.github/|/navigation/|CONTRIBUTING|CODE_OF_CONDUCT",
      },
      {
        repo: "Roblox/creator-docs",
        url: "https://github.com/Roblox/creator-docs",
        license: "CC-BY-4.0",
        root: "roblox-creator-docs",
        kind: "api",
        extensions: [".yaml"],
        excludePattern: "^\\.github/|/navigation/",
      },
    ],
  },
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function resolveLanguage(path: string): string {
  return LANGUAGE_BY_EXT[extname(path).toLowerCase()] || "text";
}

function splitOversized(value: string, maxChars: number): string[] {
  if (value.length <= maxChars) return [value];
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += maxChars) chunks.push(value.slice(offset, offset + maxChars));
  return chunks;
}

export function chunkText(text: string, maxChars = CHUNK_CHARS): string[] {
  const units = text.split(/\n{2,}/).flatMap((unit) => splitOversized(unit.trim(), maxChars)).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function stableId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function isIndexable(relativePath: string, source: RepoSource): boolean {
  if (!source.extensions.includes(extname(relativePath).toLowerCase())) return false;
  if (source.excludePattern && new RegExp(source.excludePattern).test(relativePath)) return false;
  return true;
}

async function collectFiles(root: string, source: RepoSource): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, full);
      if (!isIndexable(rel, source)) continue;
      if (statSync(full).size > MAX_FILE_BYTES) continue;
      found.push(full);
    }
  }
  await walk(root);
  return found.sort();
}

export function titleFor(relativePath: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1];
  if (heading) return heading.trim();
  const rstHeading = content.match(/^(.+)\n[=~^-]{3,}\s*$/m)?.[1];
  if (rstHeading) return rstHeading.trim();
  return relativePath;
}

async function prepareRepoChunks(
  config: EngineConfig,
  source: RepoSource,
  checkoutRoot: string,
  commit: string,
): Promise<PreparedChunk[]> {
  const root = join(checkoutRoot, source.root);
  const files = await collectFiles(root, source);
  const chunks: PreparedChunk[] = [];
  for (const file of files) {
    const rel = relative(root, file);
    const content = readFileSync(file, "utf8").trim();
    if (content.length < 80) continue;
    const title = titleFor(rel, content);
    const language = resolveLanguage(rel);
    const sha = createHash("sha256").update(content).digest("hex");
    const parts = chunkText(content);
    parts.forEach((part, index) => {
      const context = `Engine: ${config.engine}\nRepository: ${source.repo}\nDocument: ${title}\nType: ${source.kind}\nPath: ${rel}\n\n${part}`;
      chunks.push({
        id: stableId(`${config.engine}|${source.repo}|${source.kind}|${rel}|${sha}|${index}`),
        text: context,
        payload: {
          collection: config.collection,
          corpus: `${config.engine}-engine-conventions`,
          engine: config.engine,
          repo: source.repo,
          repo_url: source.url,
          license: source.license,
          commit,
          title,
          kind: source.kind,
          source: rel,
          language,
          chunk_index: index,
          chunk_total: parts.length,
          source_sha256: sha,
          content: part,
        },
      });
    });
  }
  return chunks;
}

function qHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_KEY) headers["api-key"] = QDRANT_KEY;
  return headers;
}

async function qRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: qHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`Qdrant ${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function ensureCollection(collection: string, recreate: boolean): Promise<void> {
  const existing = await fetch(`${QDRANT_URL}/collections/${collection}`, { headers: qHeaders() });
  if (existing.ok && recreate) await qRequest("DELETE", `/collections/${collection}`);
  if (existing.ok && !recreate) return;
  await qRequest("PUT", `/collections/${collection}`, {
    vectors: { dense: { size: DENSE_DIM, distance: "Cosine" } },
    sparse_vectors: { sparse: { modifier: "idf" } },
    on_disk_payload: true,
  });
}

function commitFor(checkoutRoot: string, root: string): string {
  try {
    return execFileSync("git", ["-C", join(checkoutRoot, root), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(`Usage: bun ingest-engine-corpus.ts --engine <${Object.keys(ENGINE_CONFIGS).join("|")}> --checkout-root <dir> [--collection name] [--dry-run] [--recreate]`);
    return;
  }
  const engine = arg("engine");
  const checkoutRoot = arg("checkout-root");
  if (!engine || !ENGINE_CONFIGS[engine]) {
    throw new Error(`--engine must be one of: ${Object.keys(ENGINE_CONFIGS).join(", ")}`);
  }
  if (!checkoutRoot) throw new Error("--checkout-root is required");
  const config = ENGINE_CONFIGS[engine];
  const collection = arg("collection") || config.collection;
  const dryRun = process.argv.includes("--dry-run");
  const recreate = process.argv.includes("--recreate");

  const chunks: PreparedChunk[] = [];
  const provenance: Record<string, string> = {};
  for (const source of config.repos) {
    const commit = commitFor(checkoutRoot, source.root);
    provenance[`${source.repo}:${source.kind}`] = commit;
    chunks.push(...(await prepareRepoChunks(config, source, checkoutRoot, commit)));
  }

  const counts = chunks.reduce<Record<string, number>>((result, chunk) => {
    const key = `${chunk.payload.repo}:${chunk.payload.kind}`;
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
  const documents = new Set(chunks.map((chunk) => `${chunk.payload.repo}:${chunk.payload.source}`)).size;
  console.log(JSON.stringify({ engine, collection, documents, chunks: chunks.length, counts, provenance, dryRun }, null, 2));
  if (dryRun) return;

  await ensureCollection(collection, recreate);
  let completed = 0;
  for (let offset = 0; offset < chunks.length; offset += BATCH_SIZE) {
    const batch = chunks.slice(offset, offset + BATCH_SIZE);
    const points = await Promise.all(batch.map(async (chunk) => {
      const dense = await embeddings(chunk.text);
      if (!dense.embedding?.length) throw new Error(`Empty embedding for ${chunk.id}`);
      const sparse = buildSparseVector(chunk.text);
      return {
        id: chunk.id,
        vector: { dense: dense.embedding, sparse: { indices: sparse.indices, values: sparse.values } },
        payload: chunk.payload,
      };
    }));
    await qRequest("PUT", `/collections/${collection}/points?wait=true`, { points });
    completed += points.length;
    if (completed % (BATCH_SIZE * 10) === 0 || completed === chunks.length) {
      console.log(`indexed ${completed}/${chunks.length}`);
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
