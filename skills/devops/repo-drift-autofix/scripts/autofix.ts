#!/usr/bin/env bun
/**
 * repo-drift-autofix — commit + push + draft PR for in-scope local git drift.
 *
 * Usage:
 *   bun autofix.ts [--repo <path>] [--dry-run] [--help]
 *
 * Exits:
 *   0  — work done, nothing to do, or a policy skip (reason in the JSON `error` field)
 *   1  — unrecoverable error (missing repo path, etc.)
 *   2  — usage error
 *
 * Audit log: REPO_DRIFT_AUTOFIX_LOG, else <ZOUROBOROS_LOG_DIR>/repo-drift-autofix.log, where
 * ZOUROBOROS_LOG_DIR falls back to logs/ in the hermes-zouroboros profile data directory.
 *
 * Remote-write kill switch: REPO_DRIFT_GITHUB_WRITES_DISABLED=1 or
 * ZOUROBOROS_GITHUB_WRITES_DISABLED=1 blocks every `git push` and `gh` write and records the block.
 *
 * --dry-run reads the repo, classifies the drift and runs the scans and the quality gate, but
 * never stages, commits, pushes or opens a PR. Its only write is the audit-log line.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ─── Config ────────────────────────────────────────────────────────────────
type Env = Record<string, string | undefined>;

export function auditLogPath(env: Env = process.env): string {
  if (env.REPO_DRIFT_AUTOFIX_LOG) return env.REPO_DRIFT_AUTOFIX_LOG;
  const dataDir = resolve(
    env.HERMES_ZOUROBOROS_HOME || join(env.XDG_DATA_HOME || join(homedir(), ".local/share"), "hermes-zouroboros"),
  );
  return join(env.ZOUROBOROS_LOG_DIR || join(dataDir, "logs"), "repo-drift-autofix.log");
}

const AUDIT_LOG = auditLogPath();
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const QUALITY_GATE_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 30_000;
const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "release", "HEAD"]);

/** Remote-write kill switch. Set either variable to "1" to fail closed on any GitHub write. */
const GITHUB_WRITES_DISABLED =
  process.env.REPO_DRIFT_GITHUB_WRITES_DISABLED === "1" || process.env.ZOUROBOROS_GITHUB_WRITES_DISABLED === "1";

const SECRET_PATTERNS: RegExp[] = [
  /sk_live_[a-zA-Z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
  /ghp_[a-zA-Z0-9]{36}/,
  /gho_[a-zA-Z0-9]{36}/,
  /-----BEGIN CERTIFICATE-----/,
  /eyJ[a-zA-Z0-9+/]{40,}\.[a-zA-Z0-9+/]{10,}\.[a-zA-Z0-9+/]{10,}/, // JWT
];

const USAGE = `Usage: bun autofix.ts [--repo <path>] [--dry-run] [--help]

Clusters uncommitted files by their top two directories, commits the clusters that match the
current branch's scope tokens, pushes the branch and opens a draft PR. Refuses protected
(main, master, develop, release) and autoloop/* branches and branches whose PR already merged.
Blocks on files over 5MB, secret-shaped content, or a failing \`tsc --noEmit\`.

  --repo <path>   repository to operate on (default: current directory)
  --dry-run       classify and check only; no stage, commit, push or PR
  --help          show this help

Audit log: ${"$"}REPO_DRIFT_AUTOFIX_LOG, else ${"$"}ZOUROBOROS_LOG_DIR/repo-drift-autofix.log
Kill switch: REPO_DRIFT_GITHUB_WRITES_DISABLED=1 (or ZOUROBOROS_GITHUB_WRITES_DISABLED=1)`;

// ─── Types ─────────────────────────────────────────────────────────────────
interface Cluster {
  dir: string;
  files: string[];
  matchesBranchScope: boolean;
}

interface ClusterResult {
  dir: string;
  files: string[];
  committed: boolean;
  sha?: string;
  skippedReason?: string;
}

interface AutofixResult {
  repo: string;
  branch: string;
  dryRun: boolean;
  qualityGatePassed: boolean;
  qualityGateError?: string;
  qualityGateNote?: string;
  inScopeCount: number;
  outlierCount: number;
  clusters: ClusterResult[];
  outliers: { dir: string; files: string[] }[];
  prUrl?: string;
  prAlreadyExists?: boolean;
  error?: string;
}

// ─── Process helpers (argv arrays, never a shell) ──────────────────────────
interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function isGithubWrite(argv: string[]): boolean {
  const [cmd, sub] = argv;
  if (cmd === "git") return sub === "push";
  if (cmd === "gh") {
    // Read-only gh calls used here: `gh pr list`. Everything else counts as a write.
    return !(sub === "pr" && argv[2] === "list");
  }
  return false;
}

function run(argv: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS, input?: string): RunResult {
  if (GITHUB_WRITES_DISABLED && isGithubWrite(argv)) {
    auditLog({ blocked: true, cwd, cmd: argv.slice(0, 3).join(" ") });
    return {
      ok: false,
      stdout: "",
      stderr: "blocked: GitHub writes disabled (REPO_DRIFT_GITHUB_WRITES_DISABLED / ZOUROBOROS_GITHUB_WRITES_DISABLED)",
      timedOut: false,
    };
  }
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    input,
  });
  return {
    ok: r.status === 0 && !r.error,
    stdout: (r.stdout || "").replace(/[\r\n]+$/, ""),
    stderr: (r.stderr || (r.error ? String(r.error.message) : "")).trim(),
    timedOut: Boolean(r.error?.message?.includes("ETIMEDOUT")) || r.signal === "SIGTERM",
  };
}

