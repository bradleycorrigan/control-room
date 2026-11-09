#!/bin/sh
# Stand-in for `claude -p` in the gate (CR_TICKET_DRAFT_BIN), so "Create
# ticket" from a session runs its real path without calling Claude. Echoes the
# session title it was sent, to show the prompt carried it, and offers one
# label the board doesn't have, which the app must drop.
prompt=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-p" ]; then prompt="$2"; fi
  shift
done
# Slow enough that the form's waiting state can be checked.
sleep 2
title=$(printf '%s\n' "$prompt" | sed -n 's/^Session title: //p' | head -n 1)
printf '{"type":"result","is_error":false,"structured_output":{"summary":"Drafted: %s","description":"h4. Context\\n* Drafted by the fixture","priority":"High","epicKey":"TEAM-60","labels":["data-ask","not-on-the-board"]}}\n' "$title"
