#!/usr/bin/env bash
set -Eeuo pipefail

TMUX_SOCKET=/reaper/tmux.sock
TMUX_CONFIG=/reaper/tmux.conf
SESSIONS_MANIFEST=/work/.reaper/sessions.json

mkdir -p /reaper/logs /work/.reaper/shell-state /work/.reaper/logs
tmux -S "$TMUX_SOCKET" -f "$TMUX_CONFIG" start-server

if [[ -f "$SESSIONS_MANIFEST" ]]; then
  if ! jq -e 'type == "array" and all(.[]; type == "object" and (.name | type == "string"))' \
      "$SESSIONS_MANIFEST" >/dev/null; then
    printf 'reaper pod: invalid session manifest: %s\n' "$SESSIONS_MANIFEST" >&2
    exit 1
  fi
  mapfile -t session_names < <(jq -r '.[].name' "$SESSIONS_MANIFEST")
else
  session_names=()
fi

for name in "${session_names[@]}"; do
  if [[ ! "$name" =~ ^[a-z0-9-]{1,32}$ ]]; then
    printf 'reaper pod: refusing invalid tmux session name: %q\n' "$name" >&2
    exit 1
  fi

  state_dir="/work/.reaper/shell-state/$name"
  rcfile="$state_dir/rcfile"
  mkdir -p "$state_dir"

  if ! tmux -S "$TMUX_SOCKET" has-session -t "=$name" 2>/dev/null; then
    tmux -S "$TMUX_SOCKET" new-session -d -s "$name" -c /work \
      "/usr/local/bin/reaper-session $rcfile $name"
  fi

  tmux -S "$TMUX_SOCKET" pipe-pane -t "=$name:" \
    "cat >> /reaper/logs/$name.log"
done

exec sleep infinity
