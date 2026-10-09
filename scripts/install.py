#!/usr/bin/env python3
"""Install the current workshop and connect it to ordinary Hermes chats.

Only supported Hermes CLI commands change profile configuration. This installer
never reads/copies credential files, invokes a model, or starts swarm workers.
"""
import argparse
from contextlib import contextmanager
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ['factory_intake', 'memory_search', 'memory_store', 'swarm_prepare', 'workshop_status']


class InstallError(Exception):
    pass


def parser():
    result = argparse.ArgumentParser(
        description='Install shared memory and tools in normal Hermes chats; no paid calls or workers.')
    result.add_argument('--hermes-home', help='Existing normal Hermes profile directory (default: active profile)')
    result.add_argument('--data-home', help='Shared workshop state directory')
    result.add_argument('--workspace', help='Workshop project directory; existing settings are preserved')
    result.add_argument('--skip-build', action='store_true', help='Use an already built source tree')
    result.add_argument('--no-bootstrap-pnpm', action='store_true', help='Do not install missing pinned pnpm')
    mode = result.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true', help='Inspect and print the plan without installation writes')
    mode.add_argument('--check', action='store_true', help='Check without saving facts or changing configuration; locks and SQLite startup may write filesystem state')
    return result


def stop_process_group(proc):
    """Bound TERM/KILL/reap even when output collection itself is broken."""
    try:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=2)
        except (subprocess.TimeoutExpired, KeyboardInterrupt, OSError):
            pass
    finally:
        # Kill descendants even if their leader already exited, before closing
        # inherited pipes. Never do an unbounded communicate() during teardown.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            raise InstallError('Subprocess cleanup could not reap its group leader within the bounded timeout.') from None
        finally:
            for stream in [proc.stdin, proc.stdout, proc.stderr]:
                if stream is not None:
                    stream.close()


