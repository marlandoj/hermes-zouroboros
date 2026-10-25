"""Offline bootstrap tests: synthetic archives, fake commands, scratch state only."""
import contextlib
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import urllib.error
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import prerequisites as p
import install as installer


def fake_command(argv, env, label):
    values = {'bun': '1.3.12', 'node': 'v24.22.1', 'pnpm': '8.15.0',
              'python3': 'Python 3.10.12', 'timeout': 'timeout (GNU coreutils) 9.1'}
    return 0, values[Path(argv[0]).name], ''


def fake_which(name, path):
    return str(ROOT / 'fake-bin' / name)


class InventoryTests(unittest.TestCase):
    def collect(self, available=(), versions=None, build=True, allow=True):
        def which(name, path):
            return str(ROOT / 'fake-bin' / name) if name in available else None

        def run(argv, env, label):
            if versions and Path(argv[0]).name in versions:
                result = versions[Path(argv[0]).name]
                if isinstance(result, Exception):
                    raise result
                return 0, result, ''
            return fake_command(argv, env, label)

        with mock.patch.object(p.shutil, 'which', side_effect=which):
            return p.inventory({'PATH': 'fixture'}, ROOT / 'nonexistent-fixture', build, allow, run, lambda path: None)

    def test_all_missing_are_reported_together(self):
        rows = self.collect()
        self.assertEqual({r['name'] for r in rows}, {'hermes', 'node', 'bun', 'timeout', 'bash', 'python3', 'pnpm', 'npm'})
        self.assertEqual(next(r['status'] for r in rows if r['name'] == 'pnpm'), 'bootstrap')
        text = p.format_inventory(rows)
        for name in ('hermes', 'bun', 'node', 'timeout', 'python3', 'bash', 'npm'):
            self.assertIn(name + ': missing', text)

    def test_pnpm_opt_out_is_blocking_and_npm_optional(self):
        rows = self.collect(allow=False)
        self.assertIn('pnpm', [r['name'] for r in p.unresolved(rows)])
        self.assertEqual(next(r['status'] for r in rows if r['name'] == 'npm'), 'optional')

    def test_skip_build_does_not_require_package_managers(self):
        rows = self.collect(['hermes', 'bun', 'node', 'timeout', 'bash', 'python3'], build=False)
        self.assertEqual(p.unresolved(rows), [])
        self.assertEqual(len(rows), 6)

    def test_existing_compatible_runtimes_and_pnpm(self):
        rows = self.collect(['hermes', 'bun', 'node', 'timeout', 'bash', 'python3', 'pnpm'])
        self.assertEqual(p.unresolved(rows), [])

    def test_incompatible_tools_are_all_reported(self):
        rows = self.collect(['node', 'bun', 'python3', 'timeout', 'pnpm'],
                            {'node': 'v18.20.1', 'bun': '1.0.0', 'python3': 'Python 3.9.0',
                             'timeout': 'BusyBox timeout', 'pnpm': '9.0.0'})
        self.assertEqual({r['name'] for r in rows if r['status'] == 'incompatible'},
                         {'node', 'bun', 'python3', 'timeout', 'pnpm'})
        self.assertIn('source pin 8.15.0', p.format_inventory(rows))

    def test_failed_or_prerelease_versions_are_not_replaced(self):
        for output in ('1.3.12-canary', 'unknown', installer.InstallError('Version command failed')):
            with self.subTest(output=str(output)):
                row = self.collect(['bun'], {'bun': output})[1]
                self.assertEqual(row['status'], 'incompatible')

    def test_untrusted_pnpm_is_not_executed_even_for_inventory(self):
        def trust(path):
            raise installer.InstallError('pnpm executable is not trusted')

        run = mock.Mock(side_effect=fake_command)
        with mock.patch.object(p.shutil, 'which', side_effect=fake_which):
            rows = p.inventory({'PATH': 'fixture'}, ROOT / 'nonexistent-fixture', True, True, run, trust)
        self.assertNotIn('pnpm', [Path(call.args[0][0]).name for call in run.call_args_list])
        self.assertIn('not trusted', p.format_inventory(rows))

    def test_guidance_names_distros_and_manual_hermes_boundary(self):
        text = p.guidance()
        for value in ('Debian/Ubuntu', 'Fedora/RHEL', 'Arch', 'Alpine/musl', 'pinned release', 'No Hermes checkout'):
            self.assertIn(value, text)


