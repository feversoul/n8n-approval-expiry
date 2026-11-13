#!/bin/sh
# test/stack.sh up|down|logs|restart|stop|start [postgres]   the test stack by hand
cd "$(dirname "$0")/.."
action=$1
files="-f docker-compose.yml -f test/docker-compose.yml"
[ "${2:-}" = postgres ] && files="$files -f test/docker-compose.postgres.yml"
case "$action" in
  up) docker compose --env-file test/test.env $files -p approval-test up -d ;;
  down) docker compose --env-file test/test.env $files -p approval-test down -v ;;
  restart) docker compose --env-file test/test.env $files -p approval-test restart n8n ;;
  stop) docker compose --env-file test/test.env $files -p approval-test stop n8n ;;
  start) docker compose --env-file test/test.env $files -p approval-test start n8n ;;
  logs) docker compose --env-file test/test.env $files -p approval-test logs --tail "${TAIL:-40}" n8n ;;
esac
