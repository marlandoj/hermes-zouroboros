import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { canonicalFactoryPath, insideFactoryPath, loadFactoryPathProfile } from './factory-path-profile.js';
import {
  chownSync,
  closeSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AdapterSpawnSpec {
  command: string;
  args: string[];
  passFds?: number[];
  closeAfterSpawn?: () => void;
  cleanupAfterExit?: () => void;
  ipcHostRoot?: string;
  ipcGuestRoot?: string;
}

const BWRAP = '/usr/bin/bwrap';
const SETPRIV = '/usr/bin/setpriv';
const PYTHON3 = '/usr/bin/python3';
const PRESTAGE_USERNS_HELPER = fileURLToPath(new URL('./prestage-userns.py', import.meta.url));
const FACTORY_ROOT_NAME = '.factory-worktrees';
const IPC_HOST_PREFIX = '/dev/shm/zouroboros-sandbox-ipc-';

/**
 * How the executor user namespace is established:
 * - `rootless`: setpriv drops to the containment uid, then bwrap creates the
 *   user namespace itself (inner 0 -> outer containment uid). The default on
 *   hosts where an unprivileged process may write its own uid_map.
 * - `prestaged`: containers where the dropped-uid uid_map write is denied
 *   (nested user namespace + NoNewPrivs: bwrap dies with "setting up uid map:
 *   Permission denied", and util-linux --map-users detours through the setuid
 *   newuidmap helper, which NoNewPrivs neuters). A privileged helper
 *   (prestage-userns.py) creates the user namespace first — its child
 *   receives the kernel capability grant at creation, the root supervisor
 *   writes the *identical* map (inner 0 -> outer containment uid), and the
 *   child raises CAP_SYS_ADMIN as an ambient capability before exec'ing
 *   bwrap inside the namespace without --unshare-user. Payload identity
 *   (inner 0 / outer containment uid), bind mounts, and credential mounts
 *   are unchanged; the differences are who performs namespace setup and
 *   that /proc is the container proc bound read-only instead of a fresh
 *   proc mount (the container /proc carries locked overmounts, so a fresh
 *   proc mount is rejected as "too revealing"). The mode is stamped into
 *   the environment and logged — never selected silently.
 */
function latestClaudeVersionBinary(): string | null {
  const roots = [
    process.env.CLAUDE_VERSIONS_DIR,
    `${process.env.HOME ?? '/root'}/.local/share/claude/versions`,
    '/root/.local/share/claude/versions',
    '/home/workspace/.local/share/claude/versions',
    '/home/hatch/.local/share/claude/versions',
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const root of roots) {
    try {
      const entries = readdirSync(root)
        .filter((entry) => /^\d+\.\d+\.\d+$/.test(entry))
        .sort((a, b) =>
          a.split('.').map(Number).reduce((acc, n, i) => acc + n * 100 ** (2 - i), 0)
          - b.split('.').map(Number).reduce((acc, n, i) => acc + n * 100 ** (2 - i), 0));
      const latest = entries.at(-1);
      if (latest) {
        const candidate = join(root, latest, 'claude');
        const plain = join(root, latest);
        if (existsSync(candidate)) return candidate;
        if (existsSync(plain)) return plain;
      }
    } catch {
      // Root not present on this host; try the next one.
    }
  }
  return null;
}

export function resolveSandboxToolBinds(): Array<readonly [string, string]> {
  const binds: Array<readonly [string, string]> = [];
  const bunCandidates = [
    process.env.BUN_INSTALL ? `${process.env.BUN_INSTALL}/bin/bun` : undefined,
    `${process.env.HOME ?? '/root'}/.bun/bin/bun`,
    '/root/.bun/bin/bun',
    '/opt/hatch-image/bin/bun',
    '/home/hatch/.bun/bin/bun',
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const candidate of bunCandidates) {
    if (existsSync(candidate)) {
      binds.push([candidate, '/sandbox-bin/bun'] as const);
      break;
    }
  }
  const claudeBinary = latestClaudeVersionBinary();
  if (claudeBinary) {
    binds.push([claudeBinary, '/sandbox-bin/claude'] as const);
  } else if (process.env.CLAUDE_BINARY && existsSync(process.env.CLAUDE_BINARY)) {
    binds.push([process.env.CLAUDE_BINARY, '/sandbox-bin/claude'] as const);
  }
  return binds;
}

export type ContainedUsernsMode = 'rootless' | 'prestaged';

export interface PrepareContainedSpawnOptions {
  /** Force a mode (tests). Default: capability probe, cached per process. */
  usernsMode?: ContainedUsernsMode;
  logger?: Pick<Console, 'warn'>;
}

const containedUsernsModeCache = new Map<string, ContainedUsernsMode>();

// A trivial sandbox exercising exactly the operation that fails in nested
// containers: user-namespace creation plus the uid_map write for the
// containment uid. Used as an up-front capability probe so spawn mode
// selection never depends on catching a failed adapter spawn.
const PROBE_SANDBOX_ARGS: string[] = [
  '--die-with-parent',
  '--new-session',
  '--unshare-pid',
  '--unshare-uts',
  '--unshare-ipc',
  '--ro-bind', '/usr', '/usr',
  '--symlink', 'usr/bin', '/bin',
  '--symlink', 'usr/lib', '/lib',
  '--symlink', 'usr/lib64', '/lib64',
  '--',
  '/bin/true',
];

function probeRootlessUserns(uid: number, gid: number): boolean {
  try {
    const result = spawnSync(
      SETPRIV,
      [`--reuid=${uid}`, `--regid=${gid}`, '--clear-groups', BWRAP, '--unshare-user', '--uid', '0', '--gid', '0', ...PROBE_SANDBOX_ARGS],
      { stdio: 'ignore', timeout: 5_000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

function probePrestagedUserns(uid: number, gid: number): boolean {
  try {
    const spec = prestageUsernsCommand(uid, gid, BWRAP, PROBE_SANDBOX_ARGS);
    const result = spawnSync(spec.command, spec.args, { stdio: 'ignore', timeout: 10_000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Selects how the executor user namespace will be established for the given
 * containment uid/gid. Rootless is preferred and is byte-for-byte the
 * historical behavior; prestaged is chosen only when the rootless capability
 * probe fails and this process is root (the supervisor already runs as root:
 * it chowns the worktree and reads the root-owned credential sources).
 * Throws — fail closed — when neither is available.
 */
export function selectContainedUsernsMode(uid: number, gid: number): ContainedUsernsMode {
  const key = `${uid}:${gid}`;
  const cached = containedUsernsModeCache.get(key);
  if (cached) return cached;
  let mode: ContainedUsernsMode | undefined;
  if (existsSync(BWRAP) && existsSync(SETPRIV) && probeRootlessUserns(uid, gid)) {
    mode = 'rootless';
  } else if (
    existsSync(BWRAP)
    && existsSync(PYTHON3)
    && existsSync(PRESTAGE_USERNS_HELPER)
    && typeof process.geteuid === 'function'
    && process.geteuid() === 0
    && probePrestagedUserns(uid, gid)
  ) {
    mode = 'prestaged';
  }
  if (!mode) {
    throw new Error(
      `executor containment cannot establish a user namespace for containment uid ${uid}: `
      + 'dropped-uid bwrap user namespace setup is unavailable and privileged user namespace '
      + 'prestaging is unavailable; refusing to run uncontained',
    );
  }
  containedUsernsModeCache.set(key, mode);
  return mode;
}

/**
 * Launcher for the prestaged mode. Run as root:
 *   python3 prestage-userns.py <uid> <gid> <command> [args...]
 * The helper's child creates the user namespace (receiving the kernel
 * capability grant at creation), blocks while this root supervisor writes
 * the uid/gid maps (inner 0 -> outer <uid>/<gid>), then setuid(0)s inside
 * the namespace, raises CAP_SYS_ADMIN as an ambient capability, and execs
 * the command — so bwrap starts as inner root, able to perform its normal
 * mount/pid/uts/ipc setup. No stock tool can run this sequence: unshare
 * execs its program immediately, losing the creator capability grant, and
 * a map written by a third party into a live namespace confers no
 * capabilities on the next exec. See prestage-userns.py for the full
 * mechanism.
 */
function prestageUsernsCommand(
  uid: number,
  gid: number,
  command: string,
  args: string[],
): { command: string; args: string[] } {
  return {
    command: PYTHON3,
    args: [PRESTAGE_USERNS_HELPER, String(uid), String(gid), command, ...args],
  };
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function removeTree(target: string): void {
  if (!existsSync(target)) return;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = join(target, entry.name);
    if (entry.isDirectory()) removeTree(child);
    else unlinkSync(child);
  }
  rmdirSync(target);
}

function validateAndChownTree(target: string, uid: number, gid: number, dependencyTree = false): void {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    lchownSync(target, uid, gid);
    return;
  }
  if (stat.isFile() && stat.nlink > 1 && !dependencyTree) {
    throw new Error(`executor containment rejects hard-linked file: ${target}`);
  }
  if (stat.isDirectory()) {
    const dependencies = dependencyTree || basename(target) === 'node_modules';
    if (dependencies) return;
    for (const entry of readdirSync(target)) validateAndChownTree(join(target, entry), uid, gid, dependencies);
  }
  chownSync(target, uid, gid);
}

function directoryArgs(target: string): string[] {
  const dirs: string[] = [];
  let current = dirname(target);
  while (current !== '/') {
    dirs.unshift(current);
    current = dirname(current);
  }
  return dirs.flatMap((dir) => ['--dir', dir]);
}

function positiveId(value: string | undefined, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${field} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function assignedWorktree(containmentRoot: string, workdir: string): string {
  const root = realpathSync(containmentRoot);
  if (basename(root) !== FACTORY_ROOT_NAME) {
    throw new Error(`executor containment root must end with ${FACTORY_ROOT_NAME}`);
  }
  const cwd = realpathSync(workdir);
  if (!isStrictDescendant(root, cwd)) {
    throw new Error(`executor workdir must be inside ${root}`);
  }
  const first = relative(root, cwd).split(sep)[0];
  const assigned = realpathSync(join(root, first));
  if (!isStrictDescendant(root, assigned)) {
    throw new Error('executor assigned worktree escaped the containment root');
  }
  return assigned;
}

function assignedGitBinds(assigned: string, env: Record<string, string>): string[] {
  const profile = loadFactoryPathProfile(env);
  const pointer = join(assigned, '.git');
  if (!existsSync(pointer)) {
    if (profile) throw new Error('profiled executor requires a registered Git worktree');
    return [];
  }
  if (!lstatSync(pointer).isFile() || lstatSync(pointer).isSymbolicLink()) throw new Error('executor requires a linked Git worktree');
  const match = /^gitdir: (.+)\n?$/.exec(readFileSync(pointer, 'utf8'));
  if (!match) throw new Error('invalid worktree gitdir');
  const gitdir = canonicalFactoryPath(match[1]);
  const common = canonicalFactoryPath(resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim()));
  if (dirname(dirname(gitdir)) !== common || basename(dirname(gitdir)) !== 'worktrees' || basename(common) !== '.git') throw new Error('forged Git common directory');
  if (readFileSync(join(gitdir, 'gitdir'), 'utf8').trim() !== pointer) throw new Error('Git registration does not identify assigned worktree');
  if (profile) {
    const records = readFileSync(join(profile.worktrees_root, 'ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const record = records.filter(item => item.worktreePath === assigned).at(-1);
    if (!record || record.status !== 'active' || !insideFactoryPath(profile.source_root, canonicalFactoryPath(record.repoPath))) throw new Error('assigned repository has no active ledger authority');
    const result = spawnSync('git', ['-C', record.repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0 || realpathSync(result.stdout.trim()) !== common) throw new Error('assigned repository Git metadata mismatch');
  } else if (!insideFactoryPath('/home/workspace', common) && !insideFactoryPath(dirname(realpathSync(env.SWARM_EXEC_CONTAINMENT_ROOT)), common)) {
    throw new Error('Git metadata outside authorized source root');
  }
  if (existsSync(join(common, 'objects', 'info', 'alternates'))) throw new Error('external Git object alternates are unsupported');
  const args = [...directoryArgs(common), '--dir', common, '--dir', join(common, 'worktrees')];
  for (const name of ['HEAD', 'config', 'objects', 'refs', 'packed-refs', 'shallow']) {
    const source = join(common, name);
    if (existsSync(source)) {
      canonicalFactoryPath(source);
      args.push('--ro-bind', source, source);
    }
  }
  args.push('--ro-bind', gitdir, gitdir, '--ro-bind', pointer, pointer);
  return args;
}

export function prepareFilesystemContainedSpawn(
  spawnSpec: AdapterSpawnSpec,
  workdir: string,
  env: Record<string, string>,
  options: PrepareContainedSpawnOptions = {},
): AdapterSpawnSpec {
  if (env.SWARM_EXEC_CONTAINMENT_REQUIRED !== '1') {
    return { command: spawnSpec.command, args: [...spawnSpec.args] };
  }
  const uid = positiveId(env.SWARM_EXEC_CONTAINMENT_UID, 'SWARM_EXEC_CONTAINMENT_UID');
  const gid = positiveId(env.SWARM_EXEC_CONTAINMENT_GID, 'SWARM_EXEC_CONTAINMENT_GID');
  const configuredRoot = env.SWARM_EXEC_CONTAINMENT_ROOT;
  if (!configuredRoot || !isAbsolute(configuredRoot)) {
    throw new Error('SWARM_EXEC_CONTAINMENT_ROOT must be an absolute path');
  }
  const profile = loadFactoryPathProfile(env);
  if (!profile && insideFactoryPath('/home/.z/factory', resolve(configuredRoot))) throw new Error('external containment requires a pinned Factory profile');
  const assigned = assignedWorktree(configuredRoot, workdir);
  if (profile && realpathSync(configuredRoot) !== profile.worktrees_root) throw new Error('containment root diverges from profile');
  const gitArgs = assignedGitBinds(assigned, env);
  if (!existsSync(BWRAP)) {
    throw new Error('required executor containment binaries are unavailable');
  }
  validateAndChownTree(assigned, uid, gid);

  // Mode selection is capability-probed up front (never inferred from a
  // failed adapter spawn). Rootless keeps the historical spawn shape exactly;
  // prestaged is an explicit, recorded degradation of *who performs*
  // namespace setup — the mapping, payload identity, bind mounts, and
  // credential mounts are identical. See ContainedUsernsMode.
  const usernsMode = options.usernsMode ?? selectContainedUsernsMode(uid, gid);
  env.SWARM_EXEC_CONTAINMENT_MODE = usernsMode === 'rootless' ? 'rootless-userns' : 'prestaged-userns';
  if (usernsMode === 'prestaged') {
    env.SWARM_EXEC_CONTAINMENT_DEGRADED_REASON =
      `user namespace prestaged by a privileged helper because dropped-uid user namespace setup `
      + `(uid_map write as uid ${uid}) is denied in this container; the uid/gid mapping `
      + `(inner 0 -> outer ${uid}/${gid}), payload identity, bind mounts, and credential mounts are unchanged; `
      + `/proc is the container proc bound read-only instead of a fresh proc mount for the sandbox PID namespace `
      + `(fresh proc mounts are rejected here: the container /proc carries locked overmounts)`;
    (options.logger ?? console).warn(
      `[ACP containment] dropped-uid user namespace setup is unavailable in this container; `
      + `prestaging the user namespace with a privileged helper (identical inner 0 -> outer ${uid}/${gid} mapping) `
      + 'and binding the container /proc read-only instead of mounting a fresh proc. '
      + 'This degradation is explicit: payload identity, bind mounts, and credential mounts are unchanged.',
    );
  }

  const ipcHostRoot = `${IPC_HOST_PREFIX}${randomUUID()}`;
  mkdirSync(ipcHostRoot, { mode: 0o700 });
  chownSync(ipcHostRoot, uid, gid);
  const ipcGuestRoot = '/sandbox-ipc';
  const passFds: number[] = [];
  const credentialArgs: string[] = [];
  const executorId = env.SWARM_EXECUTOR_ID;
  const credential = executorId === 'claude-code'
    ? {
        source: '/root/.claude/.credentials.json',
        destination: '/sandbox-home/.claude/.credentials.json',
        parent: '/sandbox-home/.claude',
      }
    : executorId === 'codex'
      ? {
          source: '/root/.codex/auth.json',
          destination: '/sandbox-home/.codex/auth.json',
          parent: '/sandbox-home/.codex',
        }
      : undefined;
  if (credential) {
    const credentialPath = credential.source;
    if (!existsSync(credentialPath)) {
      removeTree(ipcHostRoot);
      throw new Error(`${executorId} containment credential source is unavailable`);
    }
    const credentialFd = openSync(credentialPath, 'r');
    passFds.push(credentialFd);
    credentialArgs.push(
      '--dir', credential.parent,
      '--perms', '0400',
      '--ro-bind-data', String(3 + passFds.length - 1), credential.destination,
    );
  }

  const optionalToolBinds: string[] = [];
  const toolFiles = resolveSandboxToolBinds();
  for (const [source, destination] of toolFiles) {
    if (existsSync(source)) optionalToolBinds.push('--ro-bind', source, destination);
  }
  const bridgeRuntimeRoot = '/home/workspace/Skills/zo-swarm-executors';
  const bridgeRuntimeArgs = spawnSpec.command === 'bash' && existsSync(bridgeRuntimeRoot)
    ? [...directoryArgs(bridgeRuntimeRoot), '--ro-bind', bridgeRuntimeRoot, bridgeRuntimeRoot]
    : [];
  const tierResolver = '/home/workspace/Skills/zo-swarm-orchestrator/scripts/tier-resolve.ts';
  const tierResolverArgs = spawnSpec.command === 'bash' && existsSync(tierResolver)
    ? [...directoryArgs(tierResolver), '--ro-bind', tierResolver, tierResolver]
    : [];
  const factoryCodexRequirements = '/etc/codex/factory-requirements.toml';
  const factoryCodexRequirementsArgs = executorId === 'codex' && existsSync(factoryCodexRequirements)
    ? ['--ro-bind', factoryCodexRequirements, '/etc/codex/requirements.toml']
    : [];

  // The sandbox shares the host network namespace (no --unshare-net), so the
  // payload needs the host's resolver config and TLS trust anchors to reach
  // model APIs: without /etc/resolv.conf DNS fails (EAI_AGAIN), and the
  // NODE_EXTRA_CA_CERTS/SSL_CERT_FILE bundle lives outside the bound trees
  // (e.g. under a runtime /run dir that the sandbox replaces with tmpfs).
  // Bind them read-only, same paths, only when present — no new mounts of
  // writable or sensitive material, and no change when hosts lack them.
  const networkConfigArgs: string[] = [];
  for (const etcFile of ['/etc/resolv.conf', '/etc/hosts']) {
    if (existsSync(etcFile)) networkConfigArgs.push('--ro-bind', etcFile, etcFile);
  }
  const tlsBundlePaths = new Set<string>();
  for (const key of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) {
    const value = env[key];
    if (value && isAbsolute(value) && existsSync(value) && !value.startsWith('/usr/') && !value.startsWith('/etc/ssl/')) {
      tlsBundlePaths.add(value);
    }
  }
  for (const bundlePath of tlsBundlePaths) {
    networkConfigArgs.push(...directoryArgs(bundlePath), '--ro-bind', bundlePath, bundlePath);
  }

  const bwrapArgs = [
    '--die-with-parent',
    '--new-session',
    // Rootless: bwrap creates the user namespace and lands the payload on
    // inner uid/gid 0 (outer containment uid). Prestaged: the namespace and
    // the identical mapping already exist by the time bwrap runs (as inner
    // root), so no --unshare-user/--uid/--gid is passed.
    ...(usernsMode === 'rootless' ? ['--unshare-user', '--uid', '0', '--gid', '0'] : []),
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
    '--ro-bind', '/usr', '/usr',
    '--dir', '/etc',
    '--ro-bind', '/etc/ssl', '/etc/ssl',
    '--ro-bind', '/etc/passwd', '/etc/passwd',
    '--ro-bind', '/etc/group', '/etc/group',
    '--ro-bind', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
    ...networkConfigArgs,
    ...factoryCodexRequirementsArgs,
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    // Rootless gets a fresh proc for the sandbox PID namespace. Prestaged
    // binds the container proc read-only: a fresh proc mount is rejected
    // here ("too revealing" — the container /proc carries locked
    // overmounts). Recorded in SWARM_EXEC_CONTAINMENT_DEGRADED_REASON.
    ...(usernsMode === 'rootless' ? ['--proc', '/proc'] : ['--ro-bind', '/proc', '/proc']),
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/run',
    '--dir', '/sandbox-home',
    '--dir', '/sandbox-home/.codex',
    '--dir', '/sandbox-home/.config',
    '--dir', '/sandbox-bin',
    ...directoryArgs(assigned),
    '--bind', assigned, assigned,
    ...gitArgs,
    ...bridgeRuntimeArgs,
    ...tierResolverArgs,
    '--bind', ipcHostRoot, ipcGuestRoot,
    ...optionalToolBinds,
    ...credentialArgs,
    '--chdir', realpathSync(workdir),
    '--setenv', 'HOME', '/sandbox-home',
    '--setenv', 'CODEX_HOME', '/sandbox-home/.codex',
    '--setenv', 'CLAUDE_CONFIG_DIR', '/sandbox-home/.claude',
    '--setenv', 'XDG_CONFIG_HOME', '/sandbox-home/.config',
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'USER', 'zouroboros-agent',
    '--setenv', 'LOGNAME', 'zouroboros-agent',
    '--setenv', 'GIT_CONFIG_COUNT', '1',
    '--setenv', 'GIT_CONFIG_KEY_0', 'safe.directory',
    '--setenv', 'GIT_CONFIG_VALUE_0', assigned,
    '--setenv', 'GIT_OPTIONAL_LOCKS', '0',
    '--setenv', 'PATH', '/sandbox-bin:/usr/local/bin:/usr/bin:/bin',
    '--',
    spawnSpec.command,
    ...spawnSpec.args,
  ];

  const launcher = usernsMode === 'rootless'
    ? { command: SETPRIV, args: [`--reuid=${uid}`, `--regid=${gid}`, '--clear-groups', BWRAP, ...bwrapArgs] }
    : prestageUsernsCommand(uid, gid, BWRAP, bwrapArgs);

  return {
    command: launcher.command,
    args: launcher.args,
    passFds,
    ipcHostRoot,
    ipcGuestRoot,
    closeAfterSpawn: () => {
      for (const fd of passFds) closeSync(fd);
    },
    cleanupAfterExit: () => removeTree(ipcHostRoot),
  };
}
