#!/usr/bin/env bash
# Repository plumbing for the closed loop. Never touches the deployed checkout.
#
#   repo.sh sync                         fetch origin into the loop mirror (creates it on first use)
#   repo.sh sha <ref>                    print the full SHA of a ref in the mirror (e.g. origin/main)
#   repo.sh export <ref> <dest>          clean, detached checkout of <ref> at <dest> (/tmp only) for read-only checks
#   repo.sh worktree-add <branch> <base-ref>   persistent evolve worktree under $ZO_LOOP_HOME/worktrees/<branch>
#   repo.sh worktree-path <branch>       print the worktree path for a branch
#   repo.sh worktree-remove <branch>     remove the worktree and delete the local branch (rollback before push)
#   repo.sh export-remove <dest>         remove an export created by `export`
#   repo.sh build <dir>                  pnpm frozen install (offline first) + build; log in $ZO_LOOP_HOME/logs/
#   repo.sh clean-check <dir>            exit 1 if <dir> has uncommitted tracked/untracked changes (ignores gitignored)
#
# Env: ZO_LOOP_HOME, ZO_LOOP_REPO (defaults resolved by loop-env.sh)
set -euo pipefail
source "$(dirname "$0")/loop-env.sh"
MIRROR="$LOOP/repos/$(basename "${REPO:-unknown}")"
die() { printf 'repo.sh: %s\n' "$1" >&2; exit "${2:-3}"; }
guard() { zo_protected "$1" && die "refusing to touch the deployed checkout ($(realpath -m "$1"))"; return 0; }
[[ -n "$REPO" ]] || die "cannot determine the repository; set ZO_LOOP_REPO=<owner>/<repo>"
toolpath() {
  local node; node="$(ls -d "$REAL_HOME"/.hermes/tools/node-*/bin 2>/dev/null | tail -1 || true)"
  export PATH="$REAL_HOME/.bun/bin:${node:+$node:}$REAL_HOME/.local/bin:/usr/bin:/bin"
}
cmd="${1:-}"; shift || true
case "$cmd" in
  sync)
    mkdir -p "$LOOP/repos" "$LOOP/worktrees"; chmod 700 "$LOOP"
    if [[ ! -d "$MIRROR/.git" ]]; then gh repo clone "$REPO" "$MIRROR" -- --quiet; fi
    git -C "$MIRROR" fetch --quiet --prune origin
    git -C "$MIRROR" rev-parse origin/main ;;
  sha)
    git -C "$MIRROR" rev-parse --verify "${1:?ref}^{commit}" ;;
  export)
    ref="${1:?ref}"; dest="${2:?dest}"; [[ "$(realpath -m "$dest")" == /tmp/* ]] || die "export destination must be under /tmp"
    [[ ! -e "$dest" ]] || die "destination exists: $dest"
    git -C "$MIRROR" worktree add --quiet --detach "$dest" "$ref"
    git -C "$MIRROR" worktree prune
    printf '%s\n' "$dest" ;;
  export-remove)
    dest="${1:?dest}"; [[ "$(realpath -m "$dest")" == /tmp/* ]] || die "export path must be under /tmp"
    git -C "$MIRROR" worktree remove --force "$dest" 2>/dev/null || rm -rf -- "$dest"
    git -C "$MIRROR" worktree prune; echo "removed $dest" ;;
  worktree-add)
    br="${1:?branch}"; base="${2:-origin/main}"; [[ "$br" == zo-loop/* ]] || die "branch must start with zo-loop/"
    wt="$LOOP/worktrees/${br//\//__}"; [[ ! -e "$wt" ]] || die "worktree exists: $wt"
    git -C "$MIRROR" worktree add --quiet -b "$br" "$wt" "$base"
    printf '%s\n' "$wt" ;;
  worktree-path)
    br="${1:?branch}"; printf '%s\n' "$LOOP/worktrees/${br//\//__}" ;;
  worktree-remove)
    br="${1:?branch}"; [[ "$br" == zo-loop/* ]] || die "branch must start with zo-loop/"
    wt="$LOOP/worktrees/${br//\//__}"
    if git -C "$MIRROR" ls-remote --exit-code --heads origin "$br" >/dev/null 2>&1; then
      die "branch $br exists on origin — close the PR / delete the remote branch through the operator, not here"
    fi
    [[ -d "$wt" ]] && git -C "$MIRROR" worktree remove --force "$wt"
    git -C "$MIRROR" branch -D "$br" >/dev/null 2>&1 || true
    git -C "$MIRROR" worktree prune; echo "removed $br" ;;
  build)
    dir="${1:?dir}"; guard "$dir"; toolpath; cd "$dir"; mkdir -p "$LOOP/logs"
    log="$LOOP/logs/build-$(basename "$dir")-$(date +%Y%m%d%H%M%S).log"
    { CI=1 pnpm install --frozen-lockfile --offline --ignore-scripts || CI=1 pnpm install --frozen-lockfile --prefer-offline --ignore-scripts
      pnpm run build; } > "$log" 2>&1 || die "build failed — see $log" 1
    echo "built $dir (log $log)" ;;
  clean-check)
    dir="${1:?dir}"; [[ -z "$(git -C "$dir" status --porcelain --untracked-files=normal)" ]] || { git -C "$dir" status --short >&2; die "dirty worktree: $dir" 1; }
    echo clean ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
