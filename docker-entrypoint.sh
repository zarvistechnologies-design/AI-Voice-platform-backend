#!/bin/sh
set -eu

node dist/server.js &
server_pid=$!

node dist/agent.js start &
agent_pid=$!

shutdown() {
  kill -TERM "$server_pid" "$agent_pid" 2>/dev/null || true
  wait "$server_pid" "$agent_pid" 2>/dev/null || true
}

trap 'shutdown; exit 0' INT TERM

while kill -0 "$server_pid" 2>/dev/null && kill -0 "$agent_pid" 2>/dev/null; do
  sleep 1
done

shutdown
exit 1
