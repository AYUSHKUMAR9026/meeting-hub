#!/bin/sh
# Usage: server-entrypoint api|worker|migrate  (anything else is exec'd as-is)
set -e
export SERVER_ROLE="$1"
case "$1" in
  api)     exec node --enable-source-maps dist/api.js ;;
  worker)  exec node --enable-source-maps dist/worker.js ;;
  migrate) exec node --enable-source-maps dist/migrate.js ;;
  *)       exec "$@" ;;
esac
