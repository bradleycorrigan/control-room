#!/bin/sh
# Stand-in for `claude -p` in the gate (CR_HAIKU_BIN), so "Create ticket"
# and "Suggest a name" run their real paths without calling Claude. Echoes the
# session title it was sent, to show the prompt carried it. A ticket draft
# (asked with --json-schema) offers one label the board doesn't have, which
# the app must drop.
prompt=""
schema=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-p" ]; then prompt="$2"; fi
  if [ "$1" = "--json-schema" ]; then schema="$2"; fi
  shift
done
if [ -z "$schema" ]; then
  current=$(printf '%s\n' "$prompt" | sed -n 's/^Current title: //p' | head -n 1)
  sleep 1
  printf '{"type":"result","is_error":false,"result":"\\"Suggested: %s\\""}\n' "$current"
  exit 0
fi
# Slow enough that the form's waiting state can be checked.
sleep 2
title=$(printf '%s\n' "$prompt" | sed -n 's/^Session title: //p' | head -n 1)
printf '{"type":"result","is_error":false,"structured_output":{"summary":"Drafted: %s","description":"h4. Context\\n* Drafted by the fixture","priority":"High","epicKey":"TEAM-60","labels":["data-ask","not-on-the-board"]}}\n' "$title"
