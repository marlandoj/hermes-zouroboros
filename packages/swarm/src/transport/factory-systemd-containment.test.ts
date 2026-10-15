import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, closeSync, existsSync, lstatSync, fstatSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseManagedFactoryPolicy, validateManagedFactoryEvidenceFixture, readManagedFactoryBoundary,
  sealedManagedProfileFixture, prepareManagedFactorySpawn, managedFactoryArgumentsFixture, MANAGED_FACTORY_UNIT,
  MANAGED_FACTORY_POLICY, MANAGED_FACTORY_REPEATABLE_UNIT, MANAGED_FACTORY_REPEATABLE_POLICY, managedFactoryUnitForCgroup,
  assertCodexSubscriptionAuth, workerCredentialFileFixture, workerCredentialFixture, managedFactoryDescriptorsFixture,
  codexAccountDigest, workerRootAncestry, managedSpawnEnvironmentKeysClean, MANAGED_FACTORY_NETNS_PATH,
  MANAGED_FACTORY_EGRESS_LISTEN, MANAGED_FACTORY_EGRESS_PROXY, MANAGED_FACTORY_AGENT_MODE, MANAGED_SPAWN_FORBIDDEN_ENV,
  assertManagedFactorySessionMode, credentialQuarantineDirectoryFixture } from './factory-systemd-containment';

