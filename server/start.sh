#!/bin/sh
# Whatever Render's dashboard Build/Start Command actually is (they don't
# necessarily match render.yaml -- confirmed in practice: the Build Command
# doesn't always run at all, leaving node_modules missing entirely, on top of
# dist/ being stripped from the build artifact since it's gitignored), this
# script makes startup self-healing as long as it's reached at all: install
# dependencies if missing, then rebuild from source if dist/index.js isn't
# there, before starting -- instead of depending on Render's dashboard
# settings being correctly configured.
set -e
if [ ! -d ../node_modules/pg ] || [ ! -f dist/index.js ]; then
  echo "[start] Dépendances ou build manquants -- installation et reconstruction (server + web) avant démarrage..."
  (cd .. && npm install && npm run build)
fi
exec node dist/index.js