def command(argv, env, label, timeout=120, input_text=None, allow_failure=False):
    """Bound a command and its process group; never dump potentially secret stderr."""
    proc = subprocess.Popen(argv, cwd=ROOT, env=env, text=True,
                            stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = proc.communicate(input_text, timeout=timeout)
    except subprocess.TimeoutExpired:
        stop_process_group(proc)
        raise InstallError(f'{label} timed out; its process group was stopped.') from None
    except BaseException:
        stop_process_group(proc)
        raise
    if proc.returncode and not allow_failure:
        raise InstallError(f'{label} failed (exit {proc.returncode}). Inspect that command locally; raw output is withheld to avoid exposing secrets.')
    return proc.returncode, stdout, stderr


def executable(name, env):
    value = shutil.which(name, path=env['PATH'])
    if not value:
        raise InstallError(f'Missing prerequisite: {name}. Install it for this user and put it on PATH.')
    return str(Path(value).absolute())


def version_tuple(text):
    match = re.search(r'(\d+)\.(\d+)\.(\d+)', text)
    if not match:
        raise InstallError('Could not determine a runtime version.')
    return tuple(map(int, match.groups()))


def get_server(hermes, env):
    code, out, err = command([hermes, 'config', 'get', 'mcp_servers.zouroboros', '--json'], env, 'Reading MCP configuration', allow_failure=True)
    if code:
        if (out + err).strip() == 'Config key not set: mcp_servers.zouroboros':
            return None
        raise InstallError('Cannot read the selected Hermes MCP configuration; no connection will be overwritten.')
    try:
        value = json.loads(out)
    except ValueError:
        raise InstallError('Hermes did not return valid MCP configuration JSON.') from None
    if not isinstance(value, dict):
        raise InstallError('The existing zouroboros entry is not a server mapping.')
    return value


def check_connection(server, bun, data):
    if server is None:
        return
    if not isinstance(server, dict):
        raise InstallError('Invalid MCP server mapping; existing configuration was preserved.')
    for key in ['env', 'tools', 'sampling']:
        if key in server and not isinstance(server[key], dict):
            raise InstallError(f'Invalid MCP {key}: expected a mapping; existing configuration was preserved.')
    actual_env = server.get('env', {})
    if any(not isinstance(key, str) or not isinstance(value, str) for key, value in actual_env.items()):
        raise InstallError('Invalid MCP env: keys and values must be strings.')
    filters = server.get('tools', {})
    for key in ['include', 'exclude']:
        if key in filters and (not isinstance(filters[key], list)
                               or any(not isinstance(value, str) for value in filters[key])):
            raise InstallError(f'Invalid MCP tools.{key}: expected an array of strings.')
    for mapping in [server, server.get('sampling', {})]:
        if 'enabled' in mapping and type(mapping['enabled']) is not bool:
            raise InstallError('Invalid MCP enabled setting: expected a boolean.')
    expected_args = [str(ROOT / 'integration/mcp.ts')]
    if (server.get('command') != bun or server.get('args') != expected_args
            or actual_env.get('HERMES_ZOUROBOROS_HOME') != str(data)
            or actual_env.get('HERMES_ZOUROBOROS_ALLOW_SWARM') != '0'):
        raise InstallError('Existing zouroboros connection conflicts with this source/state or enables workers. Preserve it and review it explicitly; the installer will not overwrite it.')

    if (filters.get('include') is not None and set(filters['include']) != set(TOOLS)) or filters.get('exclude'):
        raise InstallError('Existing MCP tool filters differ from the five-tool integration; operator choices are preserved.')


def check_private_prefix(private):
    check_directory(private, ancestors=True)
    if not private.exists():
        return
    for parent, directories, files in os.walk(private, followlinks=False):
        for name in directories:
            check_directory(Path(parent) / name)
        for name in files:
            path = Path(parent) / name
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                # npm's normal bin links are safe only within this prefix.
                if path.parent != private / 'bin' or name not in ('pnpm', 'pnpx'):
                    raise InstallError('Unexpected symlink in private pnpm prefix.')
                try:
                    target = path.resolve(strict=True)
                except (OSError, RuntimeError):
                    raise InstallError('Invalid private pnpm bin symlink.') from None
                if not target.is_relative_to(private):
                    raise InstallError('Private pnpm bin symlink escapes its validated prefix.')
                check_directory(target.parent, ancestors=True)
                info = target.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise InstallError('Private pnpm files must be owned by this user and not group/world writable.')


def check_settings(server):
    if (server is None or server.get('enabled') is not True
            or server.get('sampling', {}).get('enabled') is not False
            or type(server.get('timeout')) is not int or server['timeout'] != 120
            or type(server.get('connect_timeout')) not in (int, float) or server['connect_timeout'] != 30):
        raise InstallError('MCP configuration readback failed: enabled=true, sampling.enabled=false, timeout=120 and connect_timeout=30 must be saved explicitly.')


def ensure_pnpm(env, data, allow_bootstrap):
    package = json.loads((ROOT / 'package.json').read_text())
    match = re.fullmatch(r'pnpm@(\d+\.\d+\.\d+)', package.get('packageManager', ''))
    if not match:
        raise InstallError('Source must specify an exact pnpm packageManager pin.')
    pin = match.group(1)
    private = data / 'tools' / f'pnpm-{pin}'
    check_state_files(data)
    check_private_prefix(private)
    if (private / 'bin/pnpm').is_file():
        env['PATH'] = str(private / 'bin') + os.pathsep + env['PATH']
    manager = shutil.which('pnpm', path=env['PATH'])
    if not manager:
        if not allow_bootstrap:
            raise InstallError(f'Missing pnpm@{pin}; automatic bootstrap is disabled.')
        npm = executable('npm', env)
        private.mkdir(parents=True, exist_ok=True, mode=0o700)
        check_private_prefix(private)
        command([npm, 'install', '--global', '--prefix', str(private), '--ignore-scripts', '--no-audit', '--no-fund', f'pnpm@{pin}'], env, 'Installing pinned pnpm in workshop-private tools', timeout=300)
        check_private_prefix(private)
        env['PATH'] = str(private / 'bin') + os.pathsep + env['PATH']
        manager = executable('pnpm', env)
    check_private_prefix(private)
    # A user-selected PATH executable is trusted only after ownership/mode checks.
    check_directory(Path(manager).absolute().parent, ancestors=True, allow_root=True)
    target = Path(manager).resolve(strict=True)
    check_directory(target.parent, ancestors=True, allow_root=True)
    info = target.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid not in {0, os.getuid()} or info.st_mode & 0o022:
        raise InstallError('pnpm executable is not trusted; review its ownership and permissions before use.')
    _, version, _ = command([manager, '--version'], env, 'Checking pinned pnpm')
    if version.strip() != pin:
        raise InstallError(f'pnpm version differs from source pin {pin}; no existing package manager will be overwritten. Put the correct version on PATH.')


def check_directory(path, ancestors=False, allow_root=False):
    """Inspect lexical paths, never following directory symlinks before validation."""
    paths = [*reversed(path.parents), path] if ancestors else [path]
    for item in paths:
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        owners = {os.getuid(), 0} if allow_root or (ancestors and item != path) else {os.getuid()}
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in owners
                or info.st_mode & 0o022):
            raise InstallError('Workshop directory hierarchy must not contain symlinks, non-owned directories, or group/world-writable directories.')


