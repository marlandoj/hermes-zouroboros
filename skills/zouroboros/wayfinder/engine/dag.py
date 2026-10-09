"""Wayfinder's gates as an executable DAG.

The workflow used to live only as prose and a picture. An ordering that is drawn
but never checked is an ordering nobody has to keep honest: the day a gate is
added, nobody notices it was inserted ahead of something it depends on. This
module makes the ordering a data structure that is validated before anything
runs.

Two graphs, deliberately not merged.

`deps` is the execution graph: edges a node needs before it may start. It must
be acyclic, and that is what earns it the right to be scheduled -- an acyclic
dependency graph decomposes into waves, and every node in a wave is independent
of every other node in the same wave, so a wave is a legitimate parallel unit.

`transitions` is the control graph: where a gate sends the run once it has a
verdict. It is allowed to point backwards. Rollback-to-shadow and the
re-run-correctness loop are both cycles in this graph and must stay cycles; the
adoption workflow has no safe forward path once a gate fails.

Merging the two is the tempting simplification and it is wrong twice over. A
back edge in `deps` makes the graph cyclic, which destroys wave scheduling for
the entire workflow over one rollback path. Worse, it hides the distinction
that matters: "this gate ran" and "this gate passed" are different facts, and
the scheduler needs only the first.
"""
import argparse
import json
import sys
from pathlib import Path

TERMINAL = 'terminal'


class DagError(Exception):
    """Raised when a spec is malformed. Carries every error found, not just the first."""


def load(path):
    try:
        spec = json.loads(Path(path).read_text())
    except OSError as exc:
        raise DagError(f'cannot read {path}: {exc}') from exc
    except ValueError as exc:
        raise DagError(f'{path} is not valid JSON: {exc}') from exc
    return spec


def nodes_of(spec):
    """Index nodes by id, skipping any that have none.

    A node without an id cannot be referenced, scheduled, or reported on, so it
    is not a node the rest of the checker can reason about. Dropping it here
    rather than raising keeps a malformed spec on the error-list path: the
    caller gets "a node has no id" alongside every other problem instead of a
    traceback that hides them.
    """
    return {n['id']: n for n in spec.get('nodes', []) if isinstance(n, dict) and 'id' in n}


# Roles a node may hold. A node is not restricted to one: the terminal node of
# the routing workflow is simultaneously the join of the gates that feed it and
# the end of the run, and collapsing that to a single name would force a choice
# between checking the join and allowing the node to have no successor.
ROLE_NAMES = ('gate', 'join', 'sink', 'step')


def roles_of(node):
    """Every role a node holds, as a set."""
    declared = node.get('roles') or [node.get('kind', 'step')]
    if isinstance(declared, str):
        declared = [declared]
    unknown = [r for r in declared if r not in ROLE_NAMES]
    if unknown:
        raise DagError(f"node {node.get('id')!r} declares unknown role(s): {', '.join(unknown)}")
    return set(declared)


def role_text(node):
    """Human-readable role list for an error message."""
    return '/'.join(sorted(roles_of(node)))