class PlatformTests(unittest.TestCase):
    def platform(self, system='Linux', machine='x86_64', libc=('glibc', '2.28'), kernel='4.18.0'):
        with mock.patch.object(p.platform, 'system', return_value=system), \
                mock.patch.object(p.platform, 'machine', return_value=machine), \
                mock.patch.object(p.platform, 'libc_ver', return_value=libc), \
                mock.patch.object(p.platform, 'release', return_value=kernel):
            return p.target_platform()

    def test_supported_architectures(self):
        self.assertEqual(self.platform(), 'linux-x64')
        self.assertEqual(self.platform(machine='aarch64'), 'linux-arm64')
        self.assertEqual(self.platform(machine='arm64'), 'linux-arm64')

    def test_unsupported_targets(self):
        for values in ({'system': 'Darwin'}, {'system': 'Windows'}, {'machine': 'i686'},
                       {'libc': ('musl', '1.2')}, {'libc': ('glibc', '2.27')},
                       {'libc': ('', '')}, {'kernel': '4.17.0'}):
            with self.subTest(values=values), self.assertRaises(p.PrerequisiteError):
                self.platform(**values)

    def test_manifest_has_exact_official_pins(self):
        for name, pin in p.PINS.items():
            p.version(pin['version'])
            for target in ('linux-x64', 'linux-arm64'):
                recipe = pin[target]
                p.check_url(recipe['url'])
                self.assertIn(pin['version'], recipe['url'])
                self.assertRegex(recipe['sha256'], r'^[a-f0-9]{64}$')


class DownloadTests(unittest.TestCase):
    def perform(self, body=b'fixture', digest=None, url='https://nodejs.org/fixture', error=None):
        response = io.BytesIO(body)
        response.geturl = lambda: url
        opener = mock.Mock()
        opener.open.side_effect = error
        opener.open.return_value = response
        with tempfile.TemporaryDirectory() as scratch, mock.patch.object(p.urllib.request, 'build_opener', return_value=opener):
            destination = Path(scratch) / 'download'
            p.download({'url': 'https://nodejs.org/fixture', 'sha256': digest or hashlib.sha256(body).hexdigest()}, destination)
            self.assertEqual(destination.read_bytes(), body)

    def test_integrity_verified(self):
        self.perform()

    def test_wrong_digest_fails(self):
        with self.assertRaisesRegex(p.PrerequisiteError, 'SHA-256'):
            self.perform(digest='0' * 64)

    def test_failed_download_fails_cleanly(self):
        for error in (urllib.error.URLError('offline'), TimeoutError('timeout'), OSError('disk full'),
                      http.client.IncompleteRead(b'partial')):
            with self.subTest(error=error), self.assertRaisesRegex(p.PrerequisiteError, 'download failed'):
                self.perform(error=error)

    def test_size_and_total_deadline(self):
        with mock.patch.object(p, 'MAX_DOWNLOAD', 2), self.assertRaisesRegex(p.PrerequisiteError, 'limits'):
            self.perform()
        with mock.patch.object(p.time, 'monotonic', side_effect=[0, 301]), self.assertRaisesRegex(p.PrerequisiteError, 'limits'):
            self.perform()

    def test_redirect_and_final_url_restrictions(self):
        for url in ('http://nodejs.org/a', 'https://evil.example/a', 'https://nodejs.org.evil.example/a',
                    'https://user@nodejs.org/a', 'file:///tmp/a', 'https://nodejs.org:444/a'):
            with self.subTest(url=url), self.assertRaises(p.PrerequisiteError):
                p.check_url(url)
        with self.assertRaises(p.PrerequisiteError):
            self.perform(url='http://nodejs.org/fixture')
        with self.assertRaises(p.PrerequisiteError):
            p.OfficialRedirects().redirect_request(None, None, 302, '', {}, 'https://evil.example/a')
        p.check_url('https://release-assets.githubusercontent.com/a')


