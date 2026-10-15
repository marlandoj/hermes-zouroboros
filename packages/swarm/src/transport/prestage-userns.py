#!/usr/bin/env python3
"""Prestage a user namespace for a contained executor spawn.

Used by agent-containment.ts when the rootless namespace setup is
unavailable: in nested-userns containers (NoNewPrivs set, unprivileged
uid_map writes denied), a bwrap instance dropped to the containment uid
cannot set up its own user namespace ("setting up uid map: Permission
denied"), so the namespace is created here instead and bwrap runs inside
it without --unshare-user.

How it works (this process runs as root, the factory supervisor):
  1. fork; the child creates a user namespace with unshare(CLONE_NEWUSER)
     and receives the kernel's full capability grant in it (no exec has
     happened yet, so the grant is intact).
  2. the parent writes the identity mapping (inner 0 -> outer
     <uid>/<gid>) into the child's uid_map/gid_map. Root may write a
     foreign namespace's map; the namespace creator's own write, and
     bwrap's dropped-uid write, are what the container denies.
  3. the child setgid(0)/setuid(0) *inside* the namespace, which lands it
     on the containment kuid outside while retaining its in-namespace
     capability grant, then raises CAP_SYS_ADMIN as an ambient capability
     so it survives the exec into bwrap.
  4. the child execs the requested command (bwrap): bwrap runs as inner
     root with CAP_SYS_ADMIN in the prestaged namespace and performs its
     normal mount/pid/uts/ipc setup. The parent waits and propagates the
     exit status (128+signal on signal death).

The resulting sandbox matches the rootless spawn on payload identity
(inner uid 0 == containment uid outside), bind mounts, and credential
mounts. What differs, and is recorded by the caller in
SWARM_EXEC_CONTAINMENT_MODE / SWARM_EXEC_CONTAINMENT_DEGRADED_REASON:
namespace setup is performed by this supervisor-side helper rather than
by bwrap's own dropped-uid process, and /proc is the container's proc
bound read-only instead of a fresh proc for the sandbox PID namespace
(the container's /proc carries locked overmounts, so a fresh proc mount
is rejected as "too revealing" here).

Usage: prestage-userns.py <uid> <gid> <command> [args...]
"""

import ctypes
import os
import sys

CLONE_NEWUSER = 0x10000000
PR_CAP_AMBIENT = 47
PR_CAP_AMBIENT_RAISE = 2
CAP_SYS_ADMIN = 21
_LINUX_CAPABILITY_VERSION_3 = 0x20080522

libc = ctypes.CDLL(None, use_errno=True)


class _CapUserHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint), ("pid", ctypes.c_int)]


class _CapUserData(ctypes.Structure):
    _fields_ = [
        ("effective", ctypes.c_uint),
        ("permitted", ctypes.c_uint),
        ("inheritable", ctypes.c_uint),
    ]


def _child_die(message: str) -> None:
    os.write(2, f"prestage-userns: {message}\n".encode())
    os._exit(1)


def _child(ready_w: int, go_r: int, argv: list) -> None:
    """Create the namespace, wait for the map, then exec argv in it."""
    try:
        if libc.unshare(CLONE_NEWUSER) != 0:
            _child_die(f"unshare(CLONE_NEWUSER) failed: {os.strerror(ctypes.get_errno())}")
        # Handshake: tell the parent the namespace exists, then block until
        # it has written the id maps (it writes them before releasing us).
        os.write(ready_w, b"R")
        os.close(ready_w)
        if os.read(go_r, 1) != b"G":
            _child_die("namespace setup aborted by supervisor")
        os.close(go_r)
        # Land on inner uid/gid 0: outside the namespace this is exactly the
        # containment uid/gid (the map the supervisor wrote). Capabilities
        # granted at namespace creation are retained across this change.
        os.setgid(0)
        os.setuid(0)
        # CAP_SYS_ADMIN must survive the exec into bwrap, which creates the
        # mount/uts/ipc namespaces. Ambient capabilities are the mechanism
        # that crosses exec without a file-capability or setuid step.
        header = _CapUserHeader(_LINUX_CAPABILITY_VERSION_3, 0)
        data = (_CapUserData * 2)()
        if libc.capget(ctypes.byref(header), ctypes.byref(data)) != 0:
            _child_die(f"capget failed: {os.strerror(ctypes.get_errno())}")
        for entry in data:
            entry.inheritable = entry.permitted
            entry.effective = entry.permitted
        if libc.capset(ctypes.byref(header), ctypes.byref(data)) != 0:
            _child_die(f"capset failed: {os.strerror(ctypes.get_errno())}")
        if libc.prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_RAISE, CAP_SYS_ADMIN, 0, 0) != 0:
            _child_die(f"ambient CAP_SYS_ADMIN raise failed: {os.strerror(ctypes.get_errno())}")
        os.execvp(argv[0], argv)
        _child_die(f"exec of {argv[0]} failed")
    except BaseException as exc:  # noqa: BLE001 - child must never fall through
        _child_die(f"{exc}")


def main() -> int:
    if len(sys.argv) < 4:
        os.write(2, b"usage: prestage-userns.py <uid> <gid> <command> [args...]\n")
        return 2
    try:
        uid = int(sys.argv[1])
        gid = int(sys.argv[2])
    except ValueError:
        os.write(2, b"prestage-userns: uid/gid must be integers\n")
        return 2
    argv = sys.argv[3:]

    ready_r, ready_w = os.pipe()
    go_r, go_w = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(ready_r)
        os.close(go_w)
        _child(ready_w, go_r, argv)
        os._exit(1)  # unreachable; _child never returns

    os.close(ready_w)
    os.close(go_r)
    try:
        if os.read(ready_r, 1) != b"R":
            raise RuntimeError("namespace child failed before signalling readiness")
        with open(f"/proc/{child}/uid_map", "w") as handle:
            handle.write(f"0 {uid} 1")
        # Required before the gid map write when the writer is not the
        # namespace creator; also matches the rootless spawn's semantics
        # (bwrap writes setgroups=deny there too).
        try:
            with open(f"/proc/{child}/setgroups", "w") as handle:
                handle.write("deny")
        except OSError:
            pass
        with open(f"/proc/{child}/gid_map", "w") as handle:
            handle.write(f"0 {gid} 1")
        os.write(go_w, b"G")
    except BaseException as exc:  # noqa: BLE001 - supervisor must reap or kill
        os.write(2, f"prestage-userns: namespace setup failed: {exc}\n".encode())
        try:
            os.kill(child, 9)
        except OSError:
            pass
        os.waitpid(child, 0)
        return 1
    finally:
        os.close(ready_r)
        os.close(go_w)

    _, status = os.waitpid(child, 0)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


if __name__ == "__main__":
    sys.exit(main())