def check_state_files(data):
    check_directory(data, ancestors=True)
    for relative in ['hermes', 'tools', 'state', 'config', 'cache', 'logs', 'campaigns']:
        check_directory(data / relative)
    for relative in ['settings.json', 'executors.json', 'hermes/config.yaml', 'memory.db',
                     'memory.db-wal', 'memory.db-shm', 'memory.db-journal']:
        path = data / relative
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o022 or info.st_nlink != 1):
            raise InstallError('Workshop state files and SQLite sidecars must be single-link, non-symlink regular files owned by this user, not group/world writable.')
        if relative.startswith('memory.db') and stat.S_IMODE(info.st_mode) != 0o600:
            raise InstallError('Existing memory.db and SQLite sidecars must have owner-only mode 0600; review their permissions explicitly.')


def state_workspace(data, requested, home):
    markers = [data / 'settings.json', data / 'executors.json', data / 'hermes/config.yaml']
    found = [p.exists() for p in markers]
    if any(found) and not all(found):
        raise InstallError('Workshop state is incomplete. Preserve it and repair it explicitly; initialization will not replace partial state.')
    if all(found):
        try:
            saved = json.loads(markers[0].read_text())
            work = Path(saved['workspace'])
            if not work.is_absolute() or not work.is_dir():
                raise ValueError()
        except (OSError, ValueError, KeyError, TypeError):
            raise InstallError('Existing workshop workspace settings are invalid or unavailable.') from None
        if requested and Path(requested).expanduser().resolve() != work.resolve():
            raise InstallError('Requested workspace conflicts with saved workshop settings; existing state was preserved.')
        return work.resolve(), True
    return Path(requested or home / 'work/hermes-projects').expanduser().resolve(), False


@contextmanager
def install_locks(config, data):
    """Persistent lock inodes: never unlink a lock that another installer can hold."""
    held = []
    try:
        digest = hashlib.sha256(str(data).encode()).hexdigest()
        for path in [config.parent / '.zouroboros-install.lock',
                     data.parent / f'.zouroboros-install-{digest}.lock']:
            check_directory(path.parent, ancestors=True)
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            check_directory(path.parent, ancestors=True)
            try:
                fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            except OSError:
                raise InstallError('Cannot safely open installer lock; no connection was changed.') from None
            held.append((path, fd))
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
                raise InstallError('Installer lock must be a user-owned regular file with mode 0600 and one link.')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise InstallError('Another installer holds this profile/state lock; retry after it finishes.') from None

        def verify():
            for path, fd in held:
                info = os.fstat(fd)
                current = path.lstat()
                if (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino):
                    raise InstallError('Installer lock was replaced; state is unresolved and no further writes are safe.')
        verify()
        yield verify
    finally:
        for _, fd in reversed(held):
            os.close(fd)


def unchanged_server(hermes, env, expected):
    current = get_server(hermes, env)
    if current != expected:
        raise InstallError('MCP connection changed during installation; preserve the operator entry and retry after review.')
    return current


