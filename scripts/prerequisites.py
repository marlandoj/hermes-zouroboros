"""Read-only prerequisite inventory and explicitly requested private runtimes.

Only stdlib is used: no shell installers, package-manager commands or sudo.
The checked-in manifest is the trust anchor, never a checksum fetched at runtime.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

PINS = json.loads(Path(__file__).with_name('runtime-pins.json').read_text())
MAX_DOWNLOAD = 150 * 1024 * 1024
MAX_EXTRACTED = 600 * 1024 * 1024


class PrerequisiteError(Exception):
    pass


def version(text):
    match = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)', text.strip())
    if not match:
        raise PrerequisiteError('Could not determine a stable runtime version.')
    return tuple(map(int, match.groups()))


def target_platform():
    """Conservative intersection of the pinned Node and Bun binary support."""
    machine = {'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine().lower())
    libc, release = platform.libc_ver()
    numbers = tuple(map(int, re.findall(r'\d+', release)[:2]))
    kernel = tuple(map(int, re.findall(r'\d+', platform.release())[:2]))
    if (platform.system() != 'Linux' or not machine or libc != 'glibc'
            or numbers < (2, 28) or kernel < (4, 18)):
        raise PrerequisiteError('Runtime bootstrap supports Linux x86_64/arm64, glibc >=2.28 and kernel >=4.18 only. '
                                'Use distro-supported runtimes on other systems; see docs/install.md.')
    return 'linux-' + machine


def validate_tree(path, directory_check):
    directory_check(path, ancestors=True)
    if not path.exists():
        return
    for parent, directories, files in os.walk(path, followlinks=False):
        for name in directories:
            directory_check(Path(parent) / name)
        for name in files:
            item = Path(parent) / name
            info = item.lstat()
            # Only the two deliberately created npm entrypoints may be links.
            if stat.S_ISLNK(info.st_mode):
                if item.parent != path / 'bin' or name not in ('npm', 'npx'):
                    raise PrerequisiteError('Unexpected link in private runtime; preserve and review it.')
                resolved = item.resolve(strict=True)
                if not resolved.is_relative_to(path):
                    raise PrerequisiteError('Private runtime link escapes its prefix.')
                info = resolved.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_mode & 0o022 or info.st_nlink != 1):
                raise PrerequisiteError('Private runtime files must be single-link, user-owned and not group/world writable.')


def runtime_prefix(data, name, target):
    return data / 'tools/runtimes' / f'{name}-{PINS[name]["version"]}-{target}'


def add_private_paths(env, data, directory_check):
    """Append managed bins: existing operator-selected runtimes always win."""
    try:
        target = target_platform()
    except PrerequisiteError:
        return
    for name in PINS:
        prefix = runtime_prefix(data, name, target)
        validate_tree(prefix, directory_check)
        if prefix.exists():
            env['PATH'] += os.pathsep + str(prefix / 'bin')


def inventory(env, data, build, allow_pnpm, command, check_manager):
    """Collect every issue before the caller decides whether any writes are safe."""
    rows = []
    names = ['hermes', 'bun', 'node', 'timeout', 'bash', 'python3']
    if build:
        names += ['pnpm', 'npm']
    pin = json.loads((Path(__file__).resolve().parents[1] / 'package.json').read_text())['packageManager']
    if not re.fullmatch(r'pnpm@\d+\.\d+\.\d+', pin):
        raise PrerequisiteError('Source must specify an exact pnpm packageManager pin.')
    private_manager = data / 'tools' / pin.replace('@', '-') / 'bin/pnpm'
    manager = str(private_manager) if private_manager.is_file() else shutil.which('pnpm', path=env['PATH'])
    for name in names:
        path = manager if name == 'pnpm' else shutil.which(name, path=env['PATH'])
        row = {'name': name, 'path': str(Path(path).absolute()) if path else None,
               'status': 'present' if path else 'missing'}
        try:
            if path and name in ('bun', 'node', 'pnpm', 'python3', 'timeout'):
                if name == 'pnpm':
                    check_manager(path)
                _, out, _ = command([path, '--version'], env, f'Checking {name}')
                if name == 'timeout':
                    if not out.startswith('timeout (GNU coreutils)'):
                        raise PrerequisiteError('GNU coreutils timeout is required.')
                elif name == 'python3':
                    if version(out.strip().removeprefix('Python ')) < (3, 10, 0):
                        raise PrerequisiteError('Python 3.10+ is required.')
                elif name == 'pnpm':
                    if out.strip() != pin.split('@')[1]:
                        raise PrerequisiteError(f'pnpm version differs from source pin {pin.split("@")[1]}; no existing package manager will be overwritten.')
                elif version(out) < {'bun': (1, 3, 12), 'node': (20, 0, 0)}[name]:
                    raise PrerequisiteError(f'{name} is too old; select a compatible version on PATH. Existing runtimes will not be replaced.')
                row['version'] = out.strip().splitlines()[0]
        except Exception as exc:
            # command() deliberately withholds child stderr. Never expose it here.
            row.update(status='incompatible', detail=str(exc))
        rows.append(row)
    if build:
        pnpm = next(row for row in rows if row['name'] == 'pnpm')
        npm = next(row for row in rows if row['name'] == 'npm')
        if pnpm['status'] == 'missing' and allow_pnpm:
            pnpm['status'] = 'bootstrap'
            pnpm['detail'] = f'Missing {pin}; existing private, script-disabled pnpm bootstrap will be used.'
        if pnpm['status'] != 'bootstrap':
            npm['status'] = 'optional'
        elif npm['status'] == 'missing':
            npm['detail'] = 'Install the npm bundled with your selected Node release; missing npm alone does not authorize replacing Node.'
    return rows


def unresolved(rows):
    return [row for row in rows if row['status'] in ('missing', 'incompatible')]


def guidance():
    return ('System packages are operator-managed (commands to review, never run here):\n'
            '  Debian/Ubuntu: sudo apt-get install python3 bash coreutils ca-certificates\n'
            '  Fedora/RHEL: sudo dnf install python3 bash coreutils ca-certificates\n'
            '    Fedora Workstation Node/npm alternative: sudo dnf install nodejs; verify node --version and npm --version.\n'
            '    Silverblue/Kinoite: use the Fedora Atomic/Toolbx package workflow, not host dnf.\n'
            '  Arch: sudo pacman -S python bash coreutils ca-certificates\n'
            '  Alpine/musl: sudo apk add python3 bash coreutils ca-certificates nodejs npm; '
            'select a distro-supported Bun separately (automatic runtime bootstrap is unsupported).\n'
            'Check distro versions meet Python 3.10+, Node 20+, Bun 1.3.12+.\n'
            'Hermes: install a reviewed, pinned release via https://github.com/NousResearch/hermes-agent; '
            'initialize the selected profile yourself. No Hermes checkout, provider setup or credentials are installed/copied.\n'
            'For missing supported runtimes, rerun with --bootstrap-prerequisites. See docs/install.md.')


def format_inventory(rows):
    lines = ['Prerequisite inventory:']
    for row in rows:
        lines.append(f'  {row["name"]}: {row["status"]}' + (f' ({row["path"]})' if row['path'] else '')
                     + (f' — {row["detail"]}' if row.get('detail') else ''))
    return '\n'.join(lines)


class OfficialRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def check_url(url):
    from urllib.parse import urlsplit
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname not in
            {'nodejs.org', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}
            or parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise PrerequisiteError('Runtime download/redirect is not an allowed official HTTPS source.')


def download(recipe, destination):
    check_url(recipe['url'])
    digest = hashlib.sha256()
    start = time.monotonic()
    count = 0
    try:
        opener = urllib.request.build_opener(OfficialRedirects())
        with opener.open(recipe['url'], timeout=30) as response, destination.open('xb') as output:
            check_url(response.geturl())
            while True:
                # One underlying read per deadline check, including slow streams.
                chunk = response.read1(1024 * 1024)
                if not chunk:
                    break
                count += len(chunk)
                if count > MAX_DOWNLOAD or time.monotonic() - start > 300:
                    raise PrerequisiteError('Runtime download exceeded size/time limits.')
                digest.update(chunk)
                output.write(chunk)
    except (OSError, urllib.error.URLError, http.client.HTTPException) as exc:
        raise PrerequisiteError('Runtime download failed; check network, CA certificates and official source availability. No runtime was activated.') from exc
    if digest.hexdigest() != recipe['sha256']:
        raise PrerequisiteError('Runtime SHA-256 integrity check failed; no runtime was activated. Do not bypass this check.')


def safe_member(name, root):
    path = PurePosixPath(name)
    if (path.is_absolute() or '\\' in name or ':' in name or '..' in path.parts
            or not path.parts or path.parts[0] != root):
        raise PrerequisiteError('Unsafe runtime archive path.')
    return path.parts[1:]


def unpack(archive, stage, name, recipe):
    """Never use extractall: no archive links, devices, permissions or paths trusted."""
    total = 0
    seen = set()

    def save(member, source, size, executable):
        nonlocal total
        parts = safe_member(member, recipe['root'])
        if not parts:
            raise PrerequisiteError('Unexpected runtime archive file at root.')
        destination = stage.joinpath(*parts)
        if destination in seen:
            raise PrerequisiteError('Duplicate runtime archive member.')
        seen.add(destination)
        total += size
        if total > MAX_EXTRACTED:
            raise PrerequisiteError('Runtime archive exceeds extraction size limit.')
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with destination.open('xb') as output:
            shutil.copyfileobj(source, output)
        destination.chmod(0o700 if executable else 0o600)

    if name == 'bun':
        with zipfile.ZipFile(archive) as bundle:
            for item in bundle.infolist():
                parts = safe_member(item.filename, recipe['root'])
                if item.is_dir():
                    continue
                if stat.S_ISLNK(item.external_attr >> 16):
                    raise PrerequisiteError('Runtime zip contains a link.')
                if item.flag_bits & 1:
                    raise PrerequisiteError('Encrypted runtime archives are unsupported.')
                # Bun has one executable. Retain any license/readme alongside it.
                with bundle.open(item) as source:
                    save(item.filename, source, item.file_size, parts == ('bun',))
        (stage / 'bin').mkdir(mode=0o700)
        (stage / 'bun').rename(stage / 'bin/bun')
    else:
        with tarfile.open(archive, 'r:gz') as bundle:
            for item in bundle:
                safe_member(item.name, recipe['root'])
                if item.isdir():
                    continue
                # Recreate only known npm aliases ourselves after extraction.
                if item.issym() and item.name in tuple(recipe['root'] + '/bin/' + alias for alias in ('npm', 'npx', 'corepack')):
                    continue
                if not item.isfile():
                    raise PrerequisiteError('Runtime tar contains an unsupported link/device.')
                with bundle.extractfile(item) as source:
                    save(item.name, source, item.size, bool(item.mode & 0o111))
        for alias in ('npm', 'npx'):
            target = stage / f'lib/node_modules/npm/bin/{alias}-cli.js'
            if not target.is_file():
                raise PrerequisiteError('Node archive lacks the expected bundled npm entrypoint.')
            (stage / 'bin' / alias).symlink_to(f'../lib/node_modules/npm/bin/{alias}-cli.js')
    if not (stage / 'bin' / name).is_file():
        raise PrerequisiteError('Runtime archive lacks its expected executable.')


def bootstrap(name, data, target, env, command, directory_check):
    """Stage, verify, then rename under a private exclusive directory lock."""
    prefix = runtime_prefix(data, name, target)
    directory_check(prefix.parent, ancestors=True)
    prefix.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory_check(prefix.parent, ancestors=True)
    lock = prefix.with_name(prefix.name + '.installing')
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError:
        raise PrerequisiteError(f'Runtime install is locked at {lock}; wait for the other installer. After a crash, review this directory explicitly.') from None
    try:
        if prefix.exists() or prefix.is_symlink():
            raise PrerequisiteError(f'Runtime destination already exists: {prefix}. It will not be overwritten; review partial/incompatible state explicitly.')
        with tempfile.TemporaryDirectory(prefix='stage-', dir=lock) as scratch:
            scratch = Path(scratch)
            archive = scratch / 'download'
            stage = scratch / 'runtime'
            stage.mkdir(mode=0o700)
            recipe = PINS[name][target]
            download(recipe, archive)
            try:
                unpack(archive, stage, name, recipe)
            except (tarfile.TarError, zipfile.BadZipFile, EOFError) as exc:
                raise PrerequisiteError('Invalid runtime archive; no runtime was activated.') from exc
            validate_tree(stage, directory_check)
            test_env = dict(env, PATH=str(stage / 'bin') + os.pathsep + env['PATH'])
            _, out, _ = command([str(stage / 'bin' / name), '--version'], test_env, f'Checking downloaded {name}')
            if version(out) != version(PINS[name]['version']):
                raise PrerequisiteError('Downloaded runtime version differs from its source pin; no runtime was activated.')
            if prefix.exists() or prefix.is_symlink():
                raise PrerequisiteError('Runtime destination appeared during setup; preserved for review.')
            stage.rename(prefix)
    finally:
        lock.rmdir()
