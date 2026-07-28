#!/bin/sh
# Whatever Render's dashboard Build/Start Command actually is (they don't
# necessarily match render.yaml -- confirmed in practice: the Build Command
# doesn't always run at all, leaving node_modules missing entirely, on top of
# dist/ being stripped from the build artifact since it's gitignored), this
# script makes startup self-healing as long as it's reached at all: install
# dependencies if missing, then rebuild from source if dist/index.js or the
# web build isn't there, before starting -- instead of depending on Render's
# dashboard settings being correctly configured.
#
# IMPORTANT: this check must stay cheap and skip the rebuild whenever the
# previous build is already on disk. On Render's free plan the service spins
# down after inactivity and respins on the next request -- that respin reuses
# the same container filesystem and re-runs this script, it does not wipe
# node_modules/dist. If this script rebuilt unconditionally (as render.yaml's
# startCommand used to, directly), every wake from sleep would pay for a full
# `npm install && npm run build` (a minute-plus of dead time) instead of just
# starting the already-built server in a couple of seconds.
set -e
if [ ! -d ../node_modules/pg ] || [ ! -f dist/index.js ] || [ ! -f ../web/dist/index.html ]; then
  echo "[start] Dépendances ou build manquants -- installation et reconstruction (server + web) avant démarrage..."
  (cd .. && npm install && npm run build)
else
  echo "[start] Build existant détecté, démarrage direct (pas de réinstallation)."
fi
exec node dist/index.js