def cleanup_new_connection(hermes, env, bun, data, tag, candidates, verify_locks):
    """Disable only this attempt's tagged, unchanged entry; prove the write."""
    try:
        verify_locks()
        current = get_server(hermes, env)
        if current is None:
            return 'No new connection remains; data was retained.'
        check_connection(current, bun, data)
        if (current.get('env', {}).get('HERMES_ZOUROBOROS_INSTALL_TAG') != tag
                or (candidates and current not in candidates)):
            return 'New connection cleanup unresolved: foreign/replaced entry preserved; inspect the selected profile explicitly.'
        verify_locks()
        unchanged_server(hermes, env, current)
        command([hermes, 'config', 'set', 'mcp_servers.zouroboros.enabled', 'false'], env, 'Disabling failed new connection')
        expected = copy.deepcopy(current)
        expected['enabled'] = False
        disabled = unchanged_server(hermes, env, expected)
        if disabled.get('enabled') is not False:
            raise InstallError('Disable readback was not false.')
        return 'Failed new connection disabled and read back; data was retained.'
    except (InstallError, OSError, ValueError):
        return 'New connection cleanup unresolved: safe ownership or disabled-state readback could not be proven; inspect the selected profile explicitly.'


def install(args):
    env = os.environ.copy()
    home = Path.home()
    env['PATH'] = os.pathsep.join([str(home / '.local/bin'), str(home / '.bun/bin'), env.get('PATH', '')])
    hermes = executable('hermes', env)
    bun = executable('bun', env)
    node = executable('node', env)
    executable('timeout', env)
    for binary, minimum, name in [(node, (20, 0, 0), 'Node'), (bun, (1, 3, 12), 'Bun')]:
        _, out, _ = command([binary, '--version'], env, f'Checking {name}')
        if version_tuple(out) < minimum:
            raise InstallError(f'{name} is too old; this source requires at least {".".join(map(str, minimum))}.')
    if args.hermes_home:
        env['HERMES_HOME'] = str(Path(args.hermes_home).expanduser().resolve())
    _, config_out, _ = command([hermes, 'config', 'path'], env, 'Resolving active Hermes profile')
    config = Path(config_out.strip())
    if not config.is_absolute() or config.name != 'config.yaml' or not config.is_file():
        raise InstallError('Selected Hermes profile must already have config.yaml. Run Hermes setup for that profile first.')
    config = config.resolve()
    env['HERMES_HOME'] = str(config.parent)
    data = Path(os.path.abspath(Path(args.data_home or env.get('HERMES_ZOUROBOROS_HOME') or Path(env.get('XDG_DATA_HOME') or home / '.local/share') / 'hermes-zouroboros').expanduser()))
    if data == config.parent or data / 'hermes' == config.parent:
        raise InstallError('Use a normal Hermes home separate from the workshop state and its isolated worker home.')
    env['HERMES_ZOUROBOROS_HOME'] = str(data)
    env['HERMES_ZOUROBOROS_ALLOW_SWARM'] = '0'
    check_state_files(data)
    work, initialized = state_workspace(data, args.workspace, home)
    server = get_server(hermes, env)
    check_connection(server, bun, data)
    plan = {'source': str(ROOT), 'hermesHome': str(config.parent), 'dataHome': str(data), 'workspace': str(work), 'initialize': not initialized, 'build': not args.skip_build and not args.check, 'connect': server is None}
    if args.dry_run:
        print(json.dumps({'ok': True, 'dryRun': True, 'plan': plan, 'workers': False, 'sampling': False}))
        return
    if args.check and (not initialized or server is None or not (data / 'memory.db').is_file()):
        raise InstallError('No complete installation to check. Run the installer without --check first.')
    with install_locks(config, data) as verify_locks:
        unchanged_server(hermes, env, server)
        work, initialized = state_workspace(data, args.workspace, home)
        finish_install(args, env, hermes, bun, data, work, initialized, server, config, plan, verify_locks)