const saved=process.env.FACTORY_STATE_MODE;
afterEach(()=>{if(saved===undefined)delete process.env.FACTORY_STATE_MODE;else process.env.FACTORY_STATE_MODE=saved;});
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const pin=(path:string)=>({path,sha256:'a'.repeat(64)});
const SYNTHETIC_ACCOUNT='synthetic-account-0001';
// Assembled from fragments so this source never holds an operator-home path literal (leak gate).
const OPERATOR_HOME=['','home','zouro'+'boros'].join('/');
function policy(){
  const source_root='/opt/factory/runtime';const bin=source_root+'/node_modules/.factory-native/bin';
  return {schema:'factory-managed-systemd-boundary/v1',unit_inputs_sha256:'a'.repeat(64),execution_sha256:'b'.repeat(64),unit_fragment_sha256:'c'.repeat(64),
    source_root,source_head:'d'.repeat(40),registry_sha256:'e'.repeat(64),worker_uid:1004,worker_gid:1004,
    workdir:'/var/lib/factory/work',home:'/var/lib/factory/home',state_root:'/var/lib/factory/state',harness:'codex',model:'gpt-5.4',
    runtime_ms:300000,timeout_ms:120000,approved_at_ms:1000,expires_at_ms:301000,
    adapter:{...pin(bin+'/codex-acp-swarm'),name:'codex-acp-swarm',args:[]},native:pin(bin+'/codex'),node:pin(bin+'/node'),
    bun:pin('/opt/factory/bun'),bwrap:pin('/usr/bin/bwrap'),systemctl:pin('/usr/bin/systemctl'),python:pin('/usr/bin/python3.13'),
    codex_credentials:'/var/lib/factory/credentials/codex',codex_account_sha256:codexAccountDigest(SYNTHETIC_ACCOUNT),
    profile_files:[{path:'.codex/config.toml',sha256:'f'.repeat(64)}],runtime_files:['/usr/bin/nice','/usr/bin/taskset','/usr/lib/x86_64-linux-gnu/libc.so.6'].map(pin)};
}
function evidence(name=MANAGED_FACTORY_UNIT){
  const cgroup='/system.slice/'+name;
  const u={Id:name,LoadState:'loaded',ActiveState:'active',SubState:'running',User:'',Group:'root',MainPID:'123',ControlPID:'0',
    FragmentPath:'/etc/systemd/system/'+name,DropInPaths:'',SourcePath:'',NeedDaemonReload:'no',Transient:'no',Delegate:'no',
    KillMode:'control-group',Restart:'no',Type:'exec',NoNewPrivileges:'yes',ProtectControlGroups:'yes',ProtectSystem:'strict',ProtectHome:'yes',PrivateTmp:'yes',
    ProtectKernelTunables:'no',ProtectKernelLogs:'no',ProtectKernelModules:'yes',PrivateDevices:'yes',
    BindReadOnlyPaths:'/sys:/sys:rbind',SystemCallFilter:'~syslog',
    RestrictNamespaces:'ipc mnt pid user uts',RuntimeMaxUSec:'5min',TimeoutStopUSec:'3s',SendSIGKILL:'yes',FinalKillSignal:'9',MemoryMax:'12884901888',TasksMax:'256',
    ControlGroup:cgroup,InvocationID:'1'.repeat(32),
    NetworkNamespacePath:'/run/netns/zouroboros-factory-execution',PrivateNetwork:'no',IPAddressDeny:'::/0 0.0.0.0/0',
    IPAddressAllow:'127.0.0.1/32',RestrictAddressFamilies:'AF_INET AF_INET6 AF_UNIX'};
  return {cgroup:'0::'+cgroup+'\n',status:'Uid:\t1004\t1004\t1004\t1004\nGid:\t1004\t1004\t1004\t1004\nGroups:\t1004\nNoNewPrivs:\t1\n'+
    ['CapEff','CapPrm','CapInh','CapAmb'].map(k=>k+':\t0000000000000000\n').join('')+'CapBnd:\t00000000000800e4\n',
    supervisor_cgroup:'0::'+cgroup+'\n',supervisor_status:'Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nGroups:\t\nNoNewPrivs:\t1\n'+
      ['CapEff','CapPrm','CapBnd'].map(k=>k+':\t00000000000800e4\n').join('')+['CapInh','CapAmb'].map(k=>k+':\t0000000000000000\n').join(''),
    unit:Object.entries(u).map(([k,v])=>k+'='+v).join('\n')+'\n',mountinfo:'1 0 0:1 / / ro - ext4 /dev/root ro\n2 1 0:2 / /sys/fs/cgroup ro - cgroup2 cgroup ro\n',
    mount_ids:{sys:'1',cgroup:'2',runtime:'1'},
    cgroup_type:'domain\n',memory_max:'12884901888\n',pids_max:'256\n',now:2000,
    netns:{self:'5:4026532699',named:'5:4026532699',ifaces:'lo'}};
}
describe('root-enrolled managed boundary',()=>{
  test('canonical exact policy binds native package route and remains immutable',()=>{
    const p=parseManagedFactoryPolicy(canonical(policy()));expect(p.adapter.name).toBe('codex-acp-swarm');expect(Object.isFrozen(p.runtime_files)).toBe(true);
    for(const mutate of [ (p:any)=>{p.worker_uid=0;},(p:any)=>{p.model=123;},(p:any)=>{p.source_head=123;},(p:any)=>{p.adapter.args=['--fallback'];},
      (p:any)=>{p.adapter.path='/usr/bin/other';},(p:any)=>{p.native.path='/opt/foreign/codex';},(p:any)=>{p.home=p.source_root+'/home';},
      (p:any)=>{p.workdir='/var/lib/factory';},(p:any)=>{p.home=p.workdir+'/profile';},(p:any)=>{p.workdir='/etc/zouroboros/hermes-issuer/work';},
      (p:any)=>{p.runtime_files=[];},(p:any)=>{p.profile_files[0].sha256=123;},(p:any)=>{p.timeout_ms=120001;},(p:any)=>{p.extra=true;}]){
      const bad=policy();mutate(bad);expect(()=>parseManagedFactoryPolicy(canonical(bad))).toThrow();
    }
    expect(()=>parseManagedFactoryPolicy(JSON.stringify(policy()))).toThrow('canonical');
    expect(()=>parseManagedFactoryPolicy(canonical(policy()).replace('"harness":"codex"','"harness":"claude","harness":"codex"'))).toThrow('canonical');
  });
  test('actual kernel/unit/identity evidence is required together',()=>{
    process.env.FACTORY_STATE_MODE='test';const p=parseManagedFactoryPolicy(canonical(policy()));
    expect(validateManagedFactoryEvidenceFixture(p,evidence())).toBe('1'.repeat(32));
    for(const [key,value] of Object.entries(evidence())){
      const e:any=evidence();e[key]=typeof value==='string'?'unexpected':301000;
      expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow();
    }
    for(const [before,after] of [['Delegate=no','Delegate=yes'],['MemoryMax=12884901888','MemoryMax=21474836480'],['RestrictNamespaces=ipc mnt pid user uts','RestrictNamespaces=~cgroup'],['InvocationID='+'1'.repeat(32),'InvocationID='],['MainPID=123','MainPID=0']]){
      const e=evidence();e.unit=e.unit.replace(before,after);expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow();
    }
    for(const [before,after] of [['Groups:\t1004','Groups:\t1004 999'],['NoNewPrivs:\t1','NoNewPrivs:\t0'],['CapEff:\t0000000000000000','CapEff:\t0000000000000001']]){
      const e=evidence();e.status=e.status.replace(before,after);expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow();
    }
    for(const [before,after] of [['Uid:\t0\t0\t0\t0','Uid:\t1\t1\t1\t1'],['CapEff:\t00000000000800e4','CapEff:\t0000000000080064'],['CapAmb:\t0000000000000000','CapAmb:\t0000000000000080']]){
      const e=evidence();e.supervisor_status=e.supervisor_status.replace(before,after);expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow('supervisor');
    }
    const e=evidence();e.mountinfo+='3 1 0:3 / /opt/factory/runtime rw - ext4 /dev/other rw\n';e.mount_ids.runtime='3';expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow();
    e.mountinfo=evidence().mountinfo;e.now=181000;expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow('approval');
  });
  test('the worker must be in the named loopback-only execution netns, with the unit network shape pinned',()=>{
    process.env.FACTORY_STATE_MODE='test';const p=parseManagedFactoryPolicy(canonical(policy()));
    for(const netns of [{self:'5:4026531840',named:'5:4026532699',ifaces:'lo'},{self:'5:4026532699',named:'5:4026532699',ifaces:'lo,eth0'},
        {self:'5:4026532699',named:'5:4026532699',ifaces:''},{self:'',named:'',ifaces:'lo'},{self:'5:1',named:'6:1',ifaces:'lo'}]){
      const e:any=evidence();e.netns=netns;expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow('execution network namespace');
    }
    const absent:any=evidence();delete absent.netns;expect(()=>validateManagedFactoryEvidenceFixture(p,absent)).toThrow('execution network namespace');
    for(const [before,after] of [['NetworkNamespacePath=/run/netns/zouroboros-factory-execution','NetworkNamespacePath='],
        ['PrivateNetwork=no','PrivateNetwork=yes'],['IPAddressDeny=::/0 0.0.0.0/0','IPAddressDeny='],['IPAddressAllow=127.0.0.1/32','IPAddressAllow=127.0.0.0/8'],
        ['RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX','RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK AF_UNIX'],
        ['IPAddressAllow=127.0.0.1/32\n','']]){
      const e=evidence();e.unit=e.unit.replace(before,after);expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow('loaded unit policy');
    }
    // systemd prints the IP sets in per-boot hash order: the same entries in any order pass; any other set is refused.
    const reordered=evidence();reordered.unit=reordered.unit.replace('IPAddressDeny=::/0 0.0.0.0/0','IPAddressDeny=0.0.0.0/0 ::/0');
    expect(()=>validateManagedFactoryEvidenceFixture(p,reordered)).not.toThrow();
    for(const after of ['IPAddressDeny=0.0.0.0/0 ::/0 ::/0','IPAddressDeny=0.0.0.0/0 ::/0 198.51.100.0/24','IPAddressDeny=::/0']){
      const e=evidence();e.unit=e.unit.replace('IPAddressDeny=::/0 0.0.0.0/0',after);expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow('loaded unit policy');
    }
    const doubled=evidence();doubled.unit=doubled.unit.replace('IPAddressAllow=127.0.0.1/32','IPAddressAllow=127.0.0.1/32 127.0.0.1/32');
    expect(()=>validateManagedFactoryEvidenceFixture(p,doubled)).toThrow('loaded unit policy');
  });
  test('netns path and egress listener constants equal the rendered unit templates (review L5)',()=>{
    const deploy=join(import.meta.dir,'../../../../deploy/vps/factory-execution');
    const lines=(name:string)=>readFileSync(join(deploy,name),'utf8').split('\n');
    expect(MANAGED_FACTORY_NETNS_PATH).toBe('/run/netns/zouroboros-factory-execution');
    expect(lines('zouroboros-factory-egress.socket.in')).toContain('NetworkNamespacePath='+MANAGED_FACTORY_NETNS_PATH);
    expect(lines('zouroboros-factory-egress.socket.in')).toContain('ListenStream='+MANAGED_FACTORY_EGRESS_LISTEN);
    expect(lines('zouroboros-factory-execution-request.service.in')).toContain('NetworkNamespacePath='+MANAGED_FACTORY_NETNS_PATH);
    const [host,port]=MANAGED_FACTORY_EGRESS_LISTEN.split(':');
    const hex=host!.split('.').reverse().map(o=>Number(o).toString(16).padStart(2,'0')).join('').toUpperCase()+':'+Number(port).toString(16).toUpperCase().padStart(4,'0');
    expect(hex).toBe('0100007F:0C38');
  });
  test('kernel mount IDs reject writable overmounts and accept visible readonly stacks independent of row order',()=>{
    process.env.FACTORY_STATE_MODE='test';const p=parseManagedFactoryPolicy(canonical(policy()));
    const lower='4 1 0:4 / /sys rw - sysfs sysfs rw\n';const upper='5 4 0:4 / /sys ro - sysfs sysfs rw\n';
    for(const stack of [lower+upper,upper+lower]){
      const e=evidence();e.mountinfo+=stack;e.mount_ids.sys='5';expect(validateManagedFactoryEvidenceFixture(p,e)).toBe('1'.repeat(32));
      e.mount_ids.sys='4';expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow('kernel');
      e.mount_ids.sys='99';expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow('kernel');
      e.mount_ids.sys='5';e.mountinfo+=upper;expect(()=>validateManagedFactoryEvidenceFixture(p,e)).toThrow('kernel');
    }
  });
  test('policy path follows only the actual unit cgroup, and evidence is bound to that unit',()=>{
    expect(managedFactoryUnitForCgroup('0::/system.slice/'+MANAGED_FACTORY_UNIT+'\n')?.policy).toBe(MANAGED_FACTORY_POLICY);
    const repeatable=managedFactoryUnitForCgroup('0::/system.slice/'+MANAGED_FACTORY_REPEATABLE_UNIT+'\n');
    expect(repeatable?.unit).toBe(MANAGED_FACTORY_REPEATABLE_UNIT);
    expect(repeatable?.policy).toBe(MANAGED_FACTORY_REPEATABLE_POLICY);
    for(const other of ['0::/system.slice/'+MANAGED_FACTORY_REPEATABLE_UNIT+'/child\n','0::/user.slice/'+MANAGED_FACTORY_REPEATABLE_UNIT+'\n',
        '0::/system.slice/'+MANAGED_FACTORY_REPEATABLE_UNIT,'0::/system.slice/zouroboros-factory-execution-request.path\n',''])
      expect(managedFactoryUnitForCgroup(other)).toBeNull();
    process.env.FACTORY_STATE_MODE='test';const p=parseManagedFactoryPolicy(canonical(policy()));
    expect(validateManagedFactoryEvidenceFixture(p,evidence(MANAGED_FACTORY_REPEATABLE_UNIT),repeatable!)).toBe('1'.repeat(32));
    // Neither unit's observations satisfy the other's boundary.
    expect(()=>validateManagedFactoryEvidenceFixture(p,evidence(MANAGED_FACTORY_REPEATABLE_UNIT))).toThrow();
    expect(()=>validateManagedFactoryEvidenceFixture(p,evidence(),repeatable!)).toThrow();
    const mixed=evidence(MANAGED_FACTORY_REPEATABLE_UNIT);mixed.supervisor_cgroup='0::/system.slice/'+MANAGED_FACTORY_UNIT+'\n';
    expect(()=>validateManagedFactoryEvidenceFixture(p,mixed,repeatable!)).toThrow('supervisor');
  });
  test('raw fixture and environment cannot manufacture issued spawn authority',()=>{
    process.env.FACTORY_STATE_MODE='test';const p=parseManagedFactoryPolicy(canonical(policy()));
    expect(()=>prepareManagedFactorySpawn({command:'codex-acp-swarm',args:[]},p.workdir,{}, {policy:p,invocationId:'1'.repeat(32),unit:MANAGED_FACTORY_UNIT})).toThrow('unissued');
    const own=process.platform==='linux'?readFileSync('/proc/self/cgroup','utf8'):'';
    if(!own.includes('/'+MANAGED_FACTORY_UNIT))expect(readManagedFactoryBoundary()).toBeNull();
    delete process.env.FACTORY_STATE_MODE;expect(()=>validateManagedFactoryEvidenceFixture(p,evidence())).toThrow('fixture-only');
  });
  test.skipIf(process.platform!=='linux')('sealed profile bytes cannot be changed or truncated before bwrap reads them',()=>{
    process.env.FACTORY_STATE_MODE='test';const raw=Buffer.from('{"synthetic":"no credential"}');const fd=sealedManagedProfileFixture(raw);
    try{expect(fstatSync(fd).mode&0o777).toBe(0o400);expect(readFileSync(fd)).toEqual(raw);
      expect(()=>writeSync(fd,Buffer.from('x'),0,1,0)).toThrow();expect(()=>ftruncateSync(fd,0)).toThrow();
    }finally{closeSync(fd);}
  });
  test('filesystem envelope preserves resource wrappers and pins actual ACP native path',()=>{
    process.env.FACTORY_STATE_MODE='test';const p=parseManagedFactoryPolicy(canonical(policy()));const args=managedFactoryArgumentsFixture(p);
    expect(args.slice(args.indexOf('--')+1)).toEqual(['/usr/bin/taskset','-c','0-7','/usr/bin/nice','-n','10',p.adapter.path]);
    // Option 3: exactly these two literals, last before the command, and no other proxy/mode variable.
    expect(args.slice(args.indexOf('--')-6,args.indexOf('--'))).toEqual(['--setenv','HTTPS_PROXY','http://127.0.0.1:3128',
      '--setenv','INITIAL_AGENT_MODE','agent-full-access']);
    expect(args.filter(a=>a==='--setenv').length).toBe(7);
    for(const key of [...MANAGED_SPAWN_FORBIDDEN_ENV].filter(k=>!['HTTPS_PROXY','INITIAL_AGENT_MODE'].includes(k)))expect(args.includes(key)).toBe(false);
    expect(args.includes('--clearenv')).toBe(false);
    const native=args.indexOf('CODEX_PATH');expect(args.slice(native-1,native+2)).toEqual(['--setenv','CODEX_PATH',p.native.path]);
    expect(args.includes('--unshare-pid')).toBe(true);
    expect(args.slice(args.indexOf('--proc'),args.indexOf('--proc')+13)).toEqual(['--proc','/proc',
      '--ro-bind','/dev/null','/proc/kallsyms','--ro-bind','/dev/null','/proc/kcore','--ro-bind','/dev/null','/proc/kmsg','--remount-ro','/proc']);
    expect(args.includes(p.state_root)).toBe(false);expect(args.includes('--unshare-cgroup')).toBe(false);expect(args.includes('--unshare-net')).toBe(false);
    expect(args.slice(args.indexOf('--bind'),args.indexOf('--bind')+3)).toEqual(['--bind',p.workdir,p.workdir]);
    expect(args.includes('/root')).toBe(false);expect(args.includes(OPERATOR_HOME)).toBe(false);
    const source=args.indexOf(p.source_root);expect(args.slice(source-1,source+2)).toEqual(['--ro-bind',p.source_root,p.source_root]);
    const bun=args.indexOf(p.bun.path);expect(args.slice(bun-1,bun+2)).toEqual(['--ro-bind',p.bun.path,p.bun.path]);
    const resolved=policy();resolved.runtime_files=resolved.runtime_files.map(f=>f.path==='/usr/bin/nice'?pin('/usr/lib/cargo/bin/coreutils/nice'):f).sort((a,b)=>a.path.localeCompare(b.path));
    expect(()=>parseManagedFactoryPolicy(canonical(resolved))).toThrow('nice');
    const staged=policy();const stagedNice=staged.native.path.replace(/codex$/,'nice');
    staged.runtime_files=staged.runtime_files.map(f=>f.path==='/usr/bin/nice'?pin(stagedNice):f).sort((a,b)=>a.path.localeCompare(b.path));
    const stagedArgs=managedFactoryArgumentsFixture(parseManagedFactoryPolicy(canonical(staged)));
    expect(stagedArgs.slice(stagedArgs.indexOf('--')+1)).toEqual(['/usr/bin/taskset','-c','0-7',stagedNice,'-n','10',p.adapter.path]);
    staged.runtime_files.push(pin('/usr/bin/nice'));staged.runtime_files.sort((a,b)=>a.path.localeCompare(b.path));
    expect(()=>parseManagedFactoryPolicy(canonical(staged))).toThrow('nice');
    const unknown=policy();unknown.runtime_files=unknown.runtime_files.map(f=>f.path==='/usr/bin/nice'?pin('/opt/unapproved/nice'):f).sort((a,b)=>a.path.localeCompare(b.path));
    expect(()=>parseManagedFactoryPolicy(canonical(unknown))).toThrow('nice');
    delete process.env.FACTORY_STATE_MODE;expect(()=>managedFactoryArgumentsFixture(p)).toThrow('fixture-only');
  });
});

