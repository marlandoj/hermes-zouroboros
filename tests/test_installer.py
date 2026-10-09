"""Installer regression tests; all writable state belongs to a scratch fixture."""
import os
from pathlib import Path
import subprocess
import sys
import unittest
import json
import shutil
import shlex
import sqlite3
import tempfile
import importlib.util
import fcntl
import signal
import time
from unittest import mock
from contextlib import closing

FAKE_HERMES = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
args=sys.argv[1:]
root=pathlib.Path(os.environ['HERMES_HOME']); config=root/'config.yaml'
root.mkdir(parents=True, exist_ok=True)
with open(os.environ['INSTALL_TEST_LOG'], 'a') as log:
    log.write(json.dumps({'args':args,'home':str(root)})+'\n')
c=json.loads(config.read_text()) if config.exists() else {}
if args == ['config','path']:
    print(config); sys.exit(0)
if args[:2] == ['config','get']:
    if (root/'fail-next-read').exists():
        (root/'fail-next-read').unlink();print('invalid fixture readback');sys.exit(0)
    value=c
    for part in args[2].split('.'):
        if not isinstance(value,dict) or part not in value:
            if os.environ.get('INSTALL_TEST_INSERT_AFTER_READ'):
                c.setdefault('mcp_servers',{})['zouroboros']={'command':'operator-owned-command'}
                config.write_text(json.dumps(c,sort_keys=True))
            print('Config key not set: '+args[2], file=sys.stderr);sys.exit(1)
        value=value[part]
    print(json.dumps(value));sys.exit(0)
if args[:2] == ['config','set']:
    if args[2]==os.environ.get('INSTALL_TEST_IGNORE_SET'):
        print('saved (fixture no-op)');sys.exit(0)
    parts=args[2].split('.'); target=c
    for part in parts[:-1]: target=target.setdefault(part,{})
    try:value=json.loads(args[3])
    except ValueError:value=args[3]
    target[parts[-1]]=value
    config.write_text(json.dumps(c,sort_keys=True));print('saved');sys.exit(0)
if args[:2] == ['mcp','add']:
    answer=sys.stdin.readline().strip().lower()
    if os.environ.get('INSTALL_TEST_LATE_ADD'):
        c.setdefault('mcp_servers',{})['zouroboros']={'command':'operator-owned-command'}
        config.write_text(json.dumps(c,sort_keys=True))
    if args[2] in c.get('mcp_servers',{}) and answer not in ('y','yes'):
        print('cancelled overwrite');sys.exit(0)
    if os.environ.get('INSTALL_TEST_CANCEL_ADD'):
        print('cancelled');sys.exit(0)
    name=args[2]; pos=args.index('--args'); supplied=args[3:pos]
    envpos=supplied.index('--env')
    env=dict(item.split('=',1) for item in supplied[envpos+1:])
    server={'command':supplied[supplied.index('--command')+1],'args':args[pos+1:],'env':env,'connect_timeout':30.0,'enabled':True}
    c.setdefault('mcp_servers',{})[name]=server
    config.write_text(json.dumps(c,sort_keys=True))
    if os.environ.get('INSTALL_TEST_FAIL_READ_AFTER_ADD'):(root/'fail-next-read').touch()
    print('added');sys.exit(0)
if args[:2] == ['mcp','test']:
    if os.environ.get('INSTALL_TEST_REPLACE_AFTER_TEST'):
        c['mcp_servers']['zouroboros']['env'].pop('HERMES_ZOUROBOROS_INSTALL_TAG',None)
        c['mcp_servers']['zouroboros']['env']['OPERATOR_TEST']='owned'
        config.write_text(json.dumps(c,sort_keys=True));sys.exit(0)
    if os.environ.get('INSTALL_TEST_REPLACE_ON_TEST'):
        c['mcp_servers']['zouroboros']={'command':'operator-replacement'}
        config.write_text(json.dumps(c,sort_keys=True));sys.exit(4)
    if os.environ.get('INSTALL_TEST_FAIL_TEST'):sys.exit(4)
    print('connected');sys.exit(0)
print('Unsupported fake command',file=sys.stderr);sys.exit(2)
'''


class Fixture:
    def __init__(self):
        scratch=os.environ.get('TMPDIR',str(Path.home()/'.hermes/cache/scratch'))
        Path(scratch).mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(prefix='installer-',dir=scratch)
        self.root=Path(self.temp.name)
        self.home=self.root/'normal profile';self.home.mkdir()
        self.data=self.root/'shared state';self.work=self.root/'project workspace'
        self.bin=self.root/'bin';self.bin.mkdir()
        self.config=self.home/'config.yaml'
        self.initial={'model':{'default':'synthetic-test-model'},'mcp_servers':{'unrelated':{'command':'unrelated-fixture','env':{'SYNTHETIC_TEST_SECRET':'dummy-fixture-only'}}}}
        self.config.write_text(json.dumps(self.initial,sort_keys=True))
        self.credentials=self.home/'.env';self.credentials.write_text('SYNTHETIC_TEST_SECRET=dummy-fixture-only\n')
        hermes=self.bin/'hermes';hermes.write_text(FAKE_HERMES);hermes.chmod(0o700)
        self.log=self.root/'commands.jsonl'
        self.env={'PATH':str(self.bin)+os.pathsep+os.environ['PATH'],'HOME':str(self.root),'TMPDIR':scratch,'INSTALL_TEST_LOG':str(self.log),'LANG':'C.UTF-8'}

    def run(self,*extra,build=False):
        argv=[sys.executable,str(INSTALLER),'--hermes-home',str(self.home),'--data-home',str(self.data),'--workspace',str(self.work)]
        if not build:argv.append('--skip-build')
        return subprocess.run([*argv,*extra],env=self.env,capture_output=True,text=True,timeout=45)

    def limited_tools(self,npm_fail=False,pnpm_version=None):
        for name in ['python3','bash','bun','node','timeout']:
            target=shutil.which(name)
            if not target:raise RuntimeError('Missing test prerequisite '+name)
            (self.bin/name).symlink_to(target)
        self.env['PATH']=str(self.bin)
        manager="#!/usr/bin/env python3\nimport sys\nif '--version' in sys.argv:print('8.15.0')\n"
        npm=self.bin/'npm'
        npm.write_text("#!/usr/bin/env python3\nimport pathlib,sys\n"+('sys.exit(42)\n' if npm_fail else "prefix=pathlib.Path(sys.argv[sys.argv.index('--prefix')+1]);(prefix/'bin').mkdir(parents=True,exist_ok=True)\np=prefix/'bin/pnpm';p.write_text("+repr(manager)+");p.chmod(0o700)\n"))
        npm.chmod(0o700)
        if pnpm_version:
            pnpm=self.bin/'pnpm';pnpm.write_text("#!/usr/bin/env python3\nprint("+repr(pnpm_version)+")\n");pnpm.chmod(0o700)

    def memory_calls(self,calls):
        # Real MCP calls, isolated environment, no models or workers.
        script = '''import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse } from 'yaml';