def finish_install(args, env, hermes, bun, data, work, initialized, server, config, plan, verify_locks):
    if not args.skip_build and not args.check:
        ensure_pnpm(env, data, not args.no_bootstrap_pnpm)
        command(['bash', str(ROOT / 'scripts/setup.sh')], env, 'Source dependency installation/build/typecheck', timeout=600)
    for relative in ['node_modules/@modelcontextprotocol/sdk', 'packages/memory/dist/index.js', 'packages/swarm/dist/index.js']:
        if not (ROOT / relative).exists():
            raise InstallError('Source is not built; run the installer without --skip-build.')
    check_state_files(data)
    verify_locks()
    work, initialized = state_workspace(data, args.workspace, Path.home())
    if not initialized:
        data.mkdir(parents=True, exist_ok=True, mode=0o700)
        work.mkdir(parents=True, exist_ok=True, mode=0o700)
        command([bun, str(ROOT / 'integration/cli.ts'), 'init', '--workspace', str(work)], env, 'Initializing workshop')
    command([bun, str(ROOT / 'integration/cli.ts'), 'doctor'], env, 'Workshop doctor')
    attempted = False
    tag = str(uuid.uuid4())
    candidates = []
    try:
        if server is None:
            verify_locks()
            unchanged_server(hermes, env, None)
            # Empty input accepts default tool selection, but NEVER an overwrite
            # or a failed-probe save (both supported CLI defaults are no).
            attempted = True
            command([hermes, 'mcp', 'add', 'zouroboros', '--command', bun, '--connect-timeout', '30', '--env', f'HERMES_ZOUROBOROS_HOME={data}', 'HERMES_ZOUROBOROS_ALLOW_SWARM=0', f'HERMES_ZOUROBOROS_INSTALL_TAG={tag}', '--args', str(ROOT / 'integration/mcp.ts')], env, 'Connecting Zouroboros to normal Hermes', input_text='\n')
            added = get_server(hermes, env)
            check_connection(added, bun, data)
            if added is None:
                raise InstallError('Hermes add did not save a connection, despite its exit status; configuration was not patched further.')
            if added.get('env', {}).get('HERMES_ZOUROBOROS_INSTALL_TAG') != tag:
                raise InstallError('MCP add did not save this installation attempt; foreign entry preserved.')
            server = added
            candidates = [copy.deepcopy(added)]
        if args.check:
            unchanged_server(hermes, env, server)
            check_settings(server)
        else:
            for key, value in [('enabled', True), ('sampling.enabled', False), ('timeout', 120), ('connect_timeout', 30)]:
                current = server
                for part in key.split('.'):
                    current = current.get(part) if isinstance(current, dict) else None
                if current != value:
                    verify_locks()
                    unchanged_server(hermes, env, server)
                    expected = copy.deepcopy(server)
                    target = expected
                    parts = key.split('.')
                    for part in parts[:-1]:
                        target = target.setdefault(part, {})
                    target[parts[-1]] = value
                    if attempted:
                        candidates = [copy.deepcopy(server), copy.deepcopy(expected)]
                    command([hermes, 'config', 'set', f'mcp_servers.zouroboros.{key}', json.dumps(value)], env, 'Applying safe MCP settings')
                    server = unchanged_server(hermes, env, expected)
                    if attempted:
                        candidates = [copy.deepcopy(server)]
        saved = unchanged_server(hermes, env, server)
        check_connection(saved, bun, data)
        check_settings(saved)
        check_state_files(data)
        command([hermes, 'mcp', 'test', 'zouroboros'], env, 'Hermes MCP discovery')
        verify_locks()
        unchanged_server(hermes, env, server)
        probe = [bun, str(ROOT / 'scripts/install-probe.ts'), str(config)]
        if args.check:
            probe.append('--check')
        check_state_files(data)
        _, verified, _ = command(probe, env, 'MCP persistence verification', timeout=60)
        verification = json.loads(verified)
        verify_locks()
        unchanged_server(hermes, env, server)
        print(json.dumps({'ok': True, 'plan': plan, 'verification': verification, 'activation': 'Start a new normal Hermes chat or explicitly run /reload-mcp in an open chat.', 'boundaries': ['GraphRAG is not wired into the MCP search path.', 'Additional harnesses and model-worker execution are not enabled.', 'Factory intake requires a trusted board manifest; no dispatcher, review enforcement, merge or deployment is installed.', 'No credential copying, personal-memory replacement, or automatic conversation capture.']}))
    except BaseException:
        if attempted:
            print(cleanup_new_connection(hermes, env, bun, data, tag, candidates, verify_locks), file=sys.stderr)
        raise


def main():
    args = parser().parse_args()
    try:
        install(args)
    except KeyboardInterrupt:
        print('Installation interrupted; subprocess groups were stopped. Review any reported unresolved connection state.', file=sys.stderr)
        return 130
    except (InstallError, OSError, ValueError) as exc:
        print(f'Installation stopped: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
