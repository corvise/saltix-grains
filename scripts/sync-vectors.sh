#!/bin/sh
# Copy grains-v1.json, crypto-v1.json (addresses), relay-v1.json (relay records) and access-v1.json (sponsors) from a
# Salarium checkout and record its commit.
set -eu
src=${1:?usage: scripts/sync-vectors.sh <path to a Salarium checkout>}
here=$(cd "$(dirname "$0")/.." && pwd)
for f in grains-v1.json crypto-v1.json relay-v1.json access-v1.json; do cp "$src/vectors/$f" "$here/vectors/"; done
printf 'corvise/salarium %s\n' "$(git -C "$src" rev-parse HEAD)" > "$here/vectors/SOURCE"
echo "vectors synced"
