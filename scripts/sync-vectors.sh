#!/bin/sh
# Copy grains-v1.json, crypto-v1.json (addresses), relay-v1.json (relay records), access-v1.json (sponsors),
# grain-chats-v1.json (chats and the file reference), handles-v1.json (usernames bound to apps), connect-v1.json (Saltix
# Connect's offers, grants and logs, for @saltix/connect), connect-profiles-v1.json (Connect profiles),
# server-pairing-v1.json (pairing a server by QR code, grain pair) and images-v1.json (named blobs: the image and bundle
# checks, a bundle's upload into the network, for grain publish and grain icon) and accounts-v1.json (managed accounts'
# key event logs, and the quorums of protocol version 2, for the offline log check) from a Saltix checkout, and record its
# commit and each file's git blob id there in vectors/SOURCE. CI holds the copies to those ids byte for byte
# (scripts/check-vectors.mjs), so a vector edited here by hand fails.
set -eu
src=${1:?usage: scripts/sync-vectors.sh <path to a Saltix checkout>}
here=$(cd "$(dirname "$0")/.." && pwd)
files="grains-v1.json crypto-v1.json relay-v1.json access-v1.json grain-chats-v1.json handles-v1.json connect-v1.json connect-profiles-v1.json server-pairing-v1.json images-v1.json accounts-v1.json"
# The ids come from the commit, so its vectors must be the commit's own.
if [ -n "$(git -C "$src" status --porcelain -- vectors)" ]; then
  echo "the checkout's vectors/ has changes not committed: commit them, or sync from a clean checkout" >&2
  exit 1
fi
commit=$(git -C "$src" rev-parse HEAD)
{
  printf 'corvise/saltix %s\n' "$commit"
  for f in $files; do
    cp "$src/vectors/$f" "$here/vectors/"
    printf '%s %s\n' "$f" "$(git -C "$src" rev-parse "$commit:vectors/$f")"
  done
} > "$here/vectors/SOURCE"
echo "vectors synced from $commit"
