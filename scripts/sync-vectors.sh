#!/bin/sh
# Copy grains-v1.json, crypto-v1.json (addresses), relay-v1.json (relay records), access-v1.json (sponsors),
# grain-chats-v1.json (chats and the file reference), handles-v1.json (usernames bound to apps), connect-v1.json (Saltix
# Connect's offers, grants and logs, for @saltix/connect) and connect-profiles-v1.json (Connect profiles) from a Saltix
# checkout and record its commit.
set -eu
src=${1:?usage: scripts/sync-vectors.sh <path to a Saltix checkout>}
here=$(cd "$(dirname "$0")/.." && pwd)
for f in grains-v1.json crypto-v1.json relay-v1.json access-v1.json grain-chats-v1.json handles-v1.json connect-v1.json connect-profiles-v1.json; do
  cp "$src/vectors/$f" "$here/vectors/"
done
printf 'corvise/saltix %s\n' "$(git -C "$src" rev-parse HEAD)" > "$here/vectors/SOURCE"
echo "vectors synced"
