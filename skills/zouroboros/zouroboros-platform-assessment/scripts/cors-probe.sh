#!/usr/bin/env bash
# Cross-origin exposure probe for loopback services. Sends GET and OPTIONS only — never writes.
# FAIL if a service reflects a foreign Origin, or if a preflight allows DELETE/PUT/POST from it.
# Usage: cors-probe.sh <evidence-dir> [url ...]   (defaults: Qdrant, CBM UI, Hermes serve)
set -uo pipefail
A="${1:?evidence dir}"; shift; mkdir -p "$A"
EVIL='https://evil.example'
if [[ $# -eq 0 ]]; then
  hport=$(ss -ltnp 2>/dev/null | awk '/"(hermes|python3)"/ && /127\.0\.0\.1:/{split($4,a,":"); print a[2]; exit}')
  set -- http://127.0.0.1:6333/collections http://127.0.0.1:9749/ ${hport:+http://127.0.0.1:$hport/api/status http://127.0.0.1:$hport/api/sessions}
fi
fail=0
for u in "$@"; do
  h=$(curl -s -m 5 -o /dev/null -D - -H "Origin: $EVIL" "$u" | tr -d '\r')
  code=$(awk 'NR==1{print $2}' <<<"$h"); acao=$(grep -i '^access-control-allow-origin' <<<"$h" | cut -d' ' -f2-)
  p=$(curl -s -m 5 -o /dev/null -D - -X OPTIONS -H "Origin: $EVIL" -H 'Access-Control-Request-Method: DELETE' -H 'Access-Control-Request-Headers: content-type' "$u" | tr -d '\r')
  pm=$(grep -i '^access-control-allow-methods' <<<"$p" | cut -d' ' -f2-); po=$(grep -i '^access-control-allow-origin' <<<"$p" | cut -d' ' -f2-)
  verdict=PASS
  [[ "$acao" == "$EVIL" || "$acao" == "*" ]] && verdict=FAIL
  [[ ( "$po" == "$EVIL" || "$po" == "*" ) && "$pm" =~ DELETE|PUT|POST ]] && verdict=FAIL
  [[ $verdict == FAIL ]] && fail=1
  printf '%s GET=%s ACAO=[%s] preflight_origin=[%s] preflight_methods=[%s] %s\n' "$u" "${code:-none}" "${acao:-none}" "${po:-none}" "${pm:-none}" "$verdict"
done | tee "$A/G-cors.txt"
grep -q ' FAIL$' "$A/G-cors.txt" && exit 1 || exit 0