const server=parse(await Bun.file(process.argv[1]).text()).mcp_servers.zouroboros;
const client=new Client({name:'installer-crowding-test',version:'1'});
try {
  await client.connect(new StdioClientTransport({command:server.command,args:server.args,env:{...process.env,...server.env},stderr:'pipe'}));
  const output=[];
  for(const call of JSON.parse(process.argv[2])) {
    const result=await client.callTool(call);
    if(result.isError) throw new Error('fixture MCP call failed');
    output.push(JSON.parse(result.content[0].text));
  }
  console.log(JSON.stringify(output));
} finally { await client.close(); }
'''
        result=subprocess.run([shutil.which('bun'),'-e',script,str(self.config),json.dumps(calls)],
                              cwd=ROOT,env=self.env,capture_output=True,text=True,timeout=15)
        if result.returncode:raise AssertionError(result.stdout+result.stderr)
        return json.loads(result.stdout)

    def close(self): self.temp.cleanup()

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / 'scripts' / 'install.py'
spec = importlib.util.spec_from_file_location('operator_installer', INSTALLER)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_private_pnpm_accepts_npm_bin_symlink_within_validated_prefix(self):
        fixture=Fixture()
        try:
            fixture.limited_tools(npm_fail=True)
            private=fixture.data/'tools/pnpm-8.15.0'
            target=private/'lib/node_modules/pnpm/bin/pnpm.cjs'
            target.parent.mkdir(parents=True,mode=0o700)
            target.write_text('#!'+sys.executable+'\nprint("8.15.0")\n');target.chmod(0o700)
            (private/'bin').mkdir();(private/'bin/pnpm').symlink_to('../lib/node_modules/pnpm/bin/pnpm.cjs')
            env=fixture.env.copy()
            installer.ensure_pnpm(env,fixture.data,True)
            self.assertTrue(env['PATH'].startswith(str(private/'bin')+os.pathsep))
        finally:fixture.close()

    def test_non_owned_data_and_internal_directories_are_rejected(self):
        for relative in ['', 'hermes']:
            with self.subTest(relative=relative):
                fixture=Fixture()
                try:
                    target=fixture.data/relative;target.mkdir(parents=True,mode=0o700)
                    real_lstat=Path.lstat
                    def foreign_owner(path,*args,**kwargs):
                        info=real_lstat(path,*args,**kwargs)
                        if path==target:
                            values=list(info);values[4]=os.getuid()+1;return os.stat_result(values)
                        return info
                    # Metadata injection is necessary without chown privileges;
                    # every actual path and all writable state is fixture-owned.
                    with mock.patch.object(Path,'lstat',foreign_owner):
                        with self.assertRaises(installer.InstallError):installer.check_state_files(fixture.data)
                finally:fixture.close()

    def test_unsafe_lock_files_fail_without_following_or_truncating(self):
        for case in ['symlink','writable','hardlink']:
            with self.subTest(case=case):
                fixture=Fixture()
                try:
                    lock=fixture.home/'.zouroboros-install.lock'
                    outside=fixture.root/'outside';outside.write_text('sentinel');outside.chmod(0o600)
                    if case=='symlink':lock.symlink_to(outside)
                    elif case=='hardlink':os.link(outside,lock)
                    else:lock.write_text('sentinel');lock.chmod(0o666)
                    before=fixture.config.read_bytes()
                    result=fixture.run()
                    self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
                    self.assertIn('lock',result.stderr)
                    self.assertEqual(outside.read_text(),'sentinel')
                    self.assertEqual(fixture.config.read_bytes(),before)
                    self.assertFalse(fixture.data.exists())
                finally:fixture.close()

    def test_shared_data_lock_coordinates_different_profiles(self):
        fixture=Fixture()
        try:
            other=fixture.root/'another profile';other.mkdir()
            config=other/'config.yaml';config.write_text(json.dumps(fixture.initial))
            before=config.read_bytes()
            with installer.install_locks(fixture.config,fixture.data):
                result=fixture.run('--hermes-home',str(other))
                self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
                self.assertIn('lock',result.stderr)
                self.assertEqual(config.read_bytes(),before)
                self.assertFalse(fixture.data.exists())
        finally:fixture.close()

    def test_hardlinked_database_cannot_write_an_external_file(self):
        fixture=Fixture()
        try:
            fixture.data.mkdir(mode=0o700)
            outside=fixture.root/'outside.sqlite'
            with sqlite3.connect(outside) as db:db.execute('CREATE TABLE sentinel(value TEXT)')
            outside.chmod(0o600);before=outside.read_bytes()
            os.link(outside,fixture.data/'memory.db')
            result=fixture.run()
            self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertEqual(outside.read_bytes(),before)
            self.assertFalse((fixture.data/'settings.json').exists())
        finally:fixture.close()

    def test_successful_discovery_cannot_hide_operator_replacement(self):
        fixture=Fixture()
        try:
            fixture.env['INSTALL_TEST_REPLACE_AFTER_TEST']='1'
            result=fixture.run()
            self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
            server=json.loads(fixture.config.read_text())['mcp_servers']['zouroboros']
            self.assertTrue(server['enabled'])
            self.assertEqual(server['env']['OPERATOR_TEST'],'owned')
            self.assertNotIn('HERMES_ZOUROBOROS_INSTALL_TAG',server['env'])
            self.assertFalse((fixture.data/'memory.db').exists())
        finally:fixture.close()

    def test_path_pnpm_symlink_in_writable_directory_is_rejected(self):
        fixture=Fixture()
        try:
            target=fixture.root/'trusted-pnpm'
            target.write_text('#!'+sys.executable+'\nprint("8.15.0")\n');target.chmod(0o700)
            (fixture.bin/'pnpm').symlink_to(target);fixture.bin.chmod(0o777)
            with self.assertRaises(installer.InstallError):
                installer.ensure_pnpm(fixture.env.copy(),fixture.data,False)
        finally:fixture.close()

    def test_probe_rejects_changed_connection_and_unsafe_state_before_spawn(self):
        for case in ['timeout','command','hermes-link','wal-link']:
            with self.subTest(case=case):
                fixture=Fixture()
                try:
                    self.assertEqual(fixture.run().returncode,0)
                    config=json.loads(fixture.config.read_text())
                    marker=fixture.root/'executed'
                    if case=='timeout':config['mcp_servers']['zouroboros']['timeout']=900
                    elif case=='command':
                        binary=fixture.bin/'changed-command'
                        binary.write_text('#!/bin/sh\ntouch '+shlex.quote(str(marker))+'\nexec '+shlex.quote(shutil.which('bun'))+' "$@"\n')
                        binary.chmod(0o700)
                        config['mcp_servers']['zouroboros']['command']=str(binary)
                    elif case=='hermes-link':
                        outside=fixture.root/'outside-hermes'
                        (fixture.data/'hermes').rename(outside)
                        (fixture.data/'hermes').symlink_to(outside,target_is_directory=True)
                    else:
                        outside=fixture.root/'outside-wal';outside.write_text('sentinel')
                        with sqlite3.connect(fixture.data/'memory.db') as db:db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
                        (fixture.data/'memory.db-wal').unlink(missing_ok=True)
                        (fixture.data/'memory.db-wal').symlink_to(outside)
                    fixture.config.write_text(json.dumps(config))
                    result=subprocess.run([shutil.which('bun'),str(ROOT/'scripts/install-probe.ts'),str(fixture.config),'--check'],
                                          env=fixture.env,capture_output=True,text=True,timeout=10)
                    self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
                    self.assertFalse(marker.exists())
                    if case=='wal-link':self.assertEqual(outside.read_text(),'sentinel')
                finally:fixture.close()

    def test_abnormal_communicate_exit_stops_and_reaps_process_group(self):
        for error in [KeyboardInterrupt, OSError]:
            with self.subTest(error=error.__name__):
                fixture=Fixture()
                processes=[]
                try:
                    marker=fixture.root/'group-ready'
                    script=fixture.root/'group.py'
                    script.write_text('import subprocess,sys,signal,time\nfrom pathlib import Path\n'
                                      'signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
                                      'p=subprocess.Popen([sys.executable,"-c","import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)"])\n'
                                      'Path('+repr(str(marker))+').write_text(str(p.pid))\ntime.sleep(60)\n')
                    real_popen=subprocess.Popen
                    def broken_popen(*args,**kwargs):
                        proc=real_popen(*args,**kwargs);processes.append(proc)
                        real_communicate=proc.communicate
                        first=True
                        def communicate(*args,**kwargs):
                            nonlocal first
                            if first:
                                first=False
                                deadline=time.monotonic()+3
                                while not marker.exists() and time.monotonic()<deadline:time.sleep(0.01)
                                raise error('fixture interrupted communicate')
                            return real_communicate(*args,**kwargs)
                        proc.communicate=communicate
                        return proc
                    with mock.patch.object(installer.subprocess,'Popen',side_effect=broken_popen):
                        with self.assertRaises(error):
                            installer.command([sys.executable,str(script)],fixture.env,'fixture command',timeout=10)
                    proc=processes[0]
                    self.assertIsNotNone(proc.poll(),'abnormal communicate left the group leader running')
                    child=int(marker.read_text())
                    childstat=Path('/proc')/str(child)/'stat'
                    if childstat.exists():self.assertEqual(childstat.read_text().split()[2],'Z')
                finally:
                    for proc in processes:
                        try:os.killpg(proc.pid,signal.SIGKILL)
                        except ProcessLookupError:pass
                        proc.wait(timeout=3)
                        for stream in [proc.stdin,proc.stdout,proc.stderr]:
                            if stream is not None:stream.close()
                    fixture.close()

    def test_saved_add_is_disabled_even_when_first_readback_fails(self):
        fixture=Fixture()
        try:
            fixture.env['INSTALL_TEST_FAIL_READ_AFTER_ADD']='1'
            result=fixture.run()
            self.assertNotEqual(result.returncode,0)
            server=json.loads(fixture.config.read_text())['mcp_servers']['zouroboros']
            self.assertFalse(server['enabled'])
            self.assertIn('disabled',result.stderr)
        finally:fixture.close()

    def test_foreign_replacement_is_not_disabled_on_verification_failure(self):
        fixture=Fixture()
        try:
            fixture.env['INSTALL_TEST_REPLACE_ON_TEST']='1'
            result=fixture.run()
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(json.loads(fixture.config.read_text())['mcp_servers']['zouroboros'],
                             {'command':'operator-replacement'})
            self.assertIn('unresolved',result.stderr)
        finally:fixture.close()

    def test_failed_disable_readback_is_disclosed(self):
        fixture=Fixture()
        try:
            fixture.env['INSTALL_TEST_FAIL_TEST']='1'
            fixture.env['INSTALL_TEST_IGNORE_SET']='mcp_servers.zouroboros.enabled'
            result=fixture.run()
            self.assertNotEqual(result.returncode,0)
            self.assertTrue(json.loads(fixture.config.read_text())['mcp_servers']['zouroboros']['enabled'])
            self.assertIn('unresolved',result.stderr)
        finally:fixture.close()

    def test_existing_matching_connection_is_not_disabled_on_check_failure(self):
        fixture=Fixture()
        try:
            self.assertEqual(fixture.run().returncode,0)
            before=fixture.config.read_bytes()
            fixture.env['INSTALL_TEST_FAIL_TEST']='1'
            result=fixture.run('--check')
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(fixture.config.read_bytes(),before)
        finally:fixture.close()

    def test_check_verifies_timeout_without_repairing_existing_connection(self):
        fixture=Fixture()
        try:
            self.assertEqual(fixture.run().returncode,0)
            config=json.loads(fixture.config.read_text())
            config['mcp_servers']['zouroboros']['timeout']=900
            fixture.config.write_text(json.dumps(config));before=fixture.config.read_bytes()
            result=fixture.run('--check')
            self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertIn('120',result.stderr)
            self.assertEqual(fixture.config.read_bytes(),before)
        finally:fixture.close()

    def test_zero_exit_setting_write_requires_exact_readback(self):
        fixture=Fixture()
        try:
            fixture.env['INSTALL_TEST_IGNORE_SET']='mcp_servers.zouroboros.timeout'
            result=fixture.run()
            self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertFalse(json.loads(fixture.config.read_text())['mcp_servers']['zouroboros']['enabled'])
        finally:fixture.close()

    def test_malformed_nested_connection_values_fail_closed(self):
        malformed=[('env',['bad']),('env',False),('env',{'OTHER':False}),
                   ('tools',[]),('tools','bad'),('tools',{'include':[{}]}),
                   ('tools',{'include':'factory_intake'}),('tools',{'exclude':[False]}),
                   ('sampling',[]),('sampling',False),('sampling',{'enabled':'false'}),
                   ('sampling',{'enabled':0}),('enabled','true'),('enabled',1)]
        for key,value in malformed:
            with self.subTest(key=key,value=value):
                fixture=Fixture()
                try:
                    server={'command':shutil.which('bun'), 'args':[str(ROOT/'integration/mcp.ts')],
                            'env':{'HERMES_ZOUROBOROS_HOME':str(fixture.data),'HERMES_ZOUROBOROS_ALLOW_SWARM':'0'}}
                    server[key]=value
                    config=json.loads(fixture.config.read_text());config['mcp_servers']['zouroboros']=server
                    fixture.config.write_text(json.dumps(config));before=fixture.config.read_bytes()
                    result=fixture.run('--dry-run')
                    self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
                    self.assertIn('invalid',result.stderr.lower())
                    self.assertNotIn('Traceback',result.stderr)
                    self.assertEqual(fixture.config.read_bytes(),before)
                    self.assertFalse(fixture.data.exists())
                finally:fixture.close()

    def test_operator_connection_added_after_snapshot_is_preserved(self):
        for timing in ['INSERT_AFTER_READ','LATE_ADD']:
            with self.subTest(timing=timing):
                fixture=Fixture()
                try:
                    fixture.env['INSTALL_TEST_'+timing]='1'
                    result=fixture.run()
                    self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
                    self.assertEqual(json.loads(fixture.config.read_text())['mcp_servers']['zouroboros'],
                                     {'command':'operator-owned-command'})
                finally:fixture.close()

    def test_concurrent_profile_install_lock_is_respected(self):
        fixture=Fixture()
        try:
            before=fixture.config.read_bytes()
            path=fixture.home/'.zouroboros-install.lock'
            fd=os.open(path,os.O_CREAT|os.O_RDWR,0o600)
            try:
                fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                result=fixture.run()
                self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
                self.assertIn('lock',result.stderr)
                self.assertEqual(fixture.config.read_bytes(),before)
                self.assertFalse(fixture.data.exists())
            finally:os.close(fd)
        finally:fixture.close()

    def test_private_pnpm_rejects_unsafe_prefix_before_npm_or_execution(self):
        for case in ['prefix-link', 'bin-link', 'lib-link', 'prefix-writable',
                     'executable-writable', 'executable-outside-link']:
            with self.subTest(case=case):
                fixture=Fixture()
                try:
                    fixture.limited_tools()
                    private=fixture.data/'tools/pnpm-8.15.0'
                    private.mkdir(parents=True,mode=0o700)
                    outside=fixture.root/'outside';outside.mkdir()
                    marker=fixture.root/'executed'
                    script='#!/usr/bin/env python3\nfrom pathlib import Path\nPath('+repr(str(marker))+').touch()\nprint("8.15.0")\n'
                    if case=='prefix-link':private.rmdir();private.symlink_to(outside,target_is_directory=True)
                    elif case in ['bin-link','lib-link']:(private/case.split('-')[0]).symlink_to(outside,target_is_directory=True)
                    elif case=='prefix-writable':private.chmod(0o777)
                    else:
                        (private/'bin').mkdir()
                        binary=private/'bin/pnpm'
                        if case=='executable-outside-link':
                            target=outside/'pnpm';target.write_text(script);target.chmod(0o700);binary.symlink_to(target)
                        else:binary.write_text(script);binary.chmod(0o777)
                    with self.assertRaises(installer.InstallError):
                        installer.ensure_pnpm(fixture.env.copy(),fixture.data,True)
                    self.assertFalse(marker.exists())
                    self.assertFalse((outside/'bin').exists())
                finally:fixture.close()

    def test_help_explains_safe_normal_chat_setup(self):
        result = subprocess.run([sys.executable, str(INSTALLER), '--help'],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--hermes-home', result.stdout)
        self.assertIn('--dry-run', result.stdout)
        self.assertIn('workers', result.stdout)
        self.assertIn('SQLite', result.stdout)
    def test_fresh_install_wires_real_mcp_and_preserves_other_settings(self):
        fixture=Fixture()
        try:
            result=fixture.run()
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            report=json.loads(result.stdout.strip().splitlines()[-1])
            self.assertTrue(report['ok'])
            self.assertEqual(report['verification']['toolCount'],5)
            self.assertTrue(report['verification']['memoryRoundTrip'])
            config=json.loads(fixture.config.read_text())
            self.assertEqual(config['model'],fixture.initial['model'])
            self.assertEqual(config['mcp_servers']['unrelated'],fixture.initial['mcp_servers']['unrelated'])
            self.assertEqual(fixture.credentials.read_text(),'SYNTHETIC_TEST_SECRET=dummy-fixture-only\n')
            server=config['mcp_servers']['zouroboros']
            self.assertEqual(server['env']['HERMES_ZOUROBOROS_ALLOW_SWARM'],'0')
            self.assertFalse(server['sampling']['enabled'])
            self.assertEqual(server['env']['HERMES_ZOUROBOROS_HOME'],str(fixture.data))
            self.assertEqual((fixture.data/'memory.db').stat().st_mode & 0o777,0o600)
            self.assertFalse(report['verification']['status']['swarmExecution'])
            commands=[json.loads(line) for line in fixture.log.read_text().splitlines()]
            self.assertTrue(all(command['home']==str(fixture.home) for command in commands))
            self.assertFalse(any(command['args'][0] in ('chat','setup','gateway') for command in commands))
        finally:fixture.close()
    def test_missing_pnpm_bootstraps_source_pin_privately(self):
        fixture=Fixture()
        try:
            fixture.limited_tools()
            result=fixture.run(build=True)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertTrue((fixture.data/'tools/pnpm-8.15.0/bin/pnpm').is_file())
            self.assertFalse((fixture.root/'.local/bin/pnpm').exists())
        finally:fixture.close()
    def test_second_install_preserves_config_registry_and_fact_count(self):
        fixture=Fixture()
        try:
            self.assertEqual(fixture.run().returncode,0)
            before=fixture.config.read_bytes();registry=(fixture.data/'executors.json').read_bytes()
            with sqlite3.connect(fixture.data/'memory.db') as db:count=db.execute('SELECT COUNT(*) FROM facts').fetchone()[0]
            result=fixture.run()
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertEqual(fixture.config.read_bytes(),before)
            self.assertEqual((fixture.data/'executors.json').read_bytes(),registry)
            with sqlite3.connect(fixture.data/'memory.db') as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM facts').fetchone()[0],count)
        finally:fixture.close()

    def test_expired_receipt_retries_preserve_id_and_unrelated_fact_retention(self):
        fixture=Fixture()
        try:
            first=fixture.run()
            self.assertEqual(first.returncode,0,first.stdout+first.stderr)
            # Exercise ordinary memory_store through the actual shared MCP server,
            # not a hand-crafted approximation of its default retention.
            script = '''import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const config=JSON.parse(await Bun.file(process.argv[1]).text());