def validate(spec):
    """Return a list of human-readable problems. Empty means the spec is sound.

    Never raises for a merely-wrong spec; the caller decides whether to stop.
    Returning all errors at once is deliberate -- fixing a DAG one complaint per
    run is how you end up re-introducing a cycle you just broke.
    """
    errors = []
    nodes = nodes_of(spec)
    declared = [n for n in spec.get('nodes', []) if isinstance(n, dict)]

    # Counted before the empty-graph short-circuit below: a spec whose only
    # problem is a malformed node still has to be told what was wrong with it.
    idless = sum(1 for n in declared if 'id' not in n)

    if not nodes:
        return ['spec declares no nodes'] + (['a node has no id'] if idless else [])

    seen = set()
    for node in declared:
        if 'id' not in node:
            errors.append('a node has no id')
            continue
        if node['id'] in seen:
            errors.append(f"duplicate node id: {node['id']}")
        seen.add(node['id'])

    # --- deps: shape, then acyclicity -------------------------------------
    for node in nodes.values():
        for dep in node.get('deps', []):
            if dep == node['id']:
                errors.append(f"{node['id']} depends on itself")
            elif dep not in nodes:
                errors.append(f"{node['id']} depends on unknown node {dep}")

    cycle = find_cycle(nodes)
    if cycle:
        errors.append('deps contain a cycle: ' + ' -> '.join(cycle))
        # Waves are meaningless on a cyclic graph. Stop here rather than emit a
        # schedule that silently omits the nodes inside the cycle.
        return errors

    # --- transitions ------------------------------------------------------
    transitions = spec.get('transitions', {})
    for source in transitions:
        if source not in nodes:
            errors.append(f'transition from unknown node {source}')

    for node_id, node in sorted(nodes.items()):
        # A node may hold more than one role. The terminal node of the routing
        # workflow is both the join of three gates and the end of the run;
        # forcing it to pick a single name would either drop the join check or
        # invent a successor for a node that has none.
        roles = roles_of(node)
        out = transitions.get(node_id, {})
        if 'sink' in roles:
            if out:
                errors.append(f'{node_id} is a sink but declares transitions')
            continue
        if not out:
            errors.append(f'{node_id} ({role_text(node)}) declares no transition: it can never hand off')
        if 'gate' in roles:
            # Fail-closed, but not arbitrarily binary. The rule that matters is
            # that every outcome a gate can produce is routed and that it can
            # produce more than one: a gate whose only verdict is a pass has had
            # its failure decided in advance. Most gates are pass/fail and say
            # nothing; a gate that genuinely discriminates -- swarm orchestration
            # resolves to DIRECT, SUGGEST, SWARM or FORCE_SWARM -- declares its
            # own vocabulary, and the checker holds that to the same standard
            # instead of forcing two verdicts onto a four-way decision.
            verdicts = node.get('verdicts') or ['pass', 'fail']
            if len(set(verdicts)) < 2:
                errors.append(f'gate {node_id} declares a single verdict {verdicts[0]!r}; a gate must be able to decide both ways')
            for verdict in verdicts:
                if verdict not in out:
                    errors.append(f'gate {node_id} declares no {verdict!r} transition')
            for verdict in sorted(out):
                if verdict not in verdicts:
                    errors.append(f'gate {node_id} routes {verdict!r} but does not declare it as a verdict')
        for verdict, targets in sorted(out.items()):
            targets = targets if isinstance(targets, list) else [targets]
            if not targets:
                errors.append(f'{node_id} transition {verdict!r} has no target')
            for target in targets:
                if target not in nodes:
                    errors.append(f'{node_id} transition {verdict!r} names unknown node {target}')

    # --- reachability -----------------------------------------------------
    # Computed after transitions so rollback-only nodes are seen as reachable.
    # A workflow legitimately has exactly one entry point; more than one and
    # there is no single answer to "when does this start".
    entrypoints = spec.get('entrypoints', [])
    for node_id in entrypoints:
        if node_id not in nodes:
            errors.append(f'entrypoint names unknown node {node_id}')
    if len(entrypoints) > 1:
        errors.append(f'spec declares {len(entrypoints)} entry points; exactly one start node is required')
    for node_id in unreachable(nodes, transitions, entrypoints):
        errors.append(f'{node_id} is unreachable: no entry point reaches it by dependency or transition')

    # --- joins ------------------------------------------------------------
    indegree = {n: len(set(nodes[n].get('deps', []))) for n in nodes}
    for node_id, node in sorted(nodes.items()):
        if 'join' in roles_of(node) and indegree[node_id] < 2:
            errors.append(f'join {node_id} has {indegree[node_id]} dependency; a join needs at least 2')

    return errors


def assert_valid(spec):
    errors = validate(spec)
    if errors:
        raise DagError('invalid DAG:\n  ' + '\n  '.join(errors))


