#!/usr/bin/env bash
# Swarm cancellation test with a FAKE Hermes (no model calls).
# Pass = after SIGTERM to `cli.ts swarm`, no worker/fake-hermes process survives and task b never starts.
# Usage: interrupt-test.sh <isolated-repo-copy> <evidence-dir>
set -uo pipefail
[[ $# -eq 2 ]] || { echo "Usage: $0 <isolated-repo-copy> <evidence-dir>" >&2; exit 2; }
R="$1"; A="$2"; BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
case "$R" in /tmp/*) ;; *) echo 'Repo copy must be under /tmp (never the deployed checkout).' >&2; exit 2;; esac
I="$(mktemp -d /tmp/zo-task-interrupt-XXXXXX)"; mkdir -p "$I/data" "$I/work" "$I/bin" "$A"
cat > "$I/bin/hermes" <<EOF
#!/usr/bin/env bash
echo "\$(date +%s) \$\$ \$*" >> "$I/invocations.log"
[[ "\$1" == "--version" ]] && { echo "Hermes Agent fake"; exit 0; }
sleep 25; echo FAKE_DONE
EOF
chmod +x "$I/bin/hermes"
E=(env HOME="$I" PATH="$I/bin:$(dirname "$BUN"):/usr/bin:/bin" HERMES_ZOUROBOROS_HOME="$I/data" HERMES_ZOUROBOROS_ALLOW_SWARM=1)
cd "$R" || exit 1
"${E[@]}" "$BUN" integration/cli.ts init --workspace "$I/work" > /dev/null
echo '[{"id":"a","task":"step a","timeoutSeconds":60},{"id":"b","task":"step b","dependsOn":["a"],"timeoutSeconds":60}]' > "$I/work/tasks.json"
"${E[@]}" "$BUN" integration/cli.ts swarm "$I/work/tasks.json" > "$I/run.out" 2>&1 & CLI=$!
sleep 6; kill -TERM "$CLI"; wait "$CLI"; ec=$?

# Survivors are matched from Python so this shell's own command line never matches the pattern.
survivors() { python3 - "$I" <<'EOF'
import os,sys
tag=sys.argv[1]; me={os.getpid(),os.getppid()}; out=[]
for p in os.listdir('/proc'):
    if not p.isdigit() or int(p) in me: continue
    try: c=open(f'/proc/{p}/cmdline','rb').read().replace(b'\0',b' ').decode()
    except Exception: continue
    if tag in c and 'python3 -' not in c: out.append(p)
print(len(out))
EOF
}
sleep 7; s7=$(survivors); sleep 25; s32=$(survivors)
starts=$(grep -vc -- '--version' "$I/invocations.log" 2>/dev/null || echo 0)
result=PASS; [[ "$s7" -eq 0 && "$starts" -le 1 ]] || result=FAIL
printf 'cli_exit=%s survivors_after_7s=%s survivors_after_32s=%s task_starts=%s result=%s\n' "$ec" "$s7" "$s32" "$starts" "$result" | tee "$A/F-interrupt.txt"
cp "$I/invocations.log" "$A/F-interrupt-invocations.log" 2>/dev/null
# Clean up any orphans by PID (never pkill -f: the pattern would match this shell).
python3 - "$I" <<'EOF'
import os,signal,sys
tag=sys.argv[1]; me={os.getpid(),os.getppid()}
for p in os.listdir('/proc'):
    if not p.isdigit() or int(p) in me: continue
    try: c=open(f'/proc/{p}/cmdline','rb').read().replace(b'\0',b' ').decode()
    except Exception: continue
    if tag in c and 'python3 -' not in c:
        try: os.kill(int(p), signal.SIGTERM)
        except ProcessLookupError: pass
EOF
rm -rf "$I"
[[ $result == PASS ]]
