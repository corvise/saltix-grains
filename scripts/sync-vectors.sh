#!/bin/sh
# Copy grains-v1.json, crypto-v1.json (addresses), relay-v1.json (relay records), access-v1.json (sponsors),
# grain-chats-v1.json (chats and the file reference), handles-v1.json (usernames bound to apps), connect-v1.json (Saltix
# Connect's offers, grants and logs, for @saltix/connect), connect-profiles-v1.json (Connect profiles),
# server-pairing-v1.json (pairing a server by QR code, grain pair), images-v1.json (named blobs: the image and bundle
# checks, a bundle's upload into the network, for grain publish and grain icon), accounts-v1.json (managed accounts'
# key event logs, and the quorums of protocol version 2, for the offline log check) and gate-v1.json (a test network's
# access grants and tokens, 37-gate: grain pair on a gated network) from a Saltix checkout, and record its commit and
# each file's git blob id there in vectors/SOURCE. CI holds the copies to those ids byte for byte
# (scripts/check-vectors.mjs), so a vector edited here by hand fails.
#
#   scripts/sync-vectors.sh <checkout>            every file, from the checkout's commit (SOURCE's first line)
#   scripts/sync-vectors.sh <checkout> <file>…    only those files: each line names the checkout's commit as a third
#                                                 word, the others stay as SOURCE has them (a format the SDK takes up
#                                                 before the rest of the protocol's changes since)
set -eu
src=${1:?usage: scripts/sync-vectors.sh <path to a Saltix checkout> [file…]}
shift
here=$(cd "$(dirname "$0")/.." && pwd)
files="grains-v1.json crypto-v1.json relay-v1.json access-v1.json grain-chats-v1.json handles-v1.json connect-v1.json connect-profiles-v1.json server-pairing-v1.json images-v1.json accounts-v1.json gate-v1.json"
# The ids come from the commit, so its vectors must be the commit's own.
if [ -n "$(git -C "$src" status --porcelain -- vectors)" ]; then
  echo "the checkout's vectors/ has changes not committed: commit them, or sync from a clean checkout" >&2
  exit 1
fi
commit=$(git -C "$src" rev-parse HEAD)
if [ $# -eq 0 ]; then
  {
    printf 'corvise/saltix %s\n' "$commit"
    for f in $files; do
      cp "$src/vectors/$f" "$here/vectors/"
      printf '%s %s\n' "$f" "$(git -C "$src" rev-parse "$commit:vectors/$f")"
    done
  } > "$here/vectors/SOURCE"
  echo "vectors synced from $commit"
  exit 0
fi
for f in "$@"; do
  case " $files " in
    *" $f "*) ;;
    *) echo "$f: not a file the SDK copies ($files)" >&2; exit 1 ;;
  esac
done
head=$(sed -n '1s/^corvise\/saltix \([0-9a-f]\{40\}\)$/\1/p' "$here/vectors/SOURCE")
if [ -z "$head" ]; then
  echo "vectors/SOURCE: its first line is not corvise/saltix <commit>: sync every file first" >&2
  exit 1
fi
tmp=$(mktemp "$here/vectors/.SOURCE.XXXXXX")
trap 'rm -f "$tmp"' EXIT
{
  printf 'corvise/saltix %s\n' "$head"
  for f in $files; do
    synced=no
    for g in "$@"; do [ "$g" = "$f" ] && synced=yes; done
    if [ "$synced" = yes ]; then
      cp "$src/vectors/$f" "$here/vectors/"
      id=$(git -C "$src" rev-parse "$commit:vectors/$f")
      if [ "$commit" = "$head" ]; then printf '%s %s\n' "$f" "$id"; else printf '%s %s %s\n' "$f" "$id" "$commit"; fi
    else
      line=$(grep "^$f " "$here/vectors/SOURCE" || true)
      if [ -z "$line" ]; then
        echo "$f: not in vectors/SOURCE yet: name it too, or sync every file" >&2
        exit 1
      fi
      printf '%s\n' "$line"
    fi
  done
} > "$tmp"
mv "$tmp" "$here/vectors/SOURCE"
trap - EXIT
echo "vectors synced: $* from $commit; the rest as SOURCE had them"