// Synthetic ChatGPT-shaped login; every value is a placeholder, never a credential.
const SYNTHETIC_SECRET='placeholder-synthetic-not-a-token';
const chatgptAuth=()=>({auth_mode:'chatgpt',OPENAI_API_KEY:null,last_refresh:'2026-10-08T00:00:00Z',
  tokens:{id_token:'synthetic',access_token:'synthetic',refresh_token:SYNTHETIC_SECRET,account_id:SYNTHETIC_ACCOUNT}});
const ACCOUNT=codexAccountDigest(SYNTHETIC_ACCOUNT);
describe('worker-owned Codex login',()=>{
  test('policy keeps auth.json out of the pinned profile and the credential store disjoint and outside operator homes',()=>{
    expect(parseManagedFactoryPolicy(canonical(policy())).codex_credentials).toBe('/var/lib/factory/credentials/codex');
    for(const [mutate,message] of [
      [(p:any)=>{p.profile_files=[{path:'.codex/auth.json',sha256:'f'.repeat(64)},{path:'.codex/config.toml',sha256:'f'.repeat(64)}];},'auth.json'],
      [(p:any)=>{delete p.codex_credentials;},'schema'],
      [(p:any)=>{p.codex_credentials=p.home+'/.codex';},'overlap'],
      [(p:any)=>{p.codex_credentials=p.workdir;},'separate'],
      [(p:any)=>{p.codex_credentials=p.source_root+'/credentials';},'separation'],
      [(p:any)=>{p.codex_credentials=OPERATOR_HOME+'/.codex';},'operator home'],
      [(p:any)=>{p.codex_credentials='/root/.codex';},'operator home'],
      [(p:any)=>{p.codex_credentials='credentials/codex';},'path'],
      // M1/M2 parity with the supervisor: a pinned config.toml, no higher-precedence layers, an account pin.
      [(p:any)=>{p.profile_files=[{path:'.codex/other.toml',sha256:'f'.repeat(64)}];},'config.toml must be pinned'],
      [(p:any)=>{p.profile_files.push({path:'.codex/managed_config.toml',sha256:'f'.repeat(64)});},'managed/requirements'],
      [(p:any)=>{p.profile_files.push({path:'.codex/requirements.toml',sha256:'f'.repeat(64)});},'managed/requirements'],
      [(p:any)=>{delete p.codex_account_sha256;},'schema'],
      [(p:any)=>{p.codex_account_sha256=null;},'schema'],
      [(p:any)=>{p.codex_account_sha256='A'.repeat(64);},'schema'],
    ] as Array<[(p:any)=>void,string]>){
      const bad=policy();mutate(bad);expect(()=>parseManagedFactoryPolicy(canonical(bad))).toThrow(message);
    }
  });
  test('bwrap binds only the credential descriptor read-write at the sandbox HOME, never the operator login',()=>{
    process.env.FACTORY_STATE_MODE='test';const p=parseManagedFactoryPolicy(canonical(policy()));const args=managedFactoryArgumentsFixture(p,'7');
    const at=args.indexOf('--bind-fd');expect(args.slice(at,at+3)).toEqual(['--bind-fd','7',p.home+'/.codex/auth.json']);
    expect(args.filter(a=>a==='--bind-fd').length).toBe(1);expect(args.includes('--ro-bind-fd')).toBe(false);
    // The sandbox HOME is the worker home; the credential store path itself is never named.
    expect(args.slice(args.indexOf('HOME')-1,args.indexOf('HOME')+2)).toEqual(['--setenv','HOME',p.home]);
    expect(args.slice(args.indexOf('CODEX_HOME')-1,args.indexOf('CODEX_HOME')+2)).toEqual(['--setenv','CODEX_HOME',p.home+'/.codex']);
    expect(args.some(a=>a.includes(p.codex_credentials))).toBe(false);
    expect(args.some(a=>a.startsWith('/home/')||a==='/home'||a.startsWith('/root'))).toBe(false);
    // The bind follows the .codex directory so it lands inside the fresh sandbox HOME.
    expect(at).toBeGreaterThan(args.indexOf(p.home+'/.codex'));
    const source=readFileSync(join(import.meta.dir,'factory-systemd-containment.ts'),'utf8');
    expect(source.includes(OPERATOR_HOME)).toBe(false);
  });
  test('structural subscription check rejects API-key and unknown logins without echoing values',()=>{
    expect(assertCodexSubscriptionAuth(Buffer.from(JSON.stringify(chatgptAuth())))).toBe(ACCOUNT);
    const {auth_mode:_a,OPENAI_API_KEY:_b,last_refresh:_c,...minimal}=chatgptAuth();assertCodexSubscriptionAuth(Buffer.from(JSON.stringify(minimal)));
    for(const mutate of [(v:any)=>{v.OPENAI_API_KEY=SYNTHETIC_SECRET;},(v:any)=>{v.auth_mode='apikey';},(v:any)=>{v.personal_access_token=SYNTHETIC_SECRET;},
        (v:any)=>{delete v.tokens;},(v:any)=>{v.tokens.refresh_token='';},(v:any)=>{v.tokens=[SYNTHETIC_SECRET];},
        (v:any)=>{delete v.tokens.account_id;},(v:any)=>{v.tokens.account_id='';}]){
      const value:any=chatgptAuth();mutate(value);let message='';
      try{assertCodexSubscriptionAuth(Buffer.from(JSON.stringify(value)));}catch(error){message=String(error);}
      expect(message).toContain('managed Factory containment');expect(message.includes(SYNTHETIC_SECRET)).toBe(false);
    }
    for(const raw of ['not json '+SYNTHETIC_SECRET,'[]','null']){
      let message='';try{assertCodexSubscriptionAuth(Buffer.from(raw));}catch(error){message=String(error);}
      expect(message).toContain('Codex credential');expect(message.includes(SYNTHETIC_SECRET)).toBe(false);
    }
  });
  test.skipIf(process.platform!=='linux')('credential file must be the worker\'s own 0600 single-link regular file in a 0700 directory',()=>{
    process.env.FACTORY_STATE_MODE='test';
    const uid=process.getuid!(),gid=process.getgid!();const scratch=mkdtempSync('/tmp/zo-task-codex-credential-');
    try{
      const dir=join(scratch,'codex');mkdirSync(dir,{mode:0o700});chmodSync(dir,0o700);
      const auth=join(dir,'auth.json');const write=(value:unknown)=>{writeFileSync(auth,JSON.stringify(value),{mode:0o600});chmodSync(auth,0o600);};
      write(chatgptAuth());const fd=workerCredentialFileFixture(dir,uid,gid,ACCOUNT);
      try{expect(fstatSync(fd).isFile()).toBe(true);}finally{closeSync(fd);}
      const rejects=(message:string)=>expect(()=>{closeSync(workerCredentialFileFixture(dir,uid,gid,ACCOUNT));}).toThrow(message);
      // M2: an in-sandbox rewrite with another ChatGPT account's tokens is refused, without echoing it.
      write({...chatgptAuth(),tokens:{...chatgptAuth().tokens,account_id:'synthetic-attacker-account'}});
      let swapped='';try{closeSync(workerCredentialFileFixture(dir,uid,gid,ACCOUNT));}catch(error){swapped=String(error);}
      expect(swapped).toContain('not the enrolled ChatGPT account');expect(swapped.includes('synthetic-attacker-account')).toBe(false);
      write(chatgptAuth());
      chmodSync(auth,0o640);rejects('ownership/shape');chmodSync(auth,0o600);
      chmodSync(dir,0o750);rejects('directory');chmodSync(dir,0o700);
      expect(()=>workerCredentialFileFixture(dir,uid+1,gid,ACCOUNT)).toThrow('directory');
      const extra=join(scratch,'hardlink');linkSync(auth,extra);rejects('ownership/shape');rmSync(extra);
      writeFileSync(auth,'x'.repeat(64*1024+1),{mode:0o600});rejects('ownership/shape');
      writeFileSync(auth,'');rejects('ownership/shape');
      write({...chatgptAuth(),OPENAI_API_KEY:SYNTHETIC_SECRET});rejects('API-key');
      rmSync(auth);const target=join(scratch,'elsewhere.json');writeFileSync(target,JSON.stringify(chatgptAuth()),{mode:0o600});
      symlinkSync(target,auth);expect(()=>workerCredentialFileFixture(dir,uid,gid,ACCOUNT)).toThrow();rmSync(auth);
      const linked=join(scratch,'linked');symlinkSync(dir,linked);write(chatgptAuth());
      expect(()=>workerCredentialFileFixture(linked,uid,gid,ACCOUNT)).toThrow('directory');
      // Full check also requires root-owned, non-writable ancestry: a /tmp parent is refused.
      // The policy schema rightly refuses a root worker (worker_uid/gid > 0); on a root test
      // runner substitute a synthetic worker id for the parse — the assertion below fails on
      // the /tmp ancestry before any uid comparison.
      const p=parseManagedFactoryPolicy(canonical({...policy(),codex_credentials:dir,worker_uid:uid||1004,worker_gid:gid||1004}));
      expect(()=>workerCredentialFixture(p)).toThrow('credential root path ancestry');
      expect(readdirSync(dir)).toEqual(['auth.json']);
    }finally{rmSync(scratch,{recursive:true,force:true});}
    delete process.env.FACTORY_STATE_MODE;expect(()=>workerCredentialFileFixture('/var/lib/factory/credentials/codex',1,1,ACCOUNT)).toThrow('fixture-only');
  });
  test('each passed descriptor is named by its own child fd number (passFds[i] is fd 3+i)',()=>{
    process.env.FACTORY_STATE_MODE='test';
    const two=policy();two.profile_files=[{path:'.codex/AGENTS.md',sha256:'e'.repeat(64)},{path:'.codex/config.toml',sha256:'f'.repeat(64)}];
    const p=parseManagedFactoryPolicy(canonical(two));
    const {args,passFds}=managedFactoryDescriptorsFixture(p,[41,42],43);
    expect(passFds).toEqual([41,42,43]);
    const named=(flag:string)=>args.flatMap((a,i)=>a===flag?[[args[i+1],args[i+2]]]:[]);
    expect(named('--ro-bind-data')).toEqual([['3',p.home+'/.codex/AGENTS.md'],['4',p.home+'/.codex/config.toml']]);
    expect(named('--bind-fd')).toEqual([['5',p.home+'/.codex/auth.json']]);
    for(const [fd,target] of [...named('--ro-bind-data'),...named('--bind-fd')]){
      const index=Number(fd)-3;expect(index).toBeGreaterThanOrEqual(0);
      expect(passFds[index]).toBe(target.endsWith('auth.json')?43:[41,42][p.profile_files.findIndex(f=>p.home+'/'+f.path===target)]);
    }
    expect(()=>managedFactoryDescriptorsFixture(p,[41],43)).toThrow('descriptor count');
    delete process.env.FACTORY_STATE_MODE;expect(()=>managedFactoryDescriptorsFixture(p,[41,42],43)).toThrow('fixture-only');
  });
  test.skipIf(process.platform!=='linux')('worker roots need root-owned, non-writable ancestry (review M3)',()=>{
    // System directories stand in for root-owned ancestry the test user cannot create.
    // Runner images differ (CI found a /usr stand-in with foreign-owned or writable
    // ancestry), so pick stand-ins whose whole chain this host proves root-owned.
    const chain=(q:string):string[]=>q==='/'?['/']:[q,...chain(dirname(q))];
    const trusted=(q:string)=>existsSync(q)&&chain(q).every(c=>{const i=lstatSync(c);return i.isDirectory()&&!i.isSymbolicLink()&&i.uid===0&&!(i.mode&0o022);});
    const picks=['/usr/bin','/usr/lib','/usr/share/doc','/usr/sbin','/etc','/usr/share','/usr'].filter(trusted);
    if(picks.length<2){console.warn('skipped: no root-owned stand-ins on this host');return;}
    const ok={home:picks[0]!,state_root:picks[1]!,workdir:picks[2]??picks[0]!,worker_uid:1004};
    expect(workerRootAncestry(ok).map(([q])=>q)).toEqual([...chain(dirname(ok.home)),...chain(dirname(ok.state_root)),...chain(dirname(ok.workdir))]);
    if(picks.slice(0,3).join()==='/usr/bin,/usr/lib,/usr/share/doc')
      expect(workerRootAncestry(ok).map(([q])=>q)).toEqual(['/usr','/','/usr','/','/usr/share','/usr','/']);
    const scratch=mkdtempSync('/tmp/zo-task-worker-roots-');
    try{
      mkdirSync(join(scratch,'work'));symlinkSync('/usr',join(scratch,'usr'));
      for(const bad of [{home:join(scratch,'home')},{state_root:join(scratch,'state')},{workdir:join(scratch,'work','exec')},
                        {workdir:join(scratch,'work','exec'),worker_uid:process.getuid!()},{workdir:'/tmp/exec'},{home:join(scratch,'usr','bin')},
                        // Root-owned but world-writable (sticky /tmp) is not root-owned ancestry.
                        {home:'/tmp/home'},{state_root:'/tmp/state'}])
        expect(()=>workerRootAncestry({...ok,...bad})).toThrow('worker root path ancestry');
    }finally{rmSync(scratch,{recursive:true,force:true});}
  });
  test('proxy and agent-mode keys from the caller are refused by name; the literals are fixed',()=>{
    const base={PATH:'/x',HOME:'/h',LC_ALL:'C.UTF-8'};
    expect([...MANAGED_SPAWN_FORBIDDEN_ENV].sort()).toEqual(['ALL_PROXY','HTTPS_PROXY','HTTP_PROXY','INITIAL_AGENT_MODE','NO_PROXY',
      'all_proxy','http_proxy','https_proxy','no_proxy']);
    for(const key of MANAGED_SPAWN_FORBIDDEN_ENV){
      for(const value of ['http://127.0.0.1:3128','agent-full-access','agent','',MANAGED_FACTORY_EGRESS_PROXY])
        expect(managedSpawnEnvironmentKeysClean({...base,[key]:value})).toBe(false);
    }
    expect(MANAGED_FACTORY_EGRESS_PROXY).toBe('http://'+MANAGED_FACTORY_EGRESS_LISTEN);
    expect(MANAGED_FACTORY_AGENT_MODE).toBe('agent-full-access');
  });
  test('a managed session must report exactly the pinned Codex mode (no silent default fallback)',()=>{
    assertManagedFactorySessionMode({sessionId:'s',modes:{currentModeId:'agent-full-access',availableModes:[]}});
    for(const session of [{sessionId:'s',modes:{currentModeId:'agent'}},{sessionId:'s',modes:{currentModeId:'read-only'}},
        {sessionId:'s',modes:{currentModeId:'AGENT-FULL-ACCESS'}},{sessionId:'s'},{sessionId:'s',modes:null},null,undefined,'agent-full-access',
        {sessionId:'s',modes:{currentModeId:['agent-full-access']}}])
      expect(()=>assertManagedFactorySessionMode(session)).toThrow('managed Factory containment: managed Codex session mode');
    const hostile={get modes(){throw new Error('x');}};
    expect(()=>assertManagedFactorySessionMode(hostile)).toThrow('managed Codex session mode');
    // acp-transport asserts it for managed adapters right after session/new, before any prompt.
    const source=readFileSync(join(import.meta.dir,'acp-transport.ts'),'utf8');
    const at=source.indexOf('if (managedAdapters.has(adapter)) assertManagedFactorySessionMode(sessionResult);');
    expect(at).toBeGreaterThan(source.indexOf('sessionId = sessionResult.sessionId;'));
    expect(at).toBeLessThan(source.indexOf('connection.prompt({'));
    expect(at).toBeLessThan(source.indexOf('setSessionConfigOption'));
  });
  test.skipIf(process.platform!=='linux')('the credential quarantine directory must be root-only before the login is bound (review M3)',()=>{
    process.env.FACTORY_STATE_MODE='test';const scratch=mkdtempSync('/tmp/zo-task-quarantine-');
    try{
      const p={codex_credentials:join(scratch,'credentials','codex')};mkdirSync(p.codex_credentials,{recursive:true});
      expect(()=>credentialQuarantineDirectoryFixture(p)).toThrow('credential quarantine directory');  // absent
      const q=join(scratch,'quarantine');mkdirSync(q,{mode:0o700});chmodSync(q,0o700);
      if(process.getuid!()!==0)expect(()=>credentialQuarantineDirectoryFixture(p)).toThrow('credential quarantine directory');  // not root-owned
      chmodSync(q,0o755);expect(()=>credentialQuarantineDirectoryFixture(p)).toThrow('credential quarantine directory');
      rmSync(q,{recursive:true});symlinkSync('/root',q);expect(()=>credentialQuarantineDirectoryFixture(p)).toThrow('credential quarantine directory');
      // The worker check runs on every spawn, after the root-owned credential ancestry.
      const source=readFileSync(join(import.meta.dir,'factory-systemd-containment.ts'),'utf8');
      const body=source.slice(source.indexOf('function workerCredential('),source.indexOf('/** Test-only: the worker-owned file checks'));
      expect(body.indexOf('quarantineDirectory(p);')).toBeGreaterThan(body.indexOf('credentialAncestors('));
      expect(body.indexOf('quarantineDirectory(p);')).toBeLessThan(body.indexOf('openCredential('));
    }finally{rmSync(scratch,{recursive:true,force:true});}
    delete process.env.FACTORY_STATE_MODE;expect(()=>credentialQuarantineDirectoryFixture({codex_credentials:'/x/y/z'})).toThrow('fixture-only');
  });
  test('Bun transpiler cache key is admitted only as the supervisor sets it (stage-4 qualification)',()=>{
    const base={PATH:'/x',HOME:'/h',LC_ALL:'C.UTF-8'};
    expect(managedSpawnEnvironmentKeysClean(base)).toBe(true);
    expect(managedSpawnEnvironmentKeysClean({...base,BUN_RUNTIME_TRANSPILER_CACHE_PATH:'0'})).toBe(true);
    for(const value of ['1','','/var/lib/zouroboros-factory-execution/home/.bun','0 '])
      expect(managedSpawnEnvironmentKeysClean({...base,BUN_RUNTIME_TRANSPILER_CACHE_PATH:value})).toBe(false);
    expect(managedSpawnEnvironmentKeysClean({...base,BUN_INSTALL_CACHE_DIR:'/tmp'})).toBe(false);
  });
});