// ─── Git helpers ────────────────────────────────────────────────────────────
function getBranch(repo: string): string {
  return run(["git", "branch", "--show-current"], repo).stdout;
}

function getUncommittedFiles(repo: string): string[] {
  // -z: NUL-separated, unquoted paths; renames carry the source path as a second record.
  const r = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
    cwd: repo,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  if (r.status !== 0) return [];
  const records = (r.stdout || "").split("\0");
  const files: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.length < 4) continue;
    const status = rec.slice(0, 2);
    files.push(rec.slice(3));
    if (status.includes("R") || status.includes("C")) i++; // skip the original path
  }
  return files;
}

function prUrl(repo: string, branch: string, state?: "merged"): string | null {
  const argv = ["gh", "pr", "list", "--head", branch, "--json", "url", "--jq", ".[0].url"];
  if (state) argv.splice(5, 0, "--state", state);
  const url = run(argv, repo, 15_000).stdout.trim();
  return url && url.startsWith("http") ? url : null;
}

// ─── Clustering ─────────────────────────────────────────────────────────────
function clusterByTopDir(files: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of files) {
    const parts = f.split("/");
    // Group at 2 levels: e.g. "packages/swarm" or "skills/devops"
    const key = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(f);
  }
  return map;
}

function extractScopeTokens(branch: string): string[] {
  // feat/swarm-t3-refactor → ["swarm", "refactor"] (tokens shorter than 3 chars are dropped)
  const stripped = branch.replace(/^(?:feat|fix|chore|refactor|docs|test|ci)\//, "");
  return stripped
    .split(/[-_/]/)
    .filter((t) => t.length >= 3)
    .map((t) => t.toLowerCase());
}

function clusterInScope(clusterKey: string, scopeTokens: string[]): boolean {
  const k = clusterKey.toLowerCase();
  return scopeTokens.some((t) => k.includes(t));
}

// ─── Safety scan ────────────────────────────────────────────────────────────
function scanForProblems(files: string[], repo: string): string[] {
  const problems: string[] = [];
  for (const f of files) {
    const fullPath = join(repo, f);
    try {
      const st = statSync(fullPath);
      if (st.size > MAX_FILE_BYTES) {
        problems.push(`${f}: too large (${(st.size / 1024 / 1024).toFixed(1)}MB > 5MB limit)`);
        continue;
      }
      if (st.isDirectory()) continue;
      const content = readFileSync(fullPath, "utf8");
      for (const pat of SECRET_PATTERNS) {
        if (pat.test(content)) {
          problems.push(`${f}: possible secret pattern (${pat.source.slice(0, 30)}...)`);
          break;
        }
      }
    } catch {
      // deleted, binary or unreadable — skip
    }
  }
  return problems;
}

// ─── Quality gate ────────────────────────────────────────────────────────────
function runQualityGate(repo: string): { passed: boolean; error?: string; note?: string } {
  if (!existsSync(join(repo, "tsconfig.json"))) {
    return { passed: true, note: "no tsconfig.json at the repo root; tsc gate not applicable" };
  }
  const hasPnpm = existsSync(join(repo, "pnpm-workspace.yaml")) || existsSync(join(repo, "pnpm-lock.yaml"));
  const hasBun = existsSync(join(repo, "bun.lockb")) || existsSync(join(repo, "bun.lock"));
  // Use the locally installed compiler only; never download one.
  const argv = hasPnpm
    ? ["pnpm", "exec", "tsc", "--noEmit"]
    : hasBun
      ? ["bun", "run", "--bun", "tsc", "--noEmit"]
      : ["npx", "--no-install", "tsc", "--noEmit"];
  const r = run(argv, repo, QUALITY_GATE_TIMEOUT_MS);
  if (r.timedOut) {
    return { passed: false, error: `tsc timed out after ${QUALITY_GATE_TIMEOUT_MS / 1000}s` };
  }
  if (!r.ok) {
    const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-5).join(" | ");
    return { passed: false, error: `tsc failed: ${tail}` };
  }
  return { passed: true };
}

