#!/usr/bin/env bash
# Held-out probe (cancellation class): SIGINT (not SIGTERM) during task 1 of a 3-task chain, fake Hermes, no model calls.
# Usage: interrupt-variant.sh <repo-copy-under-/tmp> → prints result=PASS|FAIL; exit 0 PASS, 1 FAIL, 97 setup.
set -u; R="$1"; BUN="${BUN:-bun}"; [[ "$(realpath -m "$R")" == /tmp/* ]] || exit 97
I="$(mktemp -d /tmp/zo-task-hv-XXXXXX)"; mkdir -p "$I/data" "$I/work" "$I/bin"
cat > "$I/bin/hermes" <<EOS
#!/usr/bin/env bash
echo "\$(date +%s) \$*" >> "$I/inv.log"; [[ "\$1" == --version ]] && { echo fake; exit 0; }; sleep 20; echo DONE
EOS
chmod +x "$I/bin/hermes"
E=(env HOME="$I" PATH="$I/bin:$(dirname "$(command -v "$BUN")"):/usr/bin:/bin" HERMES_ZOUROBOROS_HOME="$I/data" HERMES_ZOUROBOROS_ALLOW_SWARM=1)
cd "$R" && "${E[@]}" "$BUN" integration/cli.ts init --workspace "$I/work" >/dev/null || exit 97
echo '[{"id":"a","task":"a","timeoutSeconds":60},{"id":"b","task":"b","dependsOn":["a"],"timeoutSeconds":60},{"id":"c","task":"c","dependsOn":["b"],"timeoutSeconds":60}]' > "$I/work/t.json"
# Job control on: without it, non-interactive bash makes background jobs ignore SIGINT and the probe tests nothing.
set -m
"${E[@]}" "$BUN" integration/cli.ts swarm "$I/work/t.json" >/dev/null 2>&1 & C=$!
set +m
sleep 5; kill -INT "$C"; wait "$C" 2>/dev/null
count() { python3 - "$I" <<'PY'
import os,sys
t=sys.argv[1]; me={os.getpid(),os.getppid()}; n=0
for p in os.listdir('/proc'):
    if p.isdigit() and int(p) not in me:
        try: c=open(f'/proc/{p}/cmdline','rb').read().replace(b'\0',b' ').decode()
        except Exception: continue
        if t in c and 'python3 -' not in c: n+=1
print(n)
PY
}
sleep 8; s=$(count); sleep 22; starts=$(grep -vc -- '--version' "$I/inv.log" 2>/dev/null || echo 0)
python3 - "$I" <<'PY'
import os,signal,sys
t=sys.argv[1]; me={os.getpid(),os.getppid()}
for p in os.listdir('/proc'):
    if p.isdigit() and int(p) not in me:
        try: c=open(f'/proc/{p}/cmdline','rb').read().replace(b'\0',b' ').decode()
        except Exception: continue
        if t in c and 'python3 -' not in c:
            try: os.kill(int(p), signal.SIGTERM)
            except ProcessLookupError: pass
PY
rm -rf "$I"
[[ "$s" -eq 0 && "$starts" -le 1 ]] && { echo "survivors=$s starts=$starts result=PASS"; exit 0; } || { echo "survivors=$s starts=$starts result=FAIL"; exit 1; }
