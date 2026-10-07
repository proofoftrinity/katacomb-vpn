#!/usr/bin/env bash
# Run each Go fuzz target for FUZZTIME (default 10s). CI runs it as a smoke test; run
# it longer by hand after touching a parser the daemon exposes:
#   FUZZTIME=5m npm run test:fuzz
# A crasher is written to the package's testdata/fuzz/<Target>/ - commit it: it then
# runs with every `go test` as a regression seed.
set -euo pipefail
cd "$(dirname "$0")/../daemon"
FUZZTIME="${FUZZTIME:-10s}"
for target in "FuzzParseRequest ./internal/protocol/" \
              "FuzzAssertWireguardConfig ./internal/guard/" \
              "FuzzToUAPI ./internal/amneziawg/"; do
  read -r name pkg <<<"$target"
  echo "== $name ($FUZZTIME)"
  go test -run='^$' -fuzz="^${name}\$" -fuzztime="$FUZZTIME" "$pkg"
done
