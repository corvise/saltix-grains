#!/bin/sh
# In the public mirror of this SDK (corvise/saltix-grains): copy the golden vectors its tests read from a checkout of
# corvise/saltix into vectors/, and record that checkout's commit and each file's git blob id in vectors/SOURCE. CI holds
# the copies to those ids byte for byte (scripts/check-vectors.mjs), so a vector edited here by hand fails. The files are
# the ones the tests name (`vectors/<name>.json` in packages/*/test and scripts/); a copy no test names any more goes.
#
#   scripts/sync-vectors.sh <path to a checkout of corvise/saltix>
#
# In corvise/saltix itself the tests read ../../../vectors/, the repository's own: nothing to sync there.
set -eu
src=${1:?usage: scripts/sync-vectors.sh <path to a checkout of corvise/saltix>}
here=$(cd "$(dirname "$0")/.." && pwd)
if [ ! -d "$src/vectors" ] || ! git -C "$src" rev-parse --git-dir >/dev/null 2>&1; then
  echo "sync-vectors: $src is not a checkout of corvise/saltix (no vectors/, or no git)" >&2
  exit 1
fi
# The ids come from the commit, so its vectors must be the commit's own.
if [ -n "$(git -C "$src" status --porcelain -- vectors)" ]; then
  echo "sync-vectors: the checkout's vectors/ has changes not committed: commit them, or sync from a clean checkout" >&2
  exit 1
fi
files=$(grep -rhoE 'vectors/[a-z0-9-]+\.json' "$here"/packages/*/test "$here"/scripts 2>/dev/null | sed 's#^vectors/##' | sort -u)
if [ -z "$files" ]; then
  echo "sync-vectors: no test names a vector (vectors/<name>.json): nothing to sync" >&2
  exit 1
fi
commit=$(git -C "$src" rev-parse HEAD)
mkdir -p "$here/vectors"
for old in "$here"/vectors/*.json; do
  [ -f "$old" ] || continue
  name=$(basename "$old")
  if ! printf '%s\n' "$files" | grep -qx "$name"; then
    rm -f "$old"
    echo "sync-vectors: $name removed: no test reads it"
  fi
done
{
  printf 'corvise/saltix %s\n' "$commit"
  for f in $files; do
    if [ ! -f "$src/vectors/$f" ]; then
      echo "sync-vectors: $src/vectors/$f: a test names it and the checkout has no such vector" >&2
      exit 1
    fi
    cp "$src/vectors/$f" "$here/vectors/$f"
    printf '%s %s\n' "$f" "$(git -C "$src" rev-parse "$commit:vectors/$f")"
  done
} > "$here/vectors/SOURCE"
echo "sync-vectors: $(printf '%s\n' "$files" | wc -l | tr -d ' ') vectors from corvise/saltix $(printf %.12s "$commit") in vectors/SOURCE"