class OwnershipTests(unittest.TestCase):
    def test_private_runtime_rejects_unsafe_file_metadata(self):
        prefix = ROOT / 'fake-runtime'
        for values in ({'st_mode': stat.S_IFREG | 0o666}, {'st_uid': 999},
                       {'st_nlink': 2}, {'st_mode': stat.S_IFIFO | 0o600}):
            info = SimpleNamespace(**dict({'st_mode': stat.S_IFREG | 0o600, 'st_uid': 123, 'st_nlink': 1}, **values))
            with self.subTest(values=values), \
                    mock.patch.object(p.os, 'getuid', return_value=123, create=True), \
                    mock.patch.object(p.os, 'walk', return_value=[(str(prefix), [], ['bun'])]), \
                    mock.patch.object(Path, 'exists', return_value=True), \
                    mock.patch.object(Path, 'lstat', return_value=info), \
                    self.assertRaises(p.PrerequisiteError):
                p.validate_tree(prefix, mock.Mock())

    def test_unexpected_private_runtime_link_is_rejected(self):
        prefix = ROOT / 'fake-runtime'
        info = SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)
        with mock.patch.object(p.os, 'walk', return_value=[(str(prefix), [], ['bun'])]), \
                mock.patch.object(Path, 'exists', return_value=True), \
                mock.patch.object(Path, 'lstat', return_value=info), \
                self.assertRaisesRegex(p.PrerequisiteError, 'Unexpected link'):
            p.validate_tree(prefix, mock.Mock())

    def test_npm_alias_cannot_escape_runtime_prefix(self):
        prefix = ROOT / 'fake-runtime'
        info = SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)
        with mock.patch.object(p.os, 'walk', return_value=[(str(prefix / 'bin'), [], ['npm'])]), \
                mock.patch.object(Path, 'exists', return_value=True), \
                mock.patch.object(Path, 'lstat', return_value=info), \
                mock.patch.object(Path, 'resolve', return_value=ROOT / 'outside'), \
                self.assertRaisesRegex(p.PrerequisiteError, 'escapes'):
            p.validate_tree(prefix, mock.Mock())

    def test_private_directories_are_checked_before_files(self):
        check = mock.Mock(side_effect=installer.InstallError('unsafe directory'))
        with self.assertRaisesRegex(installer.InstallError, 'unsafe directory'):
            p.validate_tree(ROOT / 'fake-runtime', check)
        check.assert_called_once()


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.archive = self.root / 'archive'
        self.stage = self.root / 'stage'
        self.stage.mkdir()
        self.recipe = {'root': 'fixture'}

    def tearDown(self):
        self.temp.cleanup()

    def zip(self, entries):
        with zipfile.ZipFile(self.archive, 'w') as bundle:
            for name, body in entries:
                bundle.writestr(name, body)

    def tar(self, entries):
        with tarfile.open(self.archive, 'w:gz') as bundle:
            for name, kind in entries:
                item = tarfile.TarInfo(name)
                item.type = kind
                item.linkname = '../../outside'
                item.mode = 0o7777
                item.size = 7 if kind == tarfile.REGTYPE else 0
                bundle.addfile(item, io.BytesIO(b'fixture') if item.size else None)

    def test_bun_extracts_only_inside_staging(self):
        self.zip([('fixture/bun', b'fixture'), ('fixture/LICENSE', b'license')])
        p.unpack(self.archive, self.stage, 'bun', self.recipe)
        self.assertEqual((self.stage / 'bin/bun').read_bytes(), b'fixture')
        self.assertEqual((self.stage / 'LICENSE').read_bytes(), b'license')

    def test_archive_paths_cannot_escape(self):
        for name in ('../outside', '/outside', 'fixture/../../outside', 'fixture/..\\outside', 'other/bun', 'fixture/C:outside'):
            with self.subTest(name=name), self.assertRaises(p.PrerequisiteError):
                p.safe_member(name, 'fixture')

    def test_duplicate_members_fail(self):
        with contextlib.redirect_stderr(io.StringIO()):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                self.zip([('fixture/bun', b'a'), ('fixture/bun', b'b')])
        with self.assertRaisesRegex(p.PrerequisiteError, 'Duplicate'):
            p.unpack(self.archive, self.stage, 'bun', self.recipe)

    def test_zip_symlinks_fail(self):
        with zipfile.ZipFile(self.archive, 'w') as bundle:
            info = zipfile.ZipInfo('fixture/bun')
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            bundle.writestr(info, '../../outside')
        with self.assertRaisesRegex(p.PrerequisiteError, 'link'):
            p.unpack(self.archive, self.stage, 'bun', self.recipe)

    def test_extraction_size_limit(self):
        self.zip([('fixture/bun', b'fixture')])
        with mock.patch.object(p, 'MAX_EXTRACTED', 2), self.assertRaisesRegex(p.PrerequisiteError, 'size'):
            p.unpack(self.archive, self.stage, 'bun', self.recipe)

    def test_tar_links_and_devices_fail(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind):
                self.tar([('fixture/bad', kind)])
                with self.assertRaisesRegex(p.PrerequisiteError, 'link/device'):
                    p.unpack(self.archive, self.stage, 'node', self.recipe)

    def test_node_bundled_npm_layout_and_fixed_aliases(self):
        self.tar([('fixture/bin/node', tarfile.REGTYPE),
                  ('fixture/lib/node_modules/npm/bin/npm-cli.js', tarfile.REGTYPE),
                  ('fixture/lib/node_modules/npm/bin/npx-cli.js', tarfile.REGTYPE),
                  ('fixture/bin/npm', tarfile.SYMTYPE), ('fixture/bin/corepack', tarfile.SYMTYPE)])
        with mock.patch.object(Path, 'symlink_to') as link:
            p.unpack(self.archive, self.stage, 'node', self.recipe)
        self.assertEqual([call.args[0] for call in link.call_args_list],
                         ['../lib/node_modules/npm/bin/npm-cli.js', '../lib/node_modules/npm/bin/npx-cli.js'])
        self.assertEqual((self.stage / 'bin/node').read_bytes(), b'fixture')
        if os.name == 'posix':
            self.assertEqual(stat.S_IMODE((self.stage / 'bin/node').stat().st_mode), 0o700)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / 'private state'
        self.prefix = p.runtime_prefix(self.data, 'bun', 'linux-x64')
        self.directory_check = mock.Mock()
        self.command = mock.Mock(return_value=(0, '1.3.12', ''))
        self.download = mock.patch.object(p, 'download', side_effect=self.make_archive)
        self.download_mock = self.download.start()
        self.validate = mock.patch.object(p, 'validate_tree')
        self.validate.start()

    def tearDown(self):
        self.download.stop()
        self.validate.stop()
        self.temp.cleanup()

    def make_archive(self, recipe, destination):
        with zipfile.ZipFile(destination, 'w') as bundle:
            bundle.writestr(recipe['root'] + '/bun', b'synthetic, never executed')

    def run_bootstrap(self):
        p.bootstrap('bun', self.data, 'linux-x64', {'PATH': 'operator-path'}, self.command, self.directory_check)

    def test_publish_after_verification_only(self):
        self.run_bootstrap()
        self.assertTrue((self.prefix / 'bin/bun').is_file())
        self.assertFalse(self.prefix.with_name(self.prefix.name + '.installing').exists())
        self.assertIn('operator-path', self.command.call_args.args[1]['PATH'])
        self.assertEqual(self.command.call_count, 1)

    def test_existing_destination_is_never_overwritten(self):
        self.prefix.mkdir(parents=True)
        sentinel = self.prefix / 'operator-file'
        sentinel.write_text('preserve')
        with self.assertRaisesRegex(p.PrerequisiteError, 'not be overwritten'):
            self.run_bootstrap()
        self.download_mock.assert_not_called()
        self.assertEqual(sentinel.read_text(), 'preserve')

    def test_download_integrity_or_execution_failure_leaves_no_prefix(self):
        for error in (p.PrerequisiteError('SHA-256'), p.PrerequisiteError('offline')):
            with self.subTest(error=error):
                self.download_mock.side_effect = error
                with self.assertRaises(p.PrerequisiteError):
                    self.run_bootstrap()
                self.assertFalse(self.prefix.exists())
                self.assertEqual(list(self.prefix.parent.iterdir()), [])
        self.download_mock.side_effect = self.make_archive
        self.command.side_effect = installer.InstallError('cannot execute downloaded runtime')
        with self.assertRaises(installer.InstallError):
            self.run_bootstrap()
        self.assertFalse(self.prefix.exists())

    def test_wrong_runtime_version_leaves_no_prefix(self):
        self.command.return_value = (0, '1.0.0', '')
        with self.assertRaisesRegex(p.PrerequisiteError, 'source pin'):
            self.run_bootstrap()
        self.assertFalse(self.prefix.exists())

    def test_bad_archive_leaves_no_prefix(self):
        self.download_mock.side_effect = lambda recipe, path: path.write_bytes(b'bad zip')
        with self.assertRaisesRegex(p.PrerequisiteError, 'Invalid runtime archive'):
            self.run_bootstrap()
        self.assertFalse(self.prefix.exists())

    def test_concurrent_lock_is_preserved(self):
        lock = self.prefix.with_name(self.prefix.name + '.installing')
        lock.mkdir(parents=True)
        with self.assertRaisesRegex(p.PrerequisiteError, 'locked'):
            self.run_bootstrap()
        self.assertTrue(lock.exists())
        self.download_mock.assert_not_called()

    def test_reruns_append_private_path_without_shadowing_user_tools(self):
        self.run_bootstrap()
        env = {'PATH': 'operator-path'}
        with mock.patch.object(p, 'target_platform', return_value='linux-x64'):
            p.add_private_paths(env, self.data, self.directory_check)
        self.assertTrue(env['PATH'].startswith('operator-path' + os.pathsep))
        self.assertIn(str(self.prefix / 'bin'), env['PATH'])
        with mock.patch.object(p.shutil, 'which', side_effect=fake_which):
            rows = p.inventory(env, self.data, False, True, fake_command, lambda path: None)
        self.assertFalse(p.unresolved(rows))
        self.assertEqual(self.download_mock.call_count, 1)


class InstallerFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.data = self.home / 'data with spaces'
        self.profile = self.home / 'profile'
        self.profile.mkdir()
        self.config = self.profile / 'config.yaml'
        self.config.write_text('synthetic')
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(mock.patch.object(installer.sys, 'platform', 'linux'))
        self.stack.enter_context(mock.patch.object(Path, 'home', return_value=self.home))
        for name in ('check_state_files', 'check_private_prefix', 'check_connection', 'check_settings', 'check_built_source'):
            self.stack.enter_context(mock.patch.object(installer, name))
        self.stack.enter_context(mock.patch.object(p, 'add_private_paths'))
        self.stack.enter_context(mock.patch.object(installer, 'get_server', return_value={'enabled': True}))
        self.stack.enter_context(mock.patch.object(installer, 'state_workspace', return_value=(self.home / 'workspace', True)))
        self.stack.enter_context(mock.patch.object(p.shutil, 'which', side_effect=fake_which))
        self.stack.enter_context(mock.patch.object(installer, 'command', return_value=(0, str(self.config), '')))
        self.locks = self.stack.enter_context(mock.patch.object(installer, 'install_locks'))
        self.finish = self.stack.enter_context(mock.patch.object(installer, 'finish_install'))
        self.bootstrap = self.stack.enter_context(mock.patch.object(p, 'bootstrap'))
        self.target = self.stack.enter_context(mock.patch.object(p, 'target_platform', return_value='linux-x64'))
        self.rows = [{'name': name, 'path': '/fixture/' + name, 'status': 'present'}
                     for name in ('hermes', 'bun', 'node', 'bash', 'timeout', 'python3')]
        self.inventory = self.stack.enter_context(mock.patch.object(p, 'inventory', return_value=self.rows))
        self.output = io.StringIO()
        self.stack.enter_context(contextlib.redirect_stdout(self.output))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def tearDown(self):
        self.stack.close()
        self.temp.cleanup()

    def run_install(self, *flags):
        args = installer.parser().parse_args(['--data-home', str(self.data), *flags])
        installer.install(args)

    def test_default_never_bootstraps(self):
        self.rows[1].update(status='missing', path=None)
        with self.assertRaisesRegex(installer.InstallError, 'bun: missing'):
            self.run_install()
        self.bootstrap.assert_not_called()
        self.assertFalse(self.data.exists())

    def test_manual_blocker_prevents_even_opted_in_downloads(self):
        self.rows[0].update(status='missing', path=None)
        self.rows[1].update(status='missing', path=None)
        with self.assertRaisesRegex(installer.InstallError, 'hermes: missing'):
            self.run_install('--bootstrap-prerequisites')
        self.bootstrap.assert_not_called()

    def test_incompatible_runtime_is_not_replaced(self):
        self.rows[1].update(status='incompatible')
        with self.assertRaises(installer.InstallError):
            self.run_install('--bootstrap-prerequisites')
        self.bootstrap.assert_not_called()

    def test_opted_in_missing_runtime_download_and_reinventory(self):
        first = [dict(row) for row in self.rows]
        first[1].update(status='missing', path=None)
        self.inventory.side_effect = [first, self.rows]
        self.run_install('--bootstrap-prerequisites')
        self.assertEqual(self.bootstrap.call_args.args[0], 'bun')
        self.assertEqual(self.inventory.call_count, 2)
        self.finish.assert_called_once()

    def test_missing_node_and_bun_are_both_planned_before_bootstrap(self):
        first = [dict(row) for row in self.rows]
        for row in first:
            if row['name'] in ('node', 'bun'):
                row.update(status='missing', path=None)
        first += [{'name': 'npm', 'path': None, 'status': 'missing'}]
        self.inventory.side_effect = [first, self.rows]
        self.run_install('--bootstrap-prerequisites')
        self.assertEqual({call.args[0] for call in self.bootstrap.call_args_list}, {'node', 'bun'})
        self.assertEqual(first[-1]['status'], 'bootstrap')
        self.assertEqual(self.inventory.call_count, 2)

    def test_failed_runtime_bootstrap_cannot_reach_profile_mutations(self):
        self.rows[1].update(status='missing', path=None)
        self.bootstrap.side_effect = p.PrerequisiteError('SHA-256 integrity check failed')
        with self.assertRaisesRegex(p.PrerequisiteError, 'SHA-256'):
            self.run_install('--bootstrap-prerequisites')
        self.locks.assert_not_called()
        self.finish.assert_not_called()

    def test_home_paths_and_inherited_path_are_available_during_inventory(self):
        with mock.patch.dict(os.environ, {'PATH': 'operator-path'}, clear=True):
            self.run_install('--dry-run')
        path = self.inventory.call_args.args[0]['PATH']
        self.assertTrue(path.startswith(str(self.home / '.local/bin') + os.pathsep + str(self.home / '.bun/bin')))
        self.assertTrue(path.endswith('operator-path'))

    def test_opted_in_dry_run_is_non_mutating_and_defers_profile_checks(self):
        self.rows[1].update(status='missing', path=None)
        self.run_install('--bootstrap-prerequisites', '--dry-run')
        report = json.loads(self.output.getvalue())
        self.assertTrue(report['plan']['profileChecksDeferred'])
        self.bootstrap.assert_not_called()
        self.locks.assert_not_called()
        self.finish.assert_not_called()
        self.assertFalse(self.data.exists())

    def test_check_never_bootstraps_even_when_opted_in(self):
        self.rows[1].update(status='missing', path=None)
        with self.assertRaisesRegex(installer.InstallError, '--check never installs'):
            self.run_install('--bootstrap-prerequisites', '--check')
        self.bootstrap.assert_not_called()
        self.locks.assert_not_called()

    def test_existing_runtime_rerun_needs_no_opt_in(self):
        self.run_install()
        self.bootstrap.assert_not_called()
        self.finish.assert_called_once()

    def test_static_check_has_no_locks_startup_downloads_or_writes(self):
        self.data.mkdir()
        (self.data / 'memory.db').write_bytes(b'synthetic')
        before = {path: path.read_bytes() for path in self.home.rglob('*') if path.is_file()}
        self.run_install('--check', '--bootstrap-prerequisites')
        report = json.loads(self.output.getvalue())
        self.assertTrue(report['verification']['staticCheck'])
        self.assertFalse(report['verification']['startupFilesystemWritesPossible'])
        self.bootstrap.assert_not_called()
        self.finish.assert_not_called()
        self.locks.assert_not_called()
        self.assertEqual(before, {path: path.read_bytes() for path in self.home.rglob('*') if path.is_file()})

    def test_noninteractive_does_not_prompt(self):
        with mock.patch('builtins.input', side_effect=AssertionError('must not prompt')):
            self.run_install('--dry-run', '--bootstrap-prerequisites')
        self.bootstrap.assert_not_called()

    def test_unsupported_platform_fails_before_any_download(self):
        self.rows[1].update(status='missing', path=None)
        self.target.side_effect = p.PrerequisiteError('Unsupported platform')
        with self.assertRaisesRegex(installer.InstallError, 'Unsupported platform'):
            self.run_install('--bootstrap-prerequisites')
        self.bootstrap.assert_not_called()

    def test_linux_only_guard_and_help_on_this_host(self):
        with mock.patch.object(installer.sys, 'platform', 'win32'), self.assertRaisesRegex(installer.InstallError, 'Linux only'):
            self.run_install('--bootstrap-prerequisites')
        help_text = subprocess.run([sys.executable, str(ROOT / 'scripts/install.py'), '--help'],
                                   capture_output=True, text=True, timeout=10)
        self.assertEqual(help_text.returncode, 0, help_text.stderr)
        self.assertIn('--bootstrap-prerequisites', help_text.stdout)


if __name__ == '__main__':
    unittest.main()
