#!/usr/bin/env bash
#
# Runs the whole suite on Linux, in a container, the way the Linux job of ci.yml runs it: Node 22,
# `npm ci` on a clean copy (no node_modules, dist, build or .git), and a user that is not root,
# since root ignores file permissions and some tests depend on them. A test that passes on macOS
# can still fail on Linux, where every lock is a listening socket instead of a `flock`.
#
#   npm run test:linux                  the working tree, uncommitted changes included
#   npm run test:linux -- --ref <rev>   one commit, as git has it (what a push sends)
#
# Needs Docker. Exits 2 when Docker cannot be reached, else with the status of `npm test`.
# ALLABOARD_LINUX_IMAGE picks another image (default `node:22`).

set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
image="${ALLABOARD_LINUX_IMAGE:-node:22}"
ref=""
if [ "${1:-}" = "--ref" ]; then
  ref="${2:?--ref needs a revision}"
fi

if ! docker info >/dev/null 2>&1; then
  echo "test:linux: Docker cannot be reached; start it and run this again." >&2
  exit 2
fi

source_tar() {
  if [ -n "$ref" ]; then
    git -C "$root" archive --format=tar "$ref"
  else
    # macOS's tar stores extended attributes as `._<name>` files, which Linux would extract as
    # files of their own (`._x.test.ts` among the tests); COPYFILE_DISABLE leaves them out.
    COPYFILE_DISABLE=1 tar -C "$root" --exclude=./node_modules --exclude=./dist \
      --exclude=./build --exclude=./.git -cf - .
  fi
}

# The suite's own limit per file is 300 seconds; the whole run gets 20 minutes.
source_tar | docker run --rm -i --user node "$image" bash -c '
  set -e
  work="$HOME/work"
  mkdir "$work"
  tar -xf - -C "$work"
  cd "$work"
  node --version
  npm ci --no-audit --no-fund >/dev/null
  timeout 1200 npm test
'
