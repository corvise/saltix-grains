#!/bin/bash
# A CI job's temporary files go to a directory of the job's own, and the job fails if its steps leave anything there
# (docs/agents/sdk.md, Rules of the repository). A test that leaves a project or a key file behind fills a developer's
# temporary directory run after run, and a self-hosted runner's, whose /tmp every job shares: what the tests make they
# remove, a failure included (scripts/scratch.mjs). $RUNNER_TEMP is the runner's own, emptied as each job begins and ends.
#
#   scripts/ci-tmp.sh start   # make $RUNNER_TEMP/tmp and point the job's later steps' TMPDIR at it
#   scripts/ci-tmp.sh check   # fail, naming what is there, unless the steps since `start` left it empty
#
# Everything that follows TMPDIR lands there: Node's os.tmpdir(), mktemp. `check` runs after passing steps only, and
# whatever a failed job leaves the runner removes with $RUNNER_TEMP. A cache meant to outlive its process is no
# leftover and goes beside the directory: TypeScript's tsc turns on Node's module compile cache, which
# NODE_COMPILE_CACHE places. setup-node's environment report runs `yarn --version`, whose bundled v8-compile-cache
# keeps a cache in os.tmpdir() and takes no other place, only DISABLE_V8_COMPILE_CACHE: yarn runs without it.
set -euo pipefail
dir="${RUNNER_TEMP:?ci-tmp: no RUNNER_TEMP: this runs in a GitHub Actions job}/tmp"
case "${1:-}" in
start)
    rm -rf "$dir"
    mkdir -p "$dir"
    {
        echo "TMPDIR=$dir"
        echo "NODE_COMPILE_CACHE=$RUNNER_TEMP/node-compile-cache"
        echo "DISABLE_V8_COMPILE_CACHE=1"
    } >>"${GITHUB_ENV:?ci-tmp: no GITHUB_ENV}"
    echo "ci-tmp: the job's temporary directory is $dir"
    ;;
check)
    [ -d "$dir" ] || { echo "::error::ci-tmp: no $dir: the job never ran 'scripts/ci-tmp.sh start'" >&2; exit 2; }
    left=$(ls -A "$dir")
    if [ -z "$left" ]; then
        echo "ci-tmp: the job's steps left nothing in its temporary directory"
        exit 0
    fi
    count=$(($(wc -l <<<"$left")))
    echo "::error::ci-tmp: the job's steps left $count entries in its temporary directory; whatever makes them must remove them, on failure too"
    # The first 20, each directory with a few names inside: enough to tell which test or tool made them.
    head -n 20 <<<"$left" | while IFS= read -r entry; do
        ls -ld "$dir/$entry"
        if [ -d "$dir/$entry" ]; then find "$dir/$entry" -mindepth 1 -maxdepth 2 | head -n 5 | sed 's/^/    /'; fi
    done
    if [ "$count" -gt 20 ]; then echo "... and $((count - 20)) more"; fi
    exit 1
    ;;
*)
    echo "usage: scripts/ci-tmp.sh start|check" >&2
    exit 2
    ;;
esac