const server=config.mcp_servers.zouroboros;
const client=new Client({name:'installer-retention-test',version:'1'});
try {
  await client.connect(new StdioClientTransport({command:server.command,args:server.args,env:{...process.env,...server.env},stderr:'pipe'}));
  const result=await client.callTool({name:'memory_store',arguments:{entity:'ordinary-fixture',key:'decision',value:'Keep copper widgets'}});
  if(result.isError) throw new Error('ordinary fact store failed');
} finally { await client.close(); }
'''
            stored=subprocess.run([shutil.which('bun'),'-e',script,str(fixture.config)],
                                  cwd=ROOT,env=fixture.env,capture_output=True,text=True,timeout=10)
            self.assertEqual(stored.returncode,0,stored.stdout+stored.stderr)
            with closing(sqlite3.connect(fixture.data/'memory.db')) as db, db:
                db.row_factory=sqlite3.Row
                original=[dict(row) for row in db.execute('SELECT * FROM facts ORDER BY id')]
            receipt=next(row for row in original if row['entity']=='hermes-zouroboros-installation')
            ordinary=next(row for row in original if row['entity']=='ordinary-fixture')
            self.assertEqual(ordinary['decay_class'],'medium')
            self.assertEqual(ordinary['expires_at']-ordinary['created_at'],90*24*3600)
            config=fixture.config.read_bytes()
            for retry in range(2):
                with self.subTest(retry=retry):
                    # Simulate the legacy medium receipt's expiration each time.
                    with closing(sqlite3.connect(fixture.data/'memory.db')) as db, db:
                        db.execute("UPDATE facts SET decay_class='medium', expires_at=1 WHERE id=?",(receipt['id'],))
                        before_check=db.execute('SELECT * FROM facts ORDER BY id').fetchall()
                    checked=fixture.run('--check')
                    self.assertEqual(checked.returncode,0,checked.stdout+checked.stderr)
                    with closing(sqlite3.connect(fixture.data/'memory.db')) as db, db:
                        self.assertEqual(db.execute('SELECT * FROM facts ORDER BY id').fetchall(),before_check)
                    result=fixture.run()
                    self.assertEqual(result.returncode,0,result.stdout+result.stderr)
                    self.assertTrue(json.loads(result.stdout.strip().splitlines()[-1])['verification']['memoryRoundTrip'])
                    with closing(sqlite3.connect(fixture.data/'memory.db')) as db, db:
                        db.row_factory=sqlite3.Row
                        after=[dict(row) for row in db.execute('SELECT * FROM facts ORDER BY id')]
                    self.assertEqual(len(after),len(original),'expired receipt retry accumulated another fact')
                    expected_receipt={**receipt,'decay_class':'permanent','expires_at':None}
                    self.assertEqual(next(row for row in after if row['id']==receipt['id']),expected_receipt)
                    self.assertEqual(next(row for row in after if row['id']==ordinary['id']),ordinary)
                    self.assertEqual(fixture.config.read_bytes(),config)
        finally:fixture.close()

    def test_historical_receipts_reuse_stable_id_and_preserve_duplicates_and_lookalikes(self):
        fixture=Fixture()
        try:
            first=fixture.run()
            self.assertEqual(first.returncode,0,first.stdout+first.stderr)
            with closing(sqlite3.connect(fixture.data/'memory.db')) as db, db:
                db.row_factory=sqlite3.Row
                receipt=dict(db.execute('SELECT * FROM facts').fetchone())
                # Historical exact duplicate plus an older user-owned lookalike.
                duplicate={**receipt,'id':'fixture-historical-duplicate','created_at':receipt['created_at']+1,
                           'decay_class':'medium','expires_at':1}
                # Each six-field identity discriminator must independently
                # protect an older lookalike from receipt recovery.
                lookalikes=[{**receipt,'id':'fixture-lookalike-'+field,field:value,
                             'created_at':receipt['created_at']-1,'decay_class':'short','expires_at':1}
                            for field,value in [('source','manual'),('persona','operator'),('category','decision')]]
                for row in [duplicate,*lookalikes]:
                    columns=','.join(row)
                    db.execute('INSERT INTO facts ('+columns+') VALUES ('+','.join('?' for _ in row)+')',tuple(row.values()))
            for retry in range(2):
                with self.subTest(retry=retry):
                    with closing(sqlite3.connect(fixture.data/'memory.db')) as db, db:
                        db.execute("UPDATE facts SET decay_class='medium', expires_at=1 WHERE id=?",(receipt['id'],))
                    result=fixture.run()
                    self.assertEqual(result.returncode,0,result.stdout+result.stderr)
                    verification=json.loads(result.stdout.strip().splitlines()[-1])['verification']
                    self.assertTrue(verification['memoryRoundTrip'])
                    self.assertEqual(verification['installerReceipt'],{'id':receipt['id'],'matchingRecords':2,'decay':'permanent'})
                    with closing(sqlite3.connect(fixture.data/'memory.db')) as db, db:
                        db.row_factory=sqlite3.Row
                        rows={row['id']:dict(row) for row in db.execute('SELECT * FROM facts')}
                    self.assertEqual(len(rows),5)
                    self.assertEqual(rows[receipt['id']],receipt)
                    self.assertEqual(rows[duplicate['id']],duplicate)
                    for lookalike in lookalikes:self.assertEqual(rows[lookalike['id']],lookalike)
        finally:fixture.close()

    def assert_crowded_receipt_recovery(self,fixture,kind):
        first=fixture.run()
        self.assertEqual(first.returncode,0,first.stdout+first.stderr)
        def rows():
            with closing(sqlite3.connect(fixture.data/'memory.db')) as db:
                db.row_factory=sqlite3.Row
                return {row['id']:dict(row) for row in db.execute('SELECT * FROM facts ORDER BY id')}
        receipt=next(iter(rows().values()))
        if kind=='ordinary':
            stored=fixture.memory_calls([{'name':'memory_store','arguments':{
                'entity':'ordinary-matching-'+str(i),'key':'decision','value':receipt['value']+' ordinary '+str(i)}} for i in range(30)])
            self.assertEqual(len({row['id'] for row in stored}),30)
            # Make the original deterministically older; do not change ordinary
            # MCP-created timestamps, payloads, importance, or default lifetimes.
            with closing(sqlite3.connect(fixture.data/'memory.db')) as db, db:
                oldest=db.execute('SELECT MIN(created_at) FROM facts WHERE id != ?',(receipt['id'],)).fetchone()[0]
                db.execute('UPDATE facts SET created_at = ? WHERE id = ?',(oldest-1,receipt['id']))
            receipt=rows()[receipt['id']]
            for row in rows().values():
                if row['id']!=receipt['id']:
                    self.assertEqual(row['decay_class'],'medium')
                    self.assertEqual(row['expires_at']-row['created_at'],90*24*3600)
        else:
            with closing(sqlite3.connect(fixture.data/'memory.db')) as db, db:
                for i in range(30):
                    duplicate={**receipt,'id':'fixture-newer-duplicate-'+str(i),'created_at':receipt['created_at']+i+1,
                               'decay_class':'medium','expires_at':receipt['created_at']+90*24*3600}
                    db.execute('INSERT INTO facts ('+','.join(duplicate)+') VALUES ('+','.join('?' for _ in duplicate)+')',tuple(duplicate.values()))
        originals=rows()
        self.assertEqual(len(originals),31)
        # A bounded ordinary keyword search really hides the selected receipt.
        found=fixture.memory_calls([{'name':'memory_search','arguments':{'query':receipt['value'],'limit':30}}])[0]
        self.assertEqual(len(found),30)
        self.assertNotIn(receipt['id'],[row['id'] for row in found])
        preserved=[fixture.config,fixture.credentials,fixture.data/'executors.json',fixture.data/'settings.json',fixture.data/'hermes/config.yaml']
        contents={path:path.read_bytes() for path in preserved}
        for retry in range(2):
            with self.subTest(kind=kind,retry=retry):
                with closing(sqlite3.connect(fixture.data/'memory.db')) as db, db:
                    db.execute("UPDATE facts SET decay_class='medium', expires_at=1 WHERE id=?",(receipt['id'],))
                before_check=rows()
                checked=fixture.run('--check')
                self.assertEqual(checked.returncode,0,checked.stdout+checked.stderr)
                self.assertIsNone(json.loads(checked.stdout.strip().splitlines()[-1])['verification']['memoryRoundTrip'])
                self.assertEqual(rows(),before_check)
                result=fixture.run()
                self.assertEqual(result.returncode,0,result.stdout+result.stderr)
                verification=json.loads(result.stdout.strip().splitlines()[-1])['verification']
                self.assertTrue(verification['memoryRoundTrip'])
                self.assertEqual(verification['installerReceipt'],{
                    'id':receipt['id'],'matchingRecords':31 if kind=='duplicates' else 1,'decay':'permanent'})
                self.assertEqual(rows(),originals,'crowded retry changed rows/count/payload/TTL beyond the chosen receipt lifecycle')
                for path,content in contents.items():self.assertEqual(path.read_bytes(),content)

    def test_thirty_newer_historical_duplicates_do_not_hide_selected_receipt(self):
        fixture=Fixture()
        try:self.assert_crowded_receipt_recovery(fixture,'duplicates')
        finally:fixture.close()

    def test_thirty_actual_mcp_stored_matches_do_not_hide_selected_receipt(self):
        fixture=Fixture()
        try:self.assert_crowded_receipt_recovery(fixture,'ordinary')
        finally:fixture.close()

    def test_dry_run_does_not_initialize_or_change_configuration(self):
        fixture=Fixture()
        try:
            before=fixture.config.read_bytes()
            fixture.limited_tools(npm_fail=True)
            result=fixture.run('--dry-run',build=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertTrue(json.loads(result.stdout)['dryRun'])
            self.assertFalse(fixture.data.exists());self.assertFalse(fixture.work.exists())
            self.assertEqual(fixture.config.read_bytes(),before)
            self.assertFalse((fixture.home/'.zouroboros-install.lock').exists())
        finally:fixture.close()

    def test_check_does_not_save_facts_or_change_configuration(self):
        fixture=Fixture()
        try:
            self.assertEqual(fixture.run().returncode,0)
            before=fixture.config.read_bytes()
            with sqlite3.connect(fixture.data/'memory.db') as db:rows=db.execute('SELECT * FROM facts').fetchall()
            result=fixture.run('--check')
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIsNone(json.loads(result.stdout)['verification']['memoryRoundTrip'])
            self.assertTrue(json.loads(result.stdout)['verification'].get('startupFilesystemWritesPossible'))
            self.assertEqual(fixture.config.read_bytes(),before)
            with sqlite3.connect(fixture.data/'memory.db') as db:self.assertEqual(db.execute('SELECT * FROM facts').fetchall(),rows)
        finally:fixture.close()

    def test_conflicting_connection_is_not_overwritten(self):
        fixture=Fixture()
        try:
            value=fixture.initial.copy();value['mcp_servers']=dict(value['mcp_servers'],zouroboros={'command':'operator-owned-command'})
            fixture.config.write_text(json.dumps(value));before=fixture.config.read_bytes()
            result=fixture.run()
            self.assertNotEqual(result.returncode,0);self.assertIn('conflicts',result.stderr)
            self.assertEqual(fixture.config.read_bytes(),before);self.assertFalse(fixture.data.exists())
        finally:fixture.close()

    def test_partial_workshop_is_not_reinitialized(self):
        fixture=Fixture()
        try:
            fixture.data.mkdir();marker=fixture.data/'settings.json';marker.write_text('{}')
            result=fixture.run()
            self.assertNotEqual(result.returncode,0);self.assertIn('incomplete',result.stderr)
            self.assertEqual(marker.read_text(),'{}');self.assertFalse((fixture.data/'hermes').exists())
        finally:fixture.close()

    def test_bootstrap_failure_preserves_profile(self):
        fixture=Fixture()
        try:
            fixture.limited_tools(npm_fail=True);before=fixture.config.read_bytes()
            result=fixture.run(build=True)
            self.assertNotEqual(result.returncode,0);self.assertIn('exit 42',result.stderr)
            self.assertEqual(fixture.config.read_bytes(),before);self.assertFalse((fixture.data/'settings.json').exists())
        finally:fixture.close()

    def test_wrong_existing_pnpm_version_is_not_replaced(self):
        fixture=Fixture()
        try:
            fixture.limited_tools(pnpm_version='9.0.0')
            result=fixture.run(build=True)
            self.assertNotEqual(result.returncode,0);self.assertIn('source pin 8.15.0',result.stderr)
            self.assertFalse(fixture.data.exists())
        finally:fixture.close()

    def test_symlink_database_is_rejected_before_any_initialization(self):
        fixture=Fixture()
        try:
            fixture.data.mkdir();outside=fixture.root/'outside.sqlite'
            with sqlite3.connect(outside) as db:db.execute('CREATE TABLE sentinel(value TEXT)')
            before=outside.read_bytes();(fixture.data/'memory.db').symlink_to(outside)
            result=fixture.run()
            self.assertNotEqual(result.returncode,0)
            self.assertFalse((fixture.data/'settings.json').exists())
            self.assertEqual(outside.read_bytes(),before)
        finally:fixture.close()
    def test_unsafe_state_hierarchy_and_sqlite_sidecars_fail_before_startup(self):
        for case in ['data-link', 'hermes-link', 'data-writable', 'hermes-writable',
                     'wal-link', 'shm-link', 'journal-link', 'wal-writable']:
            with self.subTest(case=case):
                fixture=Fixture()
                try:
                    outside=fixture.root/'outside';outside.mkdir()
                    sentinel=outside/'sentinel';sentinel.write_text('untouched')
                    fixture.data.mkdir(mode=0o700)
                    if case=='data-link':
                        fixture.data.rmdir();fixture.data.symlink_to(outside,target_is_directory=True)
                    elif case=='hermes-link':
                        (fixture.data/'hermes').symlink_to(outside,target_is_directory=True)
                    elif case.endswith('writable') and case.startswith(('data','hermes')):
                        target=fixture.data if case=='data-writable' else fixture.data/'hermes'
                        target.mkdir(exist_ok=True);target.chmod(0o777)
                    else:
                        suffix=case.split('-')[0]
                        target=fixture.data/('memory.db-'+suffix)
                        if case.endswith('link'):target.symlink_to(sentinel)
                        else:target.write_text('sidecar');target.chmod(0o666)
                    before=fixture.config.read_bytes()
                    result=fixture.run()
                    self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
                    self.assertEqual(fixture.config.read_bytes(),before)
                    self.assertEqual(sentinel.read_text(),'untouched')
                    self.assertFalse((outside/'config.yaml').exists())
                    self.assertFalse((fixture.data/'settings.json').exists())
                finally:fixture.close()

    def test_cancelled_zero_exit_add_does_not_create_partial_connection(self):
        fixture=Fixture()
        try:
            fixture.env['INSTALL_TEST_CANCEL_ADD']='1';before=fixture.config.read_bytes()
            result=fixture.run()
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(fixture.config.read_bytes(),before)
        finally:fixture.close()
    def test_shell_entrypoint_passes_arguments(self):
        result=subprocess.run(['bash',str(ROOT/'scripts/install.sh'),'--help'],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('--hermes-home',result.stdout)
    @unittest.skipUnless(os.environ.get('HERMES_ZOUROBOROS_TEST_REAL_HERMES')=='1','Explicit isolated real-Hermes qualification is opt-in')
    def test_real_hermes_cli_in_synthetic_profile(self):
        fixture=Fixture()
        try:
            fixture.env['PATH']=os.environ['PATH']
            result=fixture.run(build=os.environ.get('HERMES_ZOUROBOROS_TEST_BUILD')=='1')
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            report=json.loads(result.stdout.strip().splitlines()[-1]);self.assertTrue(report['verification']['memoryRoundTrip'])
            before=fixture.config.read_bytes()
            with closing(sqlite3.connect(fixture.data/'memory.db')) as db, db:
                receipt_id=db.execute('SELECT id FROM facts').fetchone()[0]
            for retry in range(2):
                with self.subTest(expired_retry=retry):
                    with closing(sqlite3.connect(fixture.data/'memory.db')) as db, db:
                        db.execute("UPDATE facts SET decay_class='medium', expires_at=1 WHERE id=?",(receipt_id,))
                    again=fixture.run();self.assertEqual(again.returncode,0,again.stdout+again.stderr)
                    self.assertTrue(json.loads(again.stdout.strip().splitlines()[-1])['verification']['memoryRoundTrip'])
                    with closing(sqlite3.connect(fixture.data/'memory.db')) as db, db:
                        self.assertEqual(db.execute('SELECT id,decay_class,expires_at FROM facts').fetchall(),[(receipt_id,'permanent',None)])
                    self.assertEqual(fixture.config.read_bytes(),before)
            check=fixture.run('--check');self.assertEqual(check.returncode,0,check.stdout+check.stderr)
            self.assertEqual(fixture.config.read_bytes(),before)
            with closing(sqlite3.connect(fixture.data/'memory.db')) as db, db:self.assertEqual(db.execute('SELECT COUNT(*) FROM facts').fetchone()[0],1)
            self.assertEqual(fixture.credentials.read_text(),'SYNTHETIC_TEST_SECRET=dummy-fixture-only\n')
            model=subprocess.run([shutil.which('hermes'),'config','get','model.default','--json'],env={**fixture.env,'HERMES_HOME':str(fixture.home)},capture_output=True,text=True,timeout=10)
            self.assertEqual(json.loads(model.stdout),'synthetic-test-model')
        finally:fixture.close()
        # Qualify both capped-search regressions with the real Hermes CLI as
        # well as the default fake CLI. Every profile/database remains scratch.
        for kind in ['duplicates','ordinary']:
            with self.subTest(real_hermes_crowding=kind):
                crowded=Fixture()
                try:
                    crowded.env['PATH']=os.environ['PATH']
                    self.assert_crowded_receipt_recovery(crowded,kind)
                finally:crowded.close()


if __name__ == '__main__':
    unittest.main()