def find_cycle(nodes):
    """Return one cycle as a node-id path, or None. Iterative: specs are data,
    and a cycle here is exactly the case that would blow a recursive walk."""
    WHITE, GREY, BLACK = 0, 1, 2
    colour = {n: WHITE for n in nodes}
    parent = {}
    children = {}

    for root in sorted(nodes):
        if colour[root] != WHITE:
            continue
        stack = [(root, iter(nodes[root].get('deps', [])))]
        colour[root] = GREY
        while stack:
            node_id, remaining = stack[-1]
            advanced = False
            for nxt in remaining:
                if nxt not in nodes:
                    continue
                if colour[nxt] == GREY:
                    # A grey neighbour is an ancestor on the current DFS path, so the
                    # cycle closes by walking *down* the tree from nxt to the node
                    # currently being expanded. Climbing parent pointers instead
                    # dead-ends at the DFS root and prints "a -> a" for a two-node cycle.
                    return dfs_path(children, nxt, node_id) + [nxt]
                if colour[nxt] == WHITE:
                    colour[nxt] = GREY
                    parent[nxt] = node_id
                    children.setdefault(node_id, []).append(nxt)
                    stack.append((nxt, iter(nodes[nxt].get('deps', []))))
                    advanced = True
                    break
            if not advanced:
                colour[node_id] = BLACK
                stack.pop()
    return None


def dfs_path(children, start, goal):
    """Node ids from `start` down to `goal` along the DFS tree, inclusive."""
    if start == goal:
        return [start]
    for child in children.get(start, []):
        found = dfs_path(children, child, goal)
        if found:
            return [start] + found
    return []


def unreachable(nodes, transitions=None, entrypoints=None):
    """Nodes no declared entry point can reach.

    Reachability is computed over both graphs. Using only `deps` would miss a
    node that is ever reached solely through a control edge -- which is exactly
    what `rollback_to_shadow` looks like: nothing depends on it and it depends
    on nothing, yet every failing gate routes to it. A node whose only path into
    the workflow runs backwards through a transition is still executed, and a
    checker that cannot see that will either demand a fake forward dependency or,
    worse, let a genuinely orphaned node through.

    Entry points come from the spec when it names them. With none declared the
    roots are the nodes with no dependencies, which is the only defensible
    default: a graph that declares no entry point admits every root, and the
    honest reading of that is that its author did not say where to start.
    """
    transitions = transitions or {}
    # `deps` are declared by the dependent as its prerequisites, so the stored
    # direction points from a node back to what it waits on. Walking that forward
    # reaches prerequisites and nothing that waits on the node, which reports every
    # join and every downstream stage as unreachable. Reachability needs the
    # execution direction, so dependency edges are inverted here.
    adjacency = {node_id: [] for node_id in nodes}
    for node_id, node in nodes.items():
        for dep in node.get('deps', []):
            if dep in nodes:
                adjacency.setdefault(dep, []).append(node_id)
    # Control edges already point where execution goes next, so they are kept as
    # declared: a rollback edge runs backwards on purpose and must stay visible.
    for source, out in transitions.items():
        for targets in out.values():
            for target in (targets if isinstance(targets, list) else [targets]):
                if target in nodes:
                    adjacency.setdefault(source, []).append(target)

    if entrypoints:
        starts = [n for n in entrypoints if n in nodes]
    else:
        starts = [n for n, node in nodes.items() if not node.get('deps')]

    if not starts:
        return sorted(nodes)

    reached, queue = set(), list(starts)
    while queue:
        reached.update(queue)
        queue = [t for t in
                 (target for current in queue for target in adjacency.get(current, []))
                 if t not in reached]
    return sorted(set(nodes) - reached)


def waves(nodes):
    """Group nodes into dependency waves. Index 0 runs first.

    Wave membership is by longest-path depth, not by discovery order: a node
    belongs to the wave one past its deepest dependency. `critical_depth` is
    the number of waves, which is the real cost of the workflow -- node count
    overstates it and critical-path length is the only figure that predicts how
    long a run takes.
    """
    depth = {}

    def resolve(node_id, seen):
        if node_id in depth:
            return depth[node_id]
        if node_id in seen:
            raise DagError(f'cycle through {node_id}')
        seen = seen | {node_id}
        deps = [d for d in nodes[node_id].get('deps', []) if d in nodes]
        depth[node_id] = 0 if not deps else 1 + max(resolve(d, seen) for d in deps)
        return depth[node_id]

    for node_id in nodes:
        resolve(node_id, frozenset())

    result = []
    for level in range(max(depth.values(), default=-1) + 1):
        members = sorted(n for n, d in depth.items() if d == level)
        if members:
            result.append(members)
    return result