// ─── Commit message ──────────────────────────────────────────────────────────
function buildCommitMessage(clusterKey: string, files: string[], branch: string): string {
  const parts = clusterKey.split("/");
  const scope = parts[parts.length - 1] || clusterKey;
  const listed = files
    .slice(0, 12)
    .map((f) => `  - ${f}`)
    .join("\n");
  const extra = files.length > 12 ? `\n  ... and ${files.length - 12} more` : "";
  return [
    `wip(${scope}): auto-commit ${files.length} file(s) [repo-drift-autofix]`,
    "",
    `Files:\n${listed}${extra}`,
    "",
    `Branch: ${branch}`,
    `Auto-committed by repo-drift-autofix`,
  ].join("\n");
}

// ─── Audit log ───────────────────────────────────────────────────────────────
function auditLog(entry: object): void {
  try {
    mkdirSync(dirname(AUDIT_LOG), { recursive: true });
    appendFileSync(AUDIT_LOG, `${new Date().toISOString()} ${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.error(`(warn) audit log not written: ${(err as Error).message}`);
  }
}

function finish(result: AutofixResult, extra: Record<string, unknown> = {}): never {
  console.log(JSON.stringify({ ...result, ...extra }, null, 2));
  auditLog({ ...result, ...extra });
  process.exit(0);
}

// ─── Main ────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { dryRun: boolean; repo: string } {
  let dryRun = false;
  let repo = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (a === "--dry-run") dryRun = true;
    else if (a === "--repo") {
      const v = argv[++i];
      if (!v) {
        console.error("--repo requires a path");
        process.exit(2);
      }
      repo = v;
    } else {
      console.error(`Unknown option: ${a}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  return { dryRun, repo: resolve(repo) };
}

function main(): void {
  const { dryRun, repo } = parseArgs(process.argv.slice(2));
  if (!existsSync(repo)) {
    console.error(JSON.stringify({ error: `Repo path not found: ${repo}` }));
    process.exit(1);
  }

  const result: AutofixResult = {
    repo,
    branch: "",
    dryRun,
    qualityGatePassed: false,
    inScopeCount: 0,
    outlierCount: 0,
    clusters: [],
    outliers: [],
  };

  try {
    // 1. Branch guards
    const branch = getBranch(repo);
    result.branch = branch;
    if (!branch) {
      result.error = "Detached HEAD or no branch — skipped";
      finish(result);
    }
    if (branch.startsWith("autoloop/")) {
      result.error = "autoloop/* branch — skipped per policy";
      finish(result);
    }
    if (PROTECTED_BRANCHES.has(branch)) {
      result.error = `Protected branch '${branch}' — autofix never commits to protected branches`;
      finish(result);
    }

    // A branch whose PR already merged is "spent": piling more drift onto it accumulates
    // orphan commits and junk draft PRs. Skip — continuation work is committed by a human.
    const mergedPr = prUrl(repo, branch, "merged");
    if (mergedPr) {
      result.error = `Branch '${branch}' already has a merged PR (${mergedPr}) — spent branch, autofix skipped`;
      finish(result);
    }

    // 2. Uncommitted files
    const files = getUncommittedFiles(repo);
    if (files.length === 0) {
      result.qualityGatePassed = true;
      console.log(JSON.stringify({ ...result, message: "No uncommitted files — nothing to do" }, null, 2));
      process.exit(0);
    }

    // 3. Cluster + classify
    const scopeTokens = extractScopeTokens(branch);
    const inScopeClusters: Cluster[] = [];
    const outlierClusters: Cluster[] = [];
    for (const [dir, clusterFiles] of clusterByTopDir(files)) {
      const inScope = clusterInScope(dir, scopeTokens);
      (inScope ? inScopeClusters : outlierClusters).push({ dir, files: clusterFiles, matchesBranchScope: inScope });
    }
    result.inScopeCount = inScopeClusters.reduce((n, c) => n + c.files.length, 0);
    result.outlierCount = outlierClusters.reduce((n, c) => n + c.files.length, 0);
    result.outliers = outlierClusters.map((c) => ({ dir: c.dir, files: c.files }));

    if (inScopeClusters.length === 0) {
      result.qualityGatePassed = true;
      result.error = "All uncommitted files are outliers (no scope match) — no auto-commit";
      finish(result);
    }

    // 4. Safety scan on in-scope files
    const problems = scanForProblems(inScopeClusters.flatMap((c) => c.files), repo);
    if (problems.length > 0) {
      result.error = `Safety scan blocked: ${problems.join("; ")}`;
      finish(result);
    }

    // 5. Quality gate
    const gate = runQualityGate(repo);
    result.qualityGatePassed = gate.passed;
    if (gate.note) result.qualityGateNote = gate.note;
    if (!gate.passed) {
      result.qualityGateError = gate.error;
      result.error = "Quality gate failed — skipping auto-commit";
      finish(result);
    }

    // 6. Commit each in-scope cluster
    for (const cluster of inScopeClusters) {
      const clusterResult: ClusterResult = { dir: cluster.dir, files: cluster.files, committed: false };
      if (dryRun) {
        clusterResult.skippedReason = "dry-run";
        result.clusters.push(clusterResult);
        continue;
      }

      const addResult = run(["git", "add", "-A", "--", ...cluster.files], repo);
      if (!addResult.ok) {
        clusterResult.skippedReason = `git add failed: ${addResult.stderr}`;
        result.clusters.push(clusterResult);
        continue;
      }

      // The message goes through stdin (`-F -`), never through a shell.
      const msg = buildCommitMessage(cluster.dir, cluster.files, branch);
      const commitResult = run(["git", "commit", "-F", "-", "--no-verify"], repo, GIT_TIMEOUT_MS, msg);
      if (!commitResult.ok) {
        clusterResult.skippedReason = `git commit failed: ${commitResult.stderr}`;
        run(["git", "restore", "--staged", "--", ...cluster.files], repo);
        result.clusters.push(clusterResult);
        continue;
      }

      clusterResult.committed = true;
      clusterResult.sha = run(["git", "rev-parse", "--short", "HEAD"], repo).stdout;
      result.clusters.push(clusterResult);
    }

    const anyCommitted = result.clusters.some((c) => c.committed);

    // 7. Push
    if (anyCommitted && !dryRun) {
      const pushResult = run(["git", "push", "origin", branch], repo, 60_000);
      if (!pushResult.ok) {
        result.error = `Push failed: ${pushResult.stderr}`;
        // Commits stay local — don't roll back, just report.
        finish(result);
      }
    }

    // 8. Draft PR (only if none exists)
    if (anyCommitted && !dryRun) {
      const existingPrUrl = prUrl(repo, branch);
      if (existingPrUrl) {
        result.prUrl = existingPrUrl;
        result.prAlreadyExists = true;
      } else {
        const committedClusters = result.clusters.filter((c) => c.committed);
        const prTitle = `wip: ${branch} — auto-committed ${result.inScopeCount} file(s) [repo-drift-autofix]`;
        const prBody = [
          "## Auto-committed by repo-drift-autofix",
          "",
          "**Branch scope:** `" + branch + "`",
          "",
          "### Committed clusters",
          ...committedClusters.map(
            (c) => `**\`${c.dir}\`** (${c.files.length} files) — sha \`${c.sha}\`\n` + c.files.map((f) => `- \`${f}\``).join("\n"),
          ),
          "",
          ...(result.outliers.length > 0
            ? [
                "### Outliers (need human routing — branch scope mismatch)",
                ...result.outliers.map(
                  (o) => `**\`${o.dir}\`** (${o.files.length} files)\n` + o.files.map((f) => `- \`${f}\``).join("\n"),
                ),
              ]
            : []),
          "",
          "> This is a draft PR. Review commit messages, check outliers, then convert to ready when satisfied.",
        ].join("\n");

        const prResult = run(
          ["gh", "pr", "create", "--draft", "--title", prTitle, "--body-file", "-", "--head", branch],
          repo,
          30_000,
          prBody,
        );
        if (prResult.ok) {
          result.prUrl = prResult.stdout.split("\n").find((l) => l.startsWith("http")) || prResult.stdout;
        } else {
          result.error = `PR creation failed (commits pushed): ${prResult.stderr}`;
        }
      }
    }
  } catch (err) {
    result.error = String(err);
  }

  finish(result);
}

if (import.meta.main) main();
