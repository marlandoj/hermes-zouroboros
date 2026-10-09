#!/usr/bin/env bash
# Install the pinned gitleaks release after verifying its SHA-256. Prints the binary path.
# Usage: bash scripts/ci/install-gitleaks.sh [install-dir]   (default: a new temporary directory)
set -euo pipefail
VERSION=8.30.1
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET=linux_x64; SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  Linux-aarch64) ASSET=linux_arm64; SHA256=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  *) printf 'No pinned gitleaks checksum for %s-%s\n' "$(uname -s)" "$(uname -m)" >&2; exit 1 ;;
esac
DEST="${1:-$(mktemp -d "${TMPDIR:-/tmp}/gitleaks-XXXXXX")}"
mkdir -p "$DEST"
ARCHIVE="$DEST/gitleaks_${VERSION}_${ASSET}.tar.gz"
curl -fsSL --retry 3 -o "$ARCHIVE" "https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_${ASSET}.tar.gz"
printf '%s  %s\n' "$SHA256" "$ARCHIVE" | sha256sum -c --quiet - >&2
tar -xzf "$ARCHIVE" -C "$DEST" gitleaks
rm -f "$ARCHIVE"
"$DEST/gitleaks" version >&2
printf '%s\n' "$DEST/gitleaks"