def plan(spec):
    """Validate, then decompose. Raises on any problem -- there is no schedule
    to return for a graph that is not a DAG."""
    assert_valid(spec)
    nodes = nodes_of(spec)
    scheduled = waves(nodes)
    known = {n for wave in scheduled for n in wave}
    return {
        'name': spec.get('name'),
        'nodes': len(nodes),
        'gates': sum(1 for n in nodes.values() if n.get('kind') == 'gate'),
        'waves': len(scheduled),
        'critical_depth': len(scheduled),
        'max_parallelism': max((len(w) for w in scheduled), default=0),
        'schedule': scheduled,
        'unreachable': unreachable(nodes, spec.get('transitions', {}), spec.get('entrypoints', [])),
        'all_nodes_scheduled': len(known) == len(nodes),
    }


def gating_waves(spec, lane_name='routing'):
    """The runtime lane as dependency waves, index 0 earliest.

    Grouped rather than flattened on purpose. A flat list reads as a total
    order, and the routing lane does not have one: harness, model-route and
    swarm-decision sit in wave 1 as siblings with no dependency between any two
    of them. Flattening them would invent a sequence the graph explicitly
    declines to assert -- and it would invent the wrong one, because the
    flattened list would present the swarm gate as running after the model
    route, which is the ordering claim this whole exercise exists to settle.

    The lane check is the other half. A lane node whose deps reach outside the
    lane is an error, not something to skip: quietly dropping the edge lets the
    lane report an order that contradicts the graph it was drawn from.
    """
    assert_valid(spec)
    nodes = nodes_of(spec)
    lane = [n for n, node in nodes.items() if node.get('lane') == lane_name]
    if not lane:
        # An empty lane is a caller mistake, not an empty schedule. Returning []
        # would make a typo'd lane name indistinguishable from a lane that
        # genuinely resolves to nothing, and the caller would see an order for a
        # workflow that does not exist.
        known = sorted({node.get('lane') for node in nodes.values() if node.get('lane')})
        raise DagError(f'no nodes in lane {lane_name!r}; declared lanes: {known or "none"}')
    sub = {k: nodes[k] for k in lane}
    for node_id, node in sub.items():
        outside = [d for d in node.get('deps', []) if d not in sub]
        if outside:
            raise DagError(f'{node_id} declares deps outside the {lane_name!r} lane: {outside}')
    return waves(sub)


def gating_order(spec, lane_name='routing'):
    """Flatten a lane to a single order, refusing when the lane fans out.

    Kept for callers that genuinely want one name at a time. It no longer
    flattens a parallel lane into a pretend-sequencethat would misreport the
    workflow; a lane with any multi-node wave raises instead.
    """
    scheduled = gating_waves(spec, lane_name)
    wide = [w for w in scheduled if len(w) > 1]
    if wide:
        raise DagError(
            f'{lane_name!r} lane is not serial; wave(s) {wide} contain parallel gates. '
            'Use gating_waves() -- flattening would assert an ordering the graph does not support.')
    return [n for wave in scheduled for n in wave]


def reachable_from(nodes, start, edges):
    """Forward closure over the given adjacency, for reachability proofs."""
    seen, queue = {start}, [start]
    while queue:
        current = queue.pop()
        for target in edges.get(current, []):
            if target not in seen:
                seen.add(target)
                queue.append(target)
    return seen

def main(argv=None):
    parser = argparse.ArgumentParser(prog='dag', description=__doc__)
    parser.add_argument('command', choices=['validate', 'plan', 'order'])
    parser.add_argument('spec', help='path to a workflow DAG spec')
    parser.add_argument('--lane', default=None, help='restrict `order` to one lane')
    args = parser.parse_args(argv)

    try:
        spec = load(args.spec)
    except DagError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    try:
        if args.command == 'validate':
            errors = validate(spec)
            if errors:
                print('\n'.join(errors), file=sys.stderr)
                return 2
            print('valid:', spec.get('name', '(unnamed)'))
        elif args.command == 'plan':
            result = plan(spec)
            print(json.dumps(result, indent=2))
        else:
            waves_out = gating_waves(spec, lane_name=args.lane) if args.lane else waves(nodes_of(spec))
            for index, wave in enumerate(waves_out):
                print(f'wave {index}: {"  ".join(wave)}')
    except DagError as exc:
        # An unusable spec is a refusal, not a crash. Exit 2 keeps "the workflow
        # is wrong" distinct from "the checker is broken", so a caller can alert
        # on the former and ignore the latter.
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
