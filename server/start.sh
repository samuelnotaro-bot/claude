#!/bin/sh
# Render's free-tier deploy artifact upload strips any path matching .gitignore
# (including dist/, which is correctly gitignored generated output) between the
# build phase and the running container. Whatever Render's dashboard Start
# Command actually is, as long as it resolves to "npm run start --workspace=server"
# (which it does even for older/cached dashboard settings), this script makes
# startup self-healing: it rebuilds from source if dist/index.js isn't there,
# instead of depending on Render's Build Command / dashboard settings being
# correctly configured.
set -e
if [ ! -f dist/index.js ]; then
  echo "[start] dist/index.js manquant -- reconstruction (server + web) avant démarrage..."
  (cd .. && npm run build)
fi
exec node dist/index.js
