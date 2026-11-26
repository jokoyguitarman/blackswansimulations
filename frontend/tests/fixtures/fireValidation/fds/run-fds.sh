#!/bin/bash
# Run one comparison case with the local FDS 6 install.
# Outputs stay in the given directory. Nothing here belongs in git.
set -euo pipefail
case="${1:-}"
out="${2:-/tmp/fds-compare}"
if [[ "$case" != "two-room" && "$case" != "harbour" ]]; then
  echo "usage: run-fds.sh <two-room|harbour> [outDir]" >&2
  exit 2
fi
if [[ -f "$HOME/FDS/FDS6/bin/FDS6VARS.sh" ]]; then
  # shellcheck disable=SC1090
  source "$HOME/FDS/FDS6/bin/FDS6VARS.sh"
fi
if ! command -v fds >/dev/null 2>&1; then
  echo "fds is not on PATH. Install FDS 6 and source FDS6VARS.sh." >&2
  exit 1
fi
here="$(cd "$(dirname "$0")" && pwd)"
input="$here/two-room.fds"
chid="two_room"
if [[ "$case" == "harbour" ]]; then
  input="$here/harbour-shop-mall.fds"
  chid="harbour"
fi
mkdir -p "$out/$case"
cp "$input" "$out/$case/$chid.fds"
cd "$out/$case"
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-4}"
echo "FDS $(fds 2>&1 | head -n 1)  threads=$OMP_NUM_THREADS  input=$chid.fds"
fds "$chid.fds"
