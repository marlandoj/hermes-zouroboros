#!/usr/bin/env python3
"""The DAG checker holds up its end: adversarial specs it must refuse, and the
two shipped specs it must accept.

The checker is the only thing standing between a wrong gate ordering and a
workflow that runs gates in the wrong order forever, so the negative cases get
as much attention as the positive ones. A validator that passes everything is
indistinguishable from no validator at all.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'engine'))

import dag  # noqa: E402

PASS = FAIL = 0


def check(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
    else:
        FAIL += 1
        print(f'FAIL {name}: expected [{want}] got [{got}]')


def spec_of(nodes, transitions, entrypoints):
    return {'name': 't', 'entrypoints': entrypoints, 'nodes': nodes, 'transitions': transitions}


def node(node_id, kind='step', deps=(), **kw):
    out = {'id': node_id, 'kind': kind, 'deps': list(deps)}
    out.update(kw)
    return out


def errors_of(*args, **kwargs):
    return dag.validate(spec_of(*args, **kwargs))


def has_error(errors, fragment):
    return any(fragment in e for e in errors)


def refuses(name, errors, fragment):
    check(name, has_error(errors, fragment), True)


# --- shape ---------------------------------------------------------------
refuses('empty spec', errors_of([], {}, []), 'declares no nodes')

dup = [node('a'), node('a')]
refuses('duplicate id', errors_of(dup, {}, []), 'duplicate node id')

refuses('missing id', errors_of([{'kind': 'step'}], {}, []), 'has no id')

refuses('unknown dep', errors_of([node('a', deps=['ghost'])], {'a': {'ok': ['a']}}, []),
        'depends on unknown node ghost')

refuses('self dep', errors_of([node('a', deps=['a'])], {'a': {'ok': ['a']}}, []),
        'depends on itself')

# --- acyclicity ----------------------------------------------------------
# The load-bearing property: a cycle makes waves meaningless, so validation
# stops rather than emitting a schedule that silently drops the cycle's nodes.
cyc = [node('a', deps=['c']), node('b', deps=['a']), node('c', deps=['b'])]
refuses('cycle detected', errors_of(cyc, {}, []), 'deps contain a cycle')

# The transition graph is *meant* to contain cycles. A rollback edge must not
# be reported as an acyclicity violation, or every rollback workflow is dead.
back_edge = [node('g', kind='gate', deps=['s']), node('s'), node('r')]
rolled = errors_of(back_edge, {'g': {'pass': ['s'], 'fail': ['r']}, 's': {'ok': ['g']}, 'r': {'ok': ['s']}}, ['s'])
check('back edge is not a cycle', has_error(rolled, 'cycle'), False)

# --- transitions ---------------------------------------------------------
refuses('step cannot hand off', errors_of([node('a')], {}, ['a']), 'declares no transition')

refuses('gate missing fail', errors_of([node('g', kind='gate')], {'g': {'pass': ['g']}}, ['g']),
        "declares no 'fail' transition")

refuses('gate missing pass', errors_of([node('g', kind='gate')], {'g': {'fail': ['g']}}, ['g']),
        "declares no 'pass' transition")

# A gate that decides only one way has had its failure settled in advance.
refuses('one-way gate',
        errors_of([node('g', kind='gate', verdicts=['pass'])], {'g': {'pass': ['g']}}, ['g']),
        'single verdict')

refuses('unknown transition target',
        errors_of([node('g', kind='gate', deps=['s']), node('s')],
                  {'s': {'ok': ['g']}, 'g': {'pass': ['ghost'], 'fail': ['s']}}, ['s']),
        'names unknown node ghost')

refuses('empty target list',
        errors_of([node('g', kind='gate', deps=['s']), node('s')],
                  {'s': {'ok': ['g']}, 'g': {'pass': [], 'fail': ['s']}}, ['s']),
        'has no target')

refuses('sink with transitions',
        errors_of([node('s'), node('z', kind='sink', deps=['s'])],
                  {'s': {'ok': ['z']}, 'z': {'ok': ['z']}}, ['s']),
        'is a sink but declares transitions')

refuses('transition from unknown node',
        errors_of([node('s')], {'s': {'ok': ['s']}, 'ghost': {'ok': ['s']}}, ['s']),
        'transition from unknown node ghost')

# A four-way gate is allowed to say so, and is then held to its own vocabulary.
four = errors_of([node('g', kind='gate', verdicts=['direct', 'suggest', 'swarm'], deps=['s']), node('s')],
                 {'s': {'ok': ['g']}, 'g': {'direct': ['s'], 'suggest': ['s'], 'swarm': ['s']}}, ['s'])
check('four-way gate accepted', four, [])

refuses('undeclared verdict routed',
        errors_of([node('g', kind='gate', verdicts=['direct', 'swarm'], deps=['s']), node('s')],
                  {'s': {'ok': ['g']}, 'g': {'direct': ['s'], 'swarm': ['s'], 'sideways': ['s']}}, ['s']),
        "routes 'sideways' but does not declare it")

refuses('declared verdict unrouted',
        errors_of([node('g', kind='gate', verdicts=['direct', 'swarm'], deps=['s']), node('s')],
                  {'s': {'ok': ['g']}, 'g': {'direct': ['s'], 'swarm': ['s']}}, ['s']),
        'single verdict') if False else None
missing = errors_of([node('g', kind='gate', verdicts=['direct', 'suggest', 'swarm'], deps=['s']), node('s')],
                    {'s': {'ok': ['g']}, 'g': {'direct': ['s'], 'swarm': ['s']}}, ['s'])
refuses('declared verdict not routed', missing, "declares no 'suggest' transition")

# --- multi-role nodes ----------------------------------------------------
# The routing sink is both the join of three gates and the terminal state.
both = errors_of([node('g1', kind='gate', deps=['s']), node('g2', kind='gate', deps=['s']),
                  node('s'), {'id': 'z', 'deps': ['g1', 'g2'], 'roles': ['join', 'sink']}],
                 {'s': {'ok': ['g1', 'g2']},
                  'g1': {'pass': ['z'], 'fail': ['z']},
                  'g2': {'pass': ['z'], 'fail': ['z']}}, ['s'])
check('join+sink node accepted', both, [])

# --- reachability --------------------------------------------------------
orphan = [node('s'), node('g', kind='gate', deps=['s']), node('lonely')]
refuses('orphan node', errors_of(orphan, {'s': {'ok': ['g']}, 'g': {'pass': ['g'], 'fail': ['g']}}, ['s']),
        'lonely is unreachable')

# A node reachable only through a control edge is genuinely executed. A checker
# that used deps alone would demand a fake forward dependency here.
ctl_only = [node('s'), node('g', kind='gate', deps=['s']), node('r')]
errs = errors_of(ctl_only, {'s': {'ok': ['g']}, 'g': {'pass': ['g'], 'fail': ['r']}, 'r': {'ok': ['s']}}, ['s'])
check('control-only node is reachable', has_error(errs, 'r is unreachable'), False)

refuses('two entry points',
        errors_of([node('a'), node('b')], {'a': {'ok': ['a']}, 'b': {'ok': ['b']}}, ['a', 'b']),
        'exactly one start node is required')

refuses('unknown entrypoint',
        errors_of([node('a')], {'a': {'ok': ['a']}}, ['ghost']),
        'entrypoint names unknown node ghost')

# --- joins ---------------------------------------------------------------
refuses('lone join',
        errors_of([node('s'), node('j', kind='join', deps=['s'])],
                  {'s': {'ok': ['j']}, 'j': {'ok': ['s']}}, ['s']),
        'a join needs at least 2')

# --- waves ---------------------------------------------------------------
wave_nodes = {'a': node('a'), 'b': node('b', deps=['a']), 'c': node('c', deps=['a'])}
check('parallel siblings share a wave', dag.waves(wave_nodes), [['a'], ['b', 'c']])

deep = {'a': node('a'), 'b': node('b', deps=['a']),
        'c': node('c', deps=['a']), 'd': node('d', deps=['b', 'c'])}
# Depth is longest-path, not discovery order: d sits one past its deepest
# dependency even though c was discovered second.
check('depth is longest-path', dag.waves(deep), [['a'], ['b', 'c'], ['d']])

# plan() refuses an invalid spec, so a chain meant only to be measured still
# has to satisfy the transition rule: every node needs a way to hand off.
chain = {'a': {'ok': ['b', 'c']}, 'b': {'ok': ['d']}, 'c': {'ok': ['d']}, 'd': {'ok': ['a']}}
check('plan critical depth', dag.plan(spec_of([deep['d'], deep['b'], deep['c'], deep['a']],
                                              chain, ['a']))['critical_depth'], 3)

# --- the shipped specs ---------------------------------------------------
# These are the specs the workflow actually runs. If they stop validating, the
# workflow's documented ordering has drifted from the executable one.
for rel, lane in (('workflows/adoption.dag.json', 'adoption'),
                  ('workflows/routing.dag.json', 'routing')):
    loaded = dag.load(ROOT / rel)
    check(f'{rel} validates', dag.validate(loaded), [])
    check(f'{rel} schedules every node', dag.plan(loaded)['all_nodes_scheduled'], True)
    lanes = dag.gating_waves(loaded, lane_name=lane)
    check(f'{rel} {lane} lane decomposes', bool(lanes), True)

# The routing lane is deliberately not serial: harness, model-route and swarm
# are wave-1 siblings. A serial answer here would assert an ordering the
# dependency graph does not support, so gating_order must refuse rather than
# flatten it into a chain.
routing = dag.load(ROOT / 'workflows/routing.dag.json')
try:
    dag.gating_order(routing)
    check('gating_order refuses non-serial lane', 'no refusal', 'DagError')
except dag.DagError as exc:
    check('gating_order refuses non-serial lane', 'not serial' in str(exc), True)

# The adoption lane is not serial either, and for a better reason than routing's:
# the three shadow gates measure conformance, correctness and latency over the
# same shadow install and share no state, so running them as one wave is not just
# permitted but the point of expressing them as a DAG. A serial answer would
# understate the parallelism the spec actually permits.
adoption = dag.load(ROOT / 'workflows/adoption.dag.json')
check('adoption shadow gates are wave-1 siblings',
      dag.gating_waves(adoption, 'adoption')[1],
      ['g1_conformance', 'g2_correctness', 'g3_latency'])
try:
    dag.gating_order(adoption, lane_name='adoption')
    check('gating_order refuses non-serial adoption lane', 'no refusal', 'DagError')
except dag.DagError as exc:
    check('gating_order refuses non-serial adoption lane', 'not serial' in str(exc), True)

# The lane name is an argument, so a wrong one has to fail rather than quietly
# produce a schedule for a workflow that does not exist.
try:
    dag.gating_order(adoption)
    check('unknown lane refused', 'no refusal', 'DagError')
except dag.DagError as exc:
    check('unknown lane refused', 'no nodes in lane' in str(exc), True)

# A lane that reaches outside itself would report an order contradicting the
# graph it came from, so the reduction fails loudly instead.
# 's' sits in another lane, so reducing to the routing lane has to drop a node
# it depends on. Silently ignoring the outside edge would let the lane report an
# order that contradicts the graph it was derived from.
stray = {'name': 't', 'entrypoints': ['s'],
         'nodes': [node('s', lane='other'), node('a', lane='routing', deps=['s']),
                   node('b', lane='routing', deps=['a'])],
         'transitions': {'s': {'ok': ['a']}, 'a': {'ok': ['b']}, 'b': {'ok': ['b']}}}
try:
    dag.gating_order(stray, lane_name='routing')
    check('cross-lane dep refused', 'no refusal', 'DagError')
except dag.DagError as exc:
    check('cross-lane dep refused', 'outside' in str(exc), True)

# --- cli contract --------------------------------------------------------
# The CLI is how the checker gets invoked in practice, so its exit codes are
# part of the contract: 0 sound, 2 invalid.
cli = ROOT / 'engine' / 'dag.py'
for bad, want in ((['{"nodes": []}'], 2),
                  (['{"nodes": [{"id":"a"}], "transitions": {"a": {"ok": ["a"]}}, "entrypoints": ["a"]}'], 0)):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / 's.json'
        path.write_text(bad[0])
        proc = subprocess.run([sys.executable, str(cli), 'validate', str(path)],
                              capture_output=True, text=True)
        check(f'cli exit for {bad[0][:18]}', proc.returncode, want)

print(f'{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)